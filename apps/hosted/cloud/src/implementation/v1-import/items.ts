/**
 * One v1 item becomes v2 resources: an integration an app shared with everyone, an org connection
 * a shared account linked to its app for everyone and a member's connection their personal account
 * linked for them (decision 9), a policy per-tool approvals inside its integration's app, a toolkit
 * a scoped MCP connection for each member it reaches (decision 11), an artifact an app's source
 * without a version. Each returns the resource it created, or why the item cannot be imported; a
 * defect or storage failure fails the step instead and the item is retried.
 */
import {
  graphqlAppSource,
  generateMcpSource,
  openapiAppSource,
  packageFile,
  type CredentialPlacement,
  type GeneratedAuthMethod,
  type GeneratedHealthCheck,
  type GeneratedToolRules,
} from "@executor-js/app-templates";
import {
  CurrentUserId,
  linkAppAccount,
  linkUserAccount,
  organizationOwner,
  type McpConnectionStore,
  type OrganizationId,
} from "@executor-js/hosted-server";
import {
  ConnectionId,
  type ConnectionApp,
  type ConnectionPolicy,
} from "@executor-js/mcp-auth/connections";
import {
  accountDestination,
  personalAccountCreation,
  sharedAppCreation,
} from "@executor-js/hosted-server/resource-lifecycle";
import {
  AccountId,
  AppId,
  OAuthGrantImport,
  OAuthRegistration,
  scopeGeneratedPackage,
  SourceFiles,
  StorageHost,
  ToolName,
  type AccountRequirement,
  type DeployedApp,
  type Executor,
  type ImportOAuthGrant,
  type OAuthGrantNotImportable,
  type OwnerId,
  type OAuthSetupFailed,
} from "@executor-js/sdk/core";
import { OpenapiCompileError, openapiOperationNames } from "apps/openapi";
import { Effect, Option, Redacted, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { V1StaleCategory } from "../../contracts/v1-import-run.ts";
import { V1ImportUnavailable } from "../../contracts/v1-import.ts";
import {
  credentialLike,
  itemOwner,
  mcpToolName,
  resolvePolicy,
  secretPrefix,
  tokenEndpointAuthMethod,
  toolkitAction,
  type ArtifactBinding,
  type ArtifactRow,
  type ConnectionRow,
  type IntegrationRow,
  type OpenApiOperationRow,
  type PolicyAction,
  type ToolRow,
  type V1Toolkit,
} from "./formats.ts";
import { openapiHealth, v1IntrospectionQuery } from "./health.ts";
import {
  credentialOrigins,
  importedDocument,
  operationBaseUrls,
  parseSpec,
  plainHttpHosts,
  withoutOperations,
} from "./openapi.ts";
import {
  artifactPlan,
  artifactRepairNote,
  connectionPlan,
  decodedToolkits,
  firstPartyName,
  type FirstPartyClients,
  grantsNoConnection,
  integrationLabel,
  integrationPlan,
  integrationValues,
  replaces,
  type ConfigSecret,
  type ConnectionPlan,
  toolkitConnections,
  type ImportableIntegration,
  type Unsupported,
} from "./plan.ts";
import type { V1Snapshot, V1Source } from "./source.ts";
import { sourceHash, toolkitCopyId, type ImportStore, type MapResult } from "./store.ts";
import { v1ToolPaths } from "./v1-tool-paths.ts";

/** v1's OAuth callback; imported clients keep it, and v1's edge forwards it to v2. */
export const v1OAuthCallback = "https://executor.sh/api/oauth/callback";

export interface ItemContext {
  readonly executor: Executor;
  /** Members' scoped MCP connections, which toolkits become. */
  readonly connections: McpConnectionStore;
  readonly store: ImportStore;
  /** The product database, on the connection the executor writes with. */
  readonly sql: SqlClient.SqlClient;
  readonly source: V1Source;
  readonly snapshot: V1Snapshot;
  readonly target: { readonly id: OrganizationId; readonly slug: string };
  /** The v2 owner, who creates the organization's apps and shared accounts. */
  readonly owner: string;
  /** Each imported member's v2 user, by WorkOS user id. */
  readonly users: ReadonlyMap<string, string>;
  /** The operator's OAuth clients v1's first-party connections move to. */
  readonly firstParty: FirstPartyClients;
}

/** The v1 rows a connection's account is decided from. */
export type ConnectionSnapshot = Pick<
  V1Snapshot,
  "tenant" | "subjects" | "integrations" | "connections" | "clients"
>;

/** The v1 rows an item reads are org rows or one member's own (`subject`). */
type Owned = { readonly owner: "org" | "user"; readonly subject: string };

/**
 * The v2 user an org row or a member's row acts as: the owner for the organization's, the member
 * for theirs. A row of anyone else is never read (`readSnapshot`), so it has none.
 */
export const actorOf = (context: Pick<ItemContext, "owner" | "users">, row: Owned) =>
  row.owner === "org" ? context.owner : context.users.get(row.subject);

/** Org rows, and the rows of one member when given. */
export const visibleTo = (member: string | undefined) => (row: Owned) =>
  row.owner === "org" || (member !== undefined && row.subject === member);

/**
 * An item that cannot be imported, with a reason the user sees. `vault` marks a secret v1's Vault
 * did not return: missing, or unavailable after retries. With `stale`, v1 cannot run it either:
 * it is skipped and reported, and does not block its organization (decision 20). Without, it
 * blocks the organization.
 */
export class ItemFailed extends Schema.TaggedError<ItemFailed>()("ItemFailed", {
  reason: Schema.String,
  vault: Schema.optional(Schema.Literals(["missing", "unavailable"])),
  stale: Schema.optional(V1StaleCategory),
}) {}
const fail = (reason: string) => Effect.fail(new ItemFailed({ reason }));
const failStale = (stale: V1StaleCategory, reason: string) =>
  Effect.fail(new ItemFailed({ reason, stale }));
/** Fail with a plan's refusal, keeping whether it is stale. */
export const refused = (plan: Unsupported) =>
  Effect.fail(
    new ItemFailed({ reason: plan.reason, ...(plan.stale === null ? {} : { stale: plan.stale }) }),
  );

const imported = (v2Kind: string, v2Id: string, note?: string): MapResult => ({
  status: "imported",
  v2Kind,
  v2Id,
  ...(note === undefined ? {} : { note }),
});

// ---------------------------------------------------------------------------------------------
// Sign-in methods. One integration's app declares every method its connections use.

const methodKey = (method: GeneratedAuthMethod) => JSON.stringify(method);

/** A sign-in method and the values its account takes from v1's configuration, by field. */
interface PlannedMethod {
  readonly method: GeneratedAuthMethod;
  readonly configured: ReadonlyArray<readonly [string, string]>;
}

/**
 * Where an account sends the fixed credentials its method does not replace. v1 sent the fixed
 * values first and the connection's credentials over them, so a placement of the same name wins.
 */
const fixedPlacements = (
  secrets: readonly ConfigSecret[],
  own: readonly { readonly carrier: "header" | "query"; readonly name: string }[],
) => {
  const sent = secrets.filter((secret) => !own.some((placement) => replaces(placement, secret)));
  return {
    placements: sent.map((secret): CredentialPlacement => ({
      carrier: secret.carrier,
      name: secret.name,
      field: secret.field,
    })),
    configured: sent.map((secret) => [secret.field, secret.value] as const),
  };
};

/**
 * The method a connection signs in with, or undefined for one that sends no credentials. An API
 * key's literal values and prefixes that hold a credential become fields like the fixed
 * credentials in `secrets`, which its account also holds.
 */
const plannedMethod = (
  plan: ConnectionPlan,
  secrets: readonly ConfigSecret[],
): PlannedMethod | undefined => {
  const access = plan.access;
  switch (access.kind) {
    case "none":
      return undefined;
    case "secrets": {
      const configured: Array<readonly [string, string]> = [];
      const placements = access.placements.map((placement): CredentialPlacement => {
        const prefixed =
          placement.prefix !== undefined && secretPrefix(placement.prefix)
            ? { prefixField: `${placement.name} prefix` }
            : { prefix: placement.prefix };
        if (prefixed.prefixField !== undefined && placement.prefix !== undefined)
          configured.push([prefixed.prefixField, placement.prefix]);
        if (placement.literal === undefined)
          return {
            carrier: placement.carrier,
            name: placement.name,
            ...prefixed,
            field: placement.variable ?? "token",
          };
        if (!credentialLike(placement.name, placement.literal))
          return {
            carrier: placement.carrier,
            name: placement.name,
            ...prefixed,
            literal: placement.literal,
          };
        const field = `${placement.carrier} ${placement.name}`;
        configured.push([field, placement.literal]);
        return { carrier: placement.carrier, name: placement.name, ...prefixed, field };
      });
      const fixed = fixedPlacements(secrets, access.placements);
      const all = [...configured, ...fixed.configured];
      return {
        method: {
          kind: "secrets",
          label: "API key",
          fields: [
            ...new Set([
              ...access.items.map(([variable]) => variable),
              ...all.map(([field]) => field),
            ]),
          ],
          placements: [...placements, ...fixed.placements],
        },
        configured: all,
      };
    }
    case "oauth": {
      // v1 signed in at the connection's client's endpoints with the method's scopes, or the ones
      // its authorization URL set, so a reconnect does too; connections whose clients differ get a
      // method each. The account's grant renews as v1 did (`renewal`).
      const { method, client } = access;
      const scopes = [...method.scopes];
      const resource =
        client.resource === null || client.resource === "" ? {} : { resource: client.resource };
      const oauth =
        access.grant === "client_credentials"
          ? {
              grant: "client_credentials",
              tokenUrl: client.token_url,
              scopes,
              tokenEndpointAuthMethod: access.authentication,
              ...resource,
            }
          : access.authorization.kind === "discover"
            ? {
                discover: access.authorization.url,
                ...(scopes.length === 0 ? {} : { scopes }),
              }
            : {
                authorizationUrl: access.authorization.authorizationUrl,
                tokenUrl: client.token_url,
                scopes: [...access.authorization.scopes],
                ...resource,
              };
      // The fixed credentials go in the app's fixed account (`appMethods`).
      return {
        method: { kind: "oauth", oauth, header: method.header, prefix: method.prefix },
        configured: [],
      };
    }
    case "first_party": {
      // v1 signed in at its own app's endpoints, which v2's client of the same name has. The
      // method declares them, so v2 signs it in, renews it and reconnects it with that client;
      // an MCP server names them itself. Its scopes are what v1 asked that app for. A client
      // that allows no scopes (the GitHub App's) asks for none, so an MCP method says so: left
      // to discovery, it would ask for the scopes the server advertises (GitHub's MCP server
      // lists `repo`, `gist` and more), and such a client is not offered for those.
      const { method, client, scopes } = access;
      const oauth =
        plan.decoded.plugin === "mcp"
          ? {
              discover: plan.decoded.config.endpoint,
              ...(scopes.length === 0 && (client.allowedScopes ?? client.defaultScopes).length > 0
                ? {}
                : { scopes: [...scopes] }),
            }
          : {
              authorizationUrl: client.server.authorizationUrl,
              tokenUrl: client.server.tokenUrl,
              scopes: [...scopes],
            };
      return {
        method: { kind: "oauth", oauth, header: method.header, prefix: method.prefix },
        configured: [],
      };
    }
  }
};

/**
 * A fixed credential the app leaves out: its value is the client ID or client secret of the OAuth
 * client one of the integration's connections signs in with, which that sign-in already sends
 * (decision 22).
 */
export interface DroppedFixed {
  readonly secret: ConfigSecret;
  readonly reason: "oauth_client_id" | "oauth_client_secret";
}

/**
 * The integration's fixed credentials that repeat one of its OAuth connections' own client ID or
 * client secret, as when a client's credentials were pasted as headers. A client secret is read
 * from v1's Vault as the connection's import reads it, compared in memory and kept nowhere.
 */
export const redundantFixed = (
  context: {
    readonly source: Pick<V1Source, "secret">;
    readonly snapshot: Pick<
      V1Snapshot,
      "tenant" | "subjects" | "integrations" | "connections" | "clients"
    >;
    readonly firstParty: FirstPartyClients;
  },
  integration: IntegrationRow,
) =>
  Effect.gen(function* () {
    const decoded = integrationPlan(integration);
    if (!decoded.ok) return [];
    const { secrets } = integrationValues(decoded.value);
    if (secrets.length === 0) return [];
    const clients: Array<{ readonly id: string; readonly secret: string | undefined }> = [];
    for (const row of context.snapshot.connections) {
      if (row.integration !== integration.slug) continue;
      const plan = connectionPlan(context.snapshot, context.firstParty, row);
      if (!plan.ok) continue;
      const access = plan.value.access;
      if (access.kind === "first_party")
        clients.push({ id: access.client.clientId, secret: undefined });
      else if (access.kind === "oauth") {
        const item = access.client.client_secret_item_id;
        const secret =
          item === null
            ? undefined
            : yield* readSecret(context, row, item).pipe(
                Effect.map((value) => Option.some(Redacted.value(value))),
                Effect.catchTag("ItemFailed", (failed) =>
                  failed.vault === "unavailable"
                    ? Effect.fail(failed)
                    : Effect.succeed(Option.none<string>()),
                ),
                Effect.map(Option.getOrUndefined),
              );
        clients.push({ id: access.client.client_id, secret });
      }
    }
    return secrets.flatMap((secret): DroppedFixed[] => {
      if (clients.some((client) => client.id !== "" && client.id === secret.value))
        return [{ secret, reason: "oauth_client_id" }];
      if (clients.some((client) => client.secret !== undefined && client.secret === secret.value))
        return [{ secret, reason: "oauth_client_secret" }];
      return [];
    });
  });

/** The fields of fixed credentials an app leaves out. */
const droppedFields = (dropped: readonly DroppedFixed[]) =>
  new Set(dropped.map((entry) => entry.secret.field));

/** The fixed account's name in an app's requirements and its sign-in method. */
export const fixedRequirement = "fixed";

/**
 * The app's sign-in methods, which one each importable connection uses, and the values each
 * account takes from v1's configuration. When the app takes accounts at all (another connection
 * signs in, or the integration sends fixed credentials), a connection that sent no credentials of
 * its own gets a method with only the fixed ones: "No credentials" when there are none.
 *
 * An OAuth account holds only its token, so when an OAuth connection's integration sends fixed
 * credentials its sign-in does not replace, the app holds every fixed credential in one more
 * account, linked for everyone (`fixed`, decision 22), and no method holds them. Fixed credentials
 * in `dropped` are left out.
 */
export const appMethods = (
  snapshot: ConnectionSnapshot,
  firstParty: FirstPartyClients,
  integration: IntegrationRow,
  dropped: readonly DroppedFixed[] = [],
) => {
  const methods: Record<string, GeneratedAuthMethod> = {};
  const keys = new Map<string, string>();
  const methodOf = new Map<string, string>();
  const configured = new Map<string, ReadonlyArray<readonly [string, string]>>();
  const plans = snapshot.connections
    .filter((row) => row.integration === integration.slug)
    .flatMap((row) => {
      const plan = connectionPlan(snapshot, firstParty, row);
      return plan.ok ? [plan.value] : [];
    });
  const decoded = integrationPlan(integration);
  const secrets = decoded.ok
    ? integrationValues(decoded.value, droppedFields(dropped)).secrets
    : [];
  const needsFixed = plans.some((plan) => {
    const access = plan.access;
    return (
      (access.kind === "oauth" || access.kind === "first_party") &&
      secrets.some((secret) => !replaces({ carrier: "header", name: access.method.header }, secret))
    );
  });
  const all = fixedPlacements(secrets, []);
  const fixed = needsFixed
    ? {
        account: { fields: all.configured.map(([field]) => field), placements: all.placements },
        configured: all.configured,
      }
    : undefined;
  // With a fixed account, the methods' accounts hold none of the fixed credentials.
  const methodSecrets = fixed === undefined ? secrets : [];
  const add = (plan: ConnectionPlan, planned: PlannedMethod) => {
    configured.set(plan.row.row_id, planned.configured);
    const key = methodKey(planned.method);
    const existing = keys.get(key);
    if (existing !== undefined) {
      methodOf.set(plan.row.row_id, existing);
      return;
    }
    // v1 accepted a connection with an empty template slug; a method needs a name.
    const template = plan.row.template === "" ? plan.access.kind : plan.row.template;
    const base =
      plan.access.kind === "oauth" && plan.access.grant === "client_credentials"
        ? `${template}_client_credentials`
        : template;
    let name = base;
    for (let number = 2; Object.hasOwn(methods, name); number++) name = `${base}_${number}`;
    methods[name] = planned.method;
    keys.set(key, name);
    methodOf.set(plan.row.row_id, name);
  };
  for (const plan of plans) {
    const planned = plannedMethod(plan, methodSecrets);
    if (planned !== undefined) add(plan, planned);
  }
  if (Object.keys(methods).length > 0 || methodSecrets.length > 0) {
    const none = fixedPlacements(methodSecrets, []);
    const method: GeneratedAuthMethod = {
      kind: "secrets",
      label: methodSecrets.length === 0 ? "No credentials" : "Fixed credentials",
      fields: none.configured.map(([field]) => field),
      placements: none.placements,
    };
    for (const plan of plans)
      if (plan.access.kind === "none") add(plan, { method, configured: none.configured });
    // Fixed credentials without a connection still make the app take an account that holds them.
    if (Object.keys(methods).length === 0) methods.none = method;
  }
  // Org connections become accounts linked for everyone, so the app also takes those (decision 9).
  const shared = plans.some((plan) => plan.row.owner === "org" && methodOf.has(plan.row.row_id));
  return { methods, methodOf, configured, plans, shared, fixed, dropped };
};

/** What an integration's app takes, as `appMethods` plans it. */
export type AppAccounts = ReturnType<typeof appMethods>;

// ---------------------------------------------------------------------------------------------
// Tool names and approvals.

const rank = { approve: 1, default: 1.5, require_approval: 2, block: 3 } as const;
/**
 * Each tool's v1 policy result, combined across its connections and the v1 names it had: the most
 * restrictive, where a connection without a matching policy keeps the tool's own default.
 * `aliases` maps a dropped v1 name to the name the tool keeps.
 *
 * A toolkit's own policies applied only to calls through the toolkit, and v1 ignored the
 * workspace's policies there, but v2 keeps approvals in the app for every caller. A toolkit that
 * asks before a tool it grants therefore makes the app ask. One that grants it without a rule of its
 * own left it to the tool's default, so the workspace's `approve` cannot lower it below that
 * default either. The toolkit's `approve` never lowers the workspace's result, and its `block` only
 * leaves the tool out of the toolkit's connection.
 */
export const toolActions = (
  snapshot: V1Snapshot,
  integration: IntegrationRow,
  tools: readonly ToolRow[],
  aliases: Readonly<Record<string, string>> = {},
) => {
  const actions = new Map<string, PolicyAction | "default">();
  const toolkits = decodedToolkits(snapshot);
  for (const tool of tools) {
    const id = `${integration.slug}.${tool.owner}.${tool.connection}.${tool.name}`;
    const own = resolvePolicy(id, snapshot.policies, snapshot.multiMember) ?? "default";
    // The least the app may do for each toolkit that grants the tool: ask when the toolkit asks,
    // keep the tool's default when the toolkit left it to the default.
    const action = toolkits.reduce<PolicyAction | "default">((current, toolkit) => {
      const granted = toolkitAction(toolkit, id);
      const floor = granted === "require_approval" || granted === "default" ? granted : undefined;
      return floor !== undefined && rank[floor] > rank[current] ? floor : current;
    }, own);
    const name = Object.hasOwn(aliases, tool.name) ? (aliases[tool.name] ?? tool.name) : tool.name;
    const current = actions.get(name);
    if (current === undefined || rank[action] > rank[current]) actions.set(name, action);
  }
  return actions;
};

const approvalRules = (actions: ReadonlyMap<string, PolicyAction | "default">) => {
  const approvals: Record<string, "always" | "never"> = {};
  const omitted: string[] = [];
  for (const [name, action] of actions) {
    if (action === "block") omitted.push(name);
    else if (action === "approve") approvals[name] = "never";
    else if (action === "require_approval") approvals[name] = "always";
  }
  return { approvals, omitted };
};

const missingNames = (missing: readonly string[]) =>
  `v2 would not provide ${missing.length} of its v1 tools: ${missing
    .slice(0, 10)
    .join(", ")}${missing.length > 10 ? ", …" : ""}.`;

/**
 * Whether v1 renamed an MCP server's tools, the upstream names v1 numbered, the v1 names dropped
 * as aliases, and the v1 names the generated app cannot reproduce. v1's id is the lower snake case
 * name, numbered from `_2` when an earlier tool of the same listing took it; the app maps each
 * numbered name explicitly. v1 sometimes listed one upstream tool under two names; it is kept once,
 * under its lower snake case name, and the other names are aliases (`alias → kept name`). A tool
 * row without the server's own name fails every call in v1 until it lists again, so it is skipped.
 */
export const mcpNaming = (rows: readonly ToolRow[]) => {
  const tools = rows.flatMap((tool) =>
    tool.upstream === null ? [] : [{ ...tool, upstream: tool.upstream }],
  );
  const rename = tools.some((tool) => tool.upstream !== tool.name);
  const exposed = (upstream: string) => (rename ? mcpToolName(upstream) : upstream);
  const overrides: Record<string, string> = {};
  const aliases: Record<string, string> = {};
  const missing = new Set<string>();
  // A name another upstream tool takes in lower snake case belongs to that tool.
  const takenByOther = (upstream: string, name: string) =>
    tools.some((other) => other.upstream !== upstream && exposed(other.upstream) === name);
  const upstreams = new Map<string, Set<string>>();
  for (const tool of tools)
    upstreams.set(tool.upstream, (upstreams.get(tool.upstream) ?? new Set()).add(tool.name));
  for (const [upstream, names] of upstreams) {
    const base = exposed(upstream);
    if (names.size > 1) {
      for (const name of names)
        if (name === base) continue;
        else if (takenByOther(upstream, base)) missing.add(name);
        else aliases[name] = base;
      continue;
    }
    for (const name of names) {
      if (base === name) continue;
      const numbered =
        rename &&
        name.startsWith(`${base}_`) &&
        /^[0-9]+$/u.test(name.slice(base.length + 1)) &&
        !takenByOther(upstream, name);
      if (numbered) overrides[upstream] = name;
      else missing.add(name);
    }
  }
  return { rename, overrides, aliases, missing: [...missing] };
};

/** v1 GraphQL names that are not `query.<field>` or `mutation.<field>`. */
export const graphqlMissing = (tools: readonly ToolRow[]) => [
  ...new Set(
    tools
      .filter((tool) => !/^(query|mutation)\.[A-Za-z_][A-Za-z0-9_]*$/u.test(tool.name))
      .map((tool) => tool.name),
  ),
];

const toolNames = (tools: readonly ToolRow[]) => new Set(tools.map((tool) => tool.name));

/**
 * v1's compiled name, by method and document path, for each operation v1 bound without a stored
 * row: a tool it last listed but stored no binding for, which v1 found by compiling the document.
 * An integration with neither rows nor listed tools exposes every operation, as v1 listed for a
 * new connection.
 */
export const compiledTools = (
  document: Record<string, unknown>,
  operations: readonly OpenApiOperationRow[],
  tools: readonly ToolRow[],
): ReadonlyMap<string, string> => {
  const bound = new Set(operations.map((operation) => operation.tool));
  const listed = toolNames(tools);
  const unbound = [...listed].filter((tool) => !bound.has(tool));
  if (operations.length > 0 && unbound.length === 0) return new Map();
  const wanted = operations.length === 0 && listed.size === 0 ? undefined : new Set(unbound);
  return new Map(
    [...v1ToolPaths(document)].filter(([, tool]) => wanted === undefined || wanted.has(tool)),
  );
};

// ---------------------------------------------------------------------------------------------
// Integrations.

/** The v1 reads source generation needs. */
export type GenerationSource = Pick<
  V1Source,
  "tools" | "openApiOperations" | "openApiBinding" | "blob" | "blobMissing" | "specification"
>;

/**
 * How the generated provider checks accounts, as the audit counts it: v1's check carried over, the
 * MCP server's own, none because v1 declared none or the app takes no account, or why v1's check
 * is not carried over.
 */
export type HealthOutcome =
  | { readonly kind: "request"; readonly identity: boolean }
  | { readonly kind: "graphql" }
  | { readonly kind: "mcp"; readonly declared: boolean }
  | { readonly kind: "none" }
  | { readonly kind: "dropped"; readonly reason: string };

/** A v1 tool an imported app leaves out because v1 could not run it either (decision 21). */
export interface StaleTool {
  readonly tool: string;
  readonly stale: V1StaleCategory;
  readonly reason: string;
}

/**
 * An integration's generated app: its files, what the user should know, its check, the v1 tools
 * of TRACE operations it leaves out (decision 16), the v1 tools it leaves out as stale (decision
 * 21), and the fixed credentials it leaves out (decision 22).
 */
export interface GeneratedApp {
  readonly files: SourceFiles;
  readonly note: string | undefined;
  readonly health: HealthOutcome;
  readonly traced: readonly string[];
  readonly stale: readonly StaleTool[];
  readonly dropped: readonly DroppedFixed[];
}

const healthOf = (check: GeneratedHealthCheck | undefined) =>
  check === undefined ? {} : { health: check };

/** Why an app with a fixed account has no account check. */
const fixedHealthDropped =
  "Its fixed credentials are held by a second account, which an account check cannot send.";

/** Why a tool v1 last listed before its integration was revised is stale. */
const removedTool =
  "v1 last listed it before the integration was revised, and the revised specification no longer has it, so v1 drops it when it next lists the tools.";

/**
 * The OpenAPI tools v1 last listed before the organization revised the integration, among those
 * v2 would not provide: v1 lists every such connection's tools again on its next read, from the
 * revised specification, which no longer has them. A tool any connection listed since still blocks.
 */
export const removedTools = (
  integration: Pick<IntegrationRow, "config_revised_at">,
  tools: readonly ToolRow[],
  missing: readonly string[],
) => {
  const revised = integration.config_revised_at;
  if (revised === null) return [];
  return missing.filter((name) => {
    const rows = tools.filter((tool) => tool.name === name);
    return rows.length > 0 && rows.every((tool) => (tool.listed_at ?? 0) < revised);
  });
};

const plain = (values: readonly string[]) => (values.length === 1 ? "it is" : "they are");

/** What the user should know about the tools and fixed credentials an app leaves out. */
const leftOutNote = (app: Pick<GeneratedApp, "traced" | "stale" | "dropped">) => {
  const notes: string[] = [];
  if (app.traced.length > 0)
    notes.push(
      `v2 sends no TRACE requests, so ${app.traced.length === 1 ? "its TRACE tool is" : "its TRACE tools are"} left out: ${app.traced.join(", ")}.`,
    );
  if (app.stale.length > 0)
    notes.push(
      `v1 could not run ${app.stale.length === 1 ? "one of its tools" : `${app.stale.length} of its tools`} either, so ${plain(app.stale.map((tool) => tool.tool))} left out: ${app.stale.map((tool) => tool.tool).join(", ")}.`,
    );
  if (app.dropped.length > 0)
    notes.push(
      `Its fixed ${app.dropped.map((entry) => `${entry.secret.carrier} ${entry.secret.name}`).join(", ")} repeated its OAuth client's own credentials, so ${plain(app.dropped.map((entry) => entry.secret.name))} not sent.`,
    );
  return notes.length === 0 ? undefined : notes.join(" ");
};

/** An integration's app source, generated from v1's rows without writing anything. */
export const generate = (
  context: { readonly snapshot: V1Snapshot; readonly source: GenerationSource },
  integration: IntegrationRow,
  decoded: ImportableIntegration,
  planned: Pick<AppAccounts, "methods" | "shared" | "fixed" | "dropped">,
) =>
  Effect.gen(function* () {
    const { methods, shared: sharedAccounts, dropped } = planned;
    const fixedAccount = planned.fixed?.account;
    const name = integrationLabel(integration);
    const { tenant, subjects } = context.snapshot;
    const accounts = Object.keys(methods).length > 0;
    // Credentials in v1's configuration are account fields; only the rest is written to source.
    const { headers, queryParams } = integrationValues(decoded);
    const accountOptions = {
      sharedAccounts,
      ...(fixedAccount === undefined ? {} : { fixedAccount }),
    };
    const left = { traced: [], stale: [], dropped } as const;
    switch (decoded.plugin) {
      case "mcp": {
        const tools = yield* context.source.tools(tenant, subjects, integration.slug);
        const { rename, overrides, aliases, missing } = mcpNaming(tools);
        if (missing.length > 0) return yield* fail(missingNames(missing));
        const rules: GeneratedToolRules = {
          ...(rename ? { names: { kind: "lower_snake", overrides } } : {}),
          ...approvalRules(toolActions(context.snapshot, integration, tools, aliases)),
        };
        const aliased = Object.entries(aliases).sort(([a], [b]) => (a < b ? -1 : 1));
        const generated = yield* generateMcpSource(
          name,
          decoded.config.endpoint,
          { kind: "methods", methods },
          { headers, queryParams, tools: rules, ...accountOptions },
        );
        const notes = [
          ...(aliased.length === 0
            ? []
            : [
                `v1 listed ${aliased.length === 1 ? "a tool" : "tools"} under two names; ${aliased
                  .map(([alias, kept]) => `${alias} is now ${kept}`)
                  .join(", ")}.`,
              ]),
          ...(leftOutNote(left) === undefined ? [] : [leftOutNote(left)]),
        ];
        return {
          files: generated.files,
          note: notes.length === 0 ? undefined : notes.join(" "),
          // v1's MCP check only listed tools, whatever it declared, as mcpHealth does.
          health: !accounts
            ? { kind: "none" as const }
            : fixedAccount !== undefined
              ? { kind: "dropped" as const, reason: fixedHealthDropped }
              : { kind: "mcp" as const, declared: integration.health_check !== null },
          ...left,
        } satisfies GeneratedApp;
      }
      case "graphql": {
        const tools = yield* context.source.tools(tenant, subjects, integration.slug);
        const missing = graphqlMissing(tools);
        if (missing.length > 0) return yield* fail(missingNames(missing));
        const check: GeneratedHealthCheck | undefined =
          accounts && decoded.healthCheck && fixedAccount === undefined
            ? { kind: "graphql", query: v1IntrospectionQuery }
            : undefined;
        const generated = yield* graphqlAppSource({
          name,
          url: decoded.config.endpoint,
          methods,
          ...accountOptions,
          headers,
          queryParams,
          tools: {
            names: { kind: "graphql_path" },
            ...approvalRules(toolActions(context.snapshot, integration, tools)),
          },
          ...healthOf(check),
        });
        return {
          files: generated.files,
          note: leftOutNote(left),
          health:
            check !== undefined
              ? { kind: "graphql" as const }
              : accounts && decoded.healthCheck && fixedAccount !== undefined
                ? { kind: "dropped" as const, reason: fixedHealthDropped }
                : { kind: "none" as const },
          ...left,
        } satisfies GeneratedApp;
      }
      case "openapi": {
        const stored = yield* context.source.blob(tenant, "openapi", `spec/${decoded.specHash}`);
        if (Option.isNone(stored)) return yield* fail(context.source.blobMissing);
        const read = parseSpec(stored.value);
        if (read.ok === false) return yield* failStale("unreadable_spec", read.reason);
        // v1 stored some specifications as their URL and fetched the document once; so does this.
        // v1 kept what it fetched, so a document that cannot be fetched or read now still blocks.
        const parsed =
          read.ok === "url"
            ? parseSpec(
                yield* context.source
                  .specification(read.url)
                  .pipe(Effect.catchTag("SpecificationUnavailable", (error) => fail(error.reason))),
              )
            : read;
        if (parsed.ok === "url")
          return yield* fail("v1's stored specification is a URL whose document is another URL.");
        if (!parsed.ok) return yield* fail(parsed.reason);
        const { document } = parsed;
        const operations = yield* context.source.openApiOperations(tenant, integration.slug);
        const tools = yield* context.source.tools(tenant, subjects, integration.slug);
        const compiled = importedDocument(
          document,
          operations,
          compiledTools(document, operations, tools),
        );
        // v1 sent each operation to its own server unless the integration set a base URL, with the
        // account's credentials on every one, and the app does the same. An operation v1 never
        // reached, on a server that is not http(s) or uses an undefined variable, is left out.
        const servers = operationBaseUrls(decoded.config, compiled.document);
        if (!servers.ok) return yield* refused(servers);
        const reachable = withoutOperations(compiled, servers.unreachable);
        const prepared = { ...compiled, document: reachable.document, named: reachable.named };
        const unreachable = reachable.removed.flatMap(({ key, tool }): StaleTool[] => {
          const operation = servers.unreachable.find(
            (candidate) => `${candidate.method} ${candidate.path}` === key,
          );
          return operation === undefined
            ? []
            : [{ tool, stale: operation.stale, reason: operation.reason }];
        });
        // The account's credentials go to every origin its operations call, as in v1; the
        // provider's hosts keep them to exactly those.
        const origins = credentialOrigins(servers.urls);
        // v1 also sent the credentials over plain HTTP when a server named it; an app that sends
        // them to several hosts does so only over HTTPS.
        const insecure = accounts && origins.length > 1 ? plainHttpHosts(origins) : [];
        if (insecure.length > 0)
          return yield* fail(
            `Its operations call ${insecure.join(", ")} over plain HTTP, and an imported app sends an account's credentials to more than one host only over HTTPS.`,
          );
        // The name liveOpenapiRouter gives each operation, as it reads the document, mapped to v1's.
        const declared = yield* Effect.tryPromise({
          try: () => openapiOperationNames(prepared.document),
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            error instanceof OpenapiCompileError ? fail(error.reason) : Effect.die(error),
          ),
        );
        const names: Record<string, string> = {};
        for (const operation of declared) {
          const v1 = prepared.named.get(`${operation.method.toLowerCase()} ${operation.path}`);
          if (v1 !== undefined) names[operation.name] = v1;
        }
        const exposed = new Set(Object.values(names));
        // Every tool v1 bound or last listed, except those of the TRACE operations it drops and
        // of the operations v1 never reached.
        const leftOut = new Set([...prepared.traced, ...unreachable.map((tool) => tool.tool)]);
        const missing = [
          ...new Set([...operations.map((operation) => operation.tool), ...toolNames(tools)]),
        ].filter((tool) => !exposed.has(tool) && !leftOut.has(tool));
        const removed = new Set(removedTools(integration, tools, missing));
        const blocking = missing.filter((tool) => !removed.has(tool));
        if (blocking.length > 0) return yield* fail(missingNames(blocking));
        const stale: readonly StaleTool[] = [
          ...unreachable,
          ...[...removed]
            .sort()
            .map((tool) => ({ tool, stale: "removed_tool" as const, reason: removedTool })),
        ];
        const staleNames = new Set(stale.map((tool) => tool.tool));
        const spec = decoded.healthCheck;
        const checked =
          !accounts || spec === undefined
            ? undefined
            : fixedAccount !== undefined
              ? ({ ok: false, reason: fixedHealthDropped } as const)
              : openapiHealth({
                  config: decoded.config,
                  spec,
                  binding: yield* context.source.openApiBinding(
                    tenant,
                    integration.slug,
                    spec.operation,
                  ),
                  origins,
                });
        const generated = yield* openapiAppSource({
          name,
          document: prepared.document,
          baseUrl: decoded.config.baseUrl,
          allowedOrigins: origins,
          methods,
          ...accountOptions,
          headers,
          queryParams,
          tools: {
            names: { kind: "map", names },
            ...approvalRules(
              toolActions(
                context.snapshot,
                integration,
                tools.filter((tool) => !staleNames.has(tool.name)),
              ),
            ),
          },
          ...healthOf(checked?.ok === true ? checked.check : undefined),
        });
        const outcome = { traced: prepared.traced, stale, dropped };
        return {
          files: generated.files,
          note: leftOutNote(outcome),
          ...outcome,
          health:
            checked === undefined
              ? { kind: "none" as const }
              : checked.ok
                ? {
                    kind: "request" as const,
                    identity:
                      checked.check.kind === "request" && checked.check.identity !== undefined,
                  }
                : { kind: "dropped" as const, reason: checked.reason },
        } satisfies GeneratedApp;
      }
    }
  }).pipe(Effect.catchTag("TemplateError", (error) => fail(error.reason)));

/** Deploy under the integration's name, then a numbered name when the organization has it. */
const deployNamed = (context: ItemContext, name: string, files: SourceFiles) =>
  Effect.gen(function* () {
    const owner = organizationOwner(context.target.id);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const candidate = attempt === 1 ? name : `${name.slice(0, 110)} (v1 ${attempt})`;
      const scoped = yield* scopeGeneratedPackage(files, context.target.slug, candidate).pipe(
        Effect.catch(() => fail("The app package could not be named.")),
      );
      const deployed = yield* context.executor.apps
        .deploy({ owner, name: candidate, files: scoped })
        .pipe(
          Effect.map((result) => Option.some(result.app)),
          Effect.catchTags({
            AppNameTaken: () => Effect.succeed(Option.none<DeployedApp>()),
            AppSlugTaken: () => Effect.succeed(Option.none<DeployedApp>()),
          }),
        );
      if (Option.isSome(deployed)) return deployed.value;
    }
    return yield* fail("Every name for this app is taken in the organization.");
  });

/**
 * Build failures name their stage and the failure in the generated source, which holds no
 * credentials. A build that ran out of memory, or whose compiler did not answer, says nothing
 * about the source: those fail the step, which retries them.
 */
const buildFailures = {
  VersionBuildFailed: (error: { readonly message: string }) =>
    fail(`The generated app did not build. ${error.message}`),
};

/**
 * Deploy the integration's app for the organization: shared with everyone, created by the owner.
 * An earlier run's app gets a new version.
 */
export const importIntegration = (
  context: ItemContext,
  integration: IntegrationRow,
  existing: AppId | undefined,
) =>
  Effect.gen(function* () {
    const plan = integrationPlan(integration);
    if (!plan.ok) return yield* refused(plan);
    const planned = appMethods(
      context.snapshot,
      context.firstParty,
      integration,
      yield* redundantFixed(context, integration),
    );
    const generated = yield* generate(context, integration, plan.value, planned);
    const owner = organizationOwner(context.target.id);
    const app =
      existing === undefined
        ? yield* deployNamed(context, integrationLabel(integration), generated.files)
        : (yield* context.executor.apps.deploy({
            owner,
            app: existing,
            files: yield* scopeGeneratedPackage(
              generated.files,
              context.target.slug,
              integrationLabel(integration),
            ).pipe(Effect.catch(() => fail("The app package could not be named."))),
          })).app;
    return {
      result: imported("app", app.id, generated.note),
      app: app.id,
      traced: generated.traced,
      stale: generated.stale,
      dropped: generated.dropped,
    };
  }).pipe(
    Effect.catchTags({
      ...buildFailures,
      AppNotFound: () => fail("Its imported app was removed."),
    }),
    sharedAppCreation,
    Effect.provideService(CurrentUserId, context.owner),
  );

/** The app's fixed account's field names and values, from v1's configuration (decision 22). */
const fixedAccount = (planned: AppAccounts) =>
  planned.fixed === undefined
    ? fail("Its imported app takes fixed credentials its integration no longer has.")
    : Effect.succeed({
        names: planned.fixed.account.fields,
        values: Redacted.make(Object.fromEntries(planned.fixed.configured)),
      });

/**
 * Save the account that holds the integration's fixed credentials, from v1's configuration, and
 * link it to the app's `fixed` requirement for everyone (decision 22), when the app declares one.
 * It is the organization's, created by the owner. Its map row keeps it for a retry, while the app's
 * provider for it is unchanged; linking again changes nothing.
 */
export const importFixedAccount = (context: ItemContext, integration: IntegrationRow, app: AppId) =>
  Effect.gen(function* () {
    const owner = organizationOwner(context.target.id);
    const deployed = yield* context.executor.apps.get({ owner, app });
    const requirement = deployed.requirements.accounts[fixedRequirement];
    if (requirement === undefined) return undefined;
    const planned = appMethods(
      context.snapshot,
      context.firstParty,
      integration,
      yield* redundantFixed(context, integration),
    );
    const fixed = yield* fixedAccount(planned);
    const hash = yield* sourceHash({ provider: requirement.provider, fields: fixed.names });
    const existing = yield* context.store.find("fixed_credentials", integration.row_id);
    const record = (result: MapResult) =>
      context.store.record({
        organization: context.snapshot.tenant,
        kind: "fixed_credentials",
        id: integration.row_id,
        result,
        hash,
      });
    const account =
      existing?.status === "imported" && existing.v2_id !== null && existing.source_hash === hash
        ? AccountId.make(existing.v2_id)
        : yield* context.executor[StorageHost].transaction(
            Effect.gen(function* () {
              const added = yield* context.executor.managedAccounts
                .add({
                  owner,
                  provider: requirement.provider,
                  method: fixedRequirement,
                  label: `${integrationLabel(integration)} fixed credentials`,
                  fields: fixed.values,
                })
                .pipe(accountDestination({ kind: "shared", audience: { kind: "everyone" } }));
              yield* record(imported("account", added.id));
              return added.id;
            }),
          );
    yield* linkAppAccount(context.executor, context.sql, {
      app,
      requirement: fixedRequirement,
      account,
      linkedBy: context.owner,
    });
    return account;
  }).pipe(
    Effect.catchTag("AppNotFound", () => fail("Its imported app was removed.")),
    Effect.provideService(CurrentUserId, context.owner),
  );

/**
 * Generate and compile the integration's app as an import would, and read the requirements it
 * declares, writing nothing: no app, version or source is saved, and the build is neither kept
 * nor cached (`apps.build`). The dry run's check that every app builds.
 */
export const checkIntegration = (
  context: Pick<ItemContext, "executor" | "snapshot" | "source" | "firstParty"> & {
    /** Names the build in its errors; nothing is saved under it. */
    readonly owner: OwnerId;
    /** The slug the organization would get, which scopes the app's package name. */
    readonly slug: string;
  },
  integration: IntegrationRow,
) =>
  Effect.gen(function* () {
    const plan = integrationPlan(integration);
    if (!plan.ok) return yield* refused(plan);
    const planned = appMethods(
      context.snapshot,
      context.firstParty,
      integration,
      yield* redundantFixed(context, integration),
    );
    const generated = yield* generate(context, integration, plan.value, planned);
    const name = integrationLabel(integration);
    const built = yield* context.executor.apps.build({
      owner: context.owner,
      name,
      files: yield* scopeGeneratedPackage(generated.files, context.slug, name).pipe(
        Effect.catch(() => fail("The app package could not be named.")),
      ),
    });
    return {
      note: generated.note,
      traced: generated.traced,
      stale: generated.stale,
      dropped: generated.dropped,
      health: generated.health,
      accounts: built.requirements.accounts,
    };
  }).pipe(Effect.catchTags(buildFailures));

/**
 * Check the account `importFixedAccount` would save for the app, against the requirements its
 * build declares, and save nothing.
 */
export const checkFixedAccount = (
  context: Pick<ItemContext, "executor" | "snapshot" | "source" | "firstParty">,
  integration: IntegrationRow,
  accounts: AppAccountRequirements,
) =>
  Effect.gen(function* () {
    const requirement = accounts[fixedRequirement];
    if (requirement === undefined) return;
    const planned = appMethods(
      context.snapshot,
      context.firstParty,
      integration,
      yield* redundantFixed(context, integration),
    );
    yield* context.executor[OAuthGrantImport].checkAccountFields({
      provider: requirement.provider,
      definition: requirement.definition,
      method: fixedRequirement,
      fields: (yield* fixedAccount(planned)).values,
    });
  });

// ---------------------------------------------------------------------------------------------
// Connections.

/**
 * Why a copied sign-in could not be set up, in the words of what to do next. An outage clears up
 * by itself, so support can retry it; the rest need a new sign-in.
 */
const oauthSetupReason = (reason: OAuthSetupFailed["reason"]) =>
  reason === "service_unavailable" || reason === "rate_limited"
    ? "The service did not respond while its sign-in was set up. Contact support if you need it."
    : reason === "discovery_missing" ||
        reason === "discovery_invalid" ||
        reason === "discovery_blocked"
      ? "The service no longer says how to sign in to it. Reconnect it in v2."
      : "Its sign-in could not be carried over to v2. Reconnect it in v2.";

/** Why a first-party sign-in cannot move to v2's client of the same name, as the user reads it. */
const firstPartyRefusal = (
  name: string,
  client: { readonly placement: { readonly hosts: readonly string[] } },
  hosts: readonly string[],
  error: Pick<OAuthGrantNotImportable, "reason" | "unreachable">,
) => {
  const only = `Executor v2's own ${name} app sends its tokens only to ${client.placement.hosts.join(", ")}`;
  const unreachable = error.unreachable ?? [];
  return error.reason === "unavailable"
    ? `It signed in through Executor's own ${name} app, which Executor v2 does not offer yet. Reconnect it in v2.`
    : error.reason === "scopes"
      ? `It was granted permissions Executor v2's own ${name} app does not allow. Reconnect it in v2.`
      : error.reason === "hosts"
        ? unreachable.length === 0 || unreachable.length === hosts.length
          ? `${only}, and its integration calls none of them. Reconnect it in v2.`
          : `${only}, and its integration also calls ${unreachable.join(", ")}, where its calls would be refused. Reconnect it in v2.`
        : `Its integration does not sign in where Executor v2's own ${name} app does. Reconnect it in v2.`;
};

/**
 * A connection's or client's secret from v1's Vault, read as v1 read it: an org item in the
 * organization's partition, a user-scoped item in the partition of the member who saved it (see
 * {@link secretSubjects}). One that no partition holds is stale: v1 cannot send it either.
 */
export const readSecret = (
  context: {
    readonly source: Pick<V1Source, "secret">;
    readonly snapshot: Pick<V1Snapshot, "tenant" | "subjects">;
  },
  row: Pick<ConnectionRow, "owner" | "subject">,
  itemId: string,
) => readSecretOf(context, row, itemId, false).pipe(Effect.map(({ value }) => value));

/**
 * A connection's secret as `readSecret` reads it, and, for an org connection whose user-scoped item
 * several members hold, how many hold it and how many distinct values they hold (decision 23).
 * The first member's value is the one that moves; the others are only compared, in memory.
 */
export const readSecretCompared = (
  context: {
    readonly source: Pick<V1Source, "secret">;
    readonly snapshot: Pick<V1Snapshot, "tenant" | "subjects">;
  },
  row: Pick<ConnectionRow, "owner" | "subject">,
  itemId: string,
) => readSecretOf(context, row, itemId, true);

const readSecretOf = (
  context: {
    readonly source: Pick<V1Source, "secret">;
    readonly snapshot: Pick<V1Snapshot, "tenant" | "subjects">;
  },
  row: Pick<ConnectionRow, "owner" | "subject">,
  itemId: string,
  compare: boolean,
) =>
  Effect.gen(function* () {
    // The first subject whose partition holds the item, as v1 found it for that caller.
    let first: string | undefined;
    const values = new Set<string>();
    let holders = 0;
    for (const subject of secretSubjects(context.snapshot, row, itemId)) {
      const value = yield* context.source
        .secret({ tenant: context.snapshot.tenant, subject, itemId })
        .pipe(
          Effect.catchTag("V1VaultUnavailable", () =>
            Effect.fail(
              new ItemFailed({
                reason: "v1's Vault did not answer while its saved credential was read.",
                vault: "unavailable",
              }),
            ),
          ),
        );
      if (value === undefined || value === "") continue;
      first ??= value;
      holders += 1;
      values.add(value);
      if (!compare) break;
    }
    if (first === undefined)
      return yield* new ItemFailed({
        reason: "Its saved credential could not be found in v1. Reconnect it in v2.",
        vault: "missing",
        stale: "missing_credential",
      });
    return { value: Redacted.make(first), holders, values: values.size };
  });

/**
 * The subjects whose Vault partition may hold a connection's item. v1 reads an item with the
 * calling member's binding, and a user-scoped item (`connection:user:…`) lives under the subject
 * that saved it. A member's own connection is read as them. An org connection has no subject
 * (`''`), and one that holds a user-scoped item, saved before it was shared, resolved in v1 for
 * the member who saved it, so each imported member is tried in turn. Org-scoped and legacy items
 * do not depend on the subject.
 */
const secretSubjects = (
  snapshot: Pick<V1Snapshot, "subjects">,
  row: Pick<ConnectionRow, "owner" | "subject">,
  itemId: string,
): readonly string[] =>
  row.owner === "org" && itemOwner(itemId) === "user" ? snapshot.subjects : [row.subject];

/** The account's name; an org connection yields its name to a personal one. */
export const accountLabel = (snapshot: Pick<V1Snapshot, "connections">, row: ConnectionRow) =>
  row.owner === "org" &&
  snapshot.connections.some(
    (other) =>
      other.owner === "user" && other.integration === row.integration && other.name === row.name,
  )
    ? `${row.name} (workspace)`
    : row.name;

/** The app requirement a connection's account is linked to: everyone's for an org connection. */
export const connectionRequirement = (row: Pick<ConnectionRow, "owner">) =>
  row.owner === "org" ? "workspace" : "service";

/** The accounts an integration's app takes, by requirement: a deployed app's or a build's. */
export type AppAccountRequirements = DeployedApp["requirements"]["accounts"];

/**
 * The account a connection's import saves, decided from v1's rows and secrets and the app's
 * requirements, writing nothing: the requirement it fills and the grant or fields it holds, or
 * why it cannot be saved. The import saves it (`importAccount`) and the dry run checks it
 * (`checkAccount`), so a dry run refuses every account an import would, with the same reason.
 */
type AccountWrite =
  | {
      readonly kind: "grant";
      readonly requirement: AccountRequirement;
      readonly input: ImportOAuthGrant;
      /** The operator's client a first-party grant moves to, which its refusal names. */
      readonly firstParty?: {
        readonly name: string;
        readonly client: { readonly placement: { readonly hosts: readonly string[] } };
        readonly hosts: readonly string[];
      };
    }
  | {
      readonly kind: "fields";
      readonly requirement: AccountRequirement;
      readonly input: {
        readonly owner: OwnerId;
        readonly provider: AccountRequirement["provider"];
        readonly method: string;
        readonly label: string;
        readonly fields: Redacted.Redacted<Record<string, string>>;
      };
    };

/** Reads one of a connection's secrets from v1's Vault, as `readSecret` does. */
export type SecretReader = (itemId: string) => ReturnType<typeof readSecret>;

const accountWrite = (
  context: Pick<ItemContext, "source" | "firstParty"> & { readonly snapshot: ConnectionSnapshot },
  plan: ConnectionPlan,
  accounts: AppAccountRequirements,
  owner: OwnerId,
  secret: SecretReader,
) =>
  Effect.gen(function* () {
    const requirement = accounts[connectionRequirement(plan.row)];
    if (requirement === undefined) return yield* fail("Its imported app takes no account.");
    const planned = appMethods(
      context.snapshot,
      context.firstParty,
      plan.integration,
      yield* redundantFixed(context, plan.integration),
    );
    const method = planned.methodOf.get(plan.row.row_id);
    if (method === undefined) return yield* fail("Its sign-in method is not in the imported app.");
    const base = {
      owner,
      provider: requirement.provider,
      method,
      label: accountLabel(context.snapshot, plan.row),
    };
    const expiresAt = plan.row.expires_at === null ? {} : { expiresAt: plan.row.expires_at };
    const access = plan.access;
    if (access.kind === "first_party") {
      const accessToken = yield* secret(access.accessItem);
      const refreshToken =
        plan.row.refresh_item_id === null ? undefined : yield* secret(plan.row.refresh_item_id);
      const hosts = requirement.definition.hosts ?? [];
      return {
        kind: "grant",
        requirement,
        input: {
          ...base,
          redirectUri: v1OAuthCallback,
          firstParty: access.client.id,
          hosts,
          accessToken,
          refreshToken,
          ...expiresAt,
          renewal: access.renewal,
        },
        firstParty: { name: firstPartyName(access.client.id), client: access.client, hosts },
      } satisfies AccountWrite as AccountWrite;
    }
    if (access.kind !== "oauth") {
      // Values from v1's configuration first, then the connection's own from v1's Vault.
      const fields: Record<string, string> = Object.fromEntries(
        planned.configured.get(plan.row.row_id) ?? [],
      );
      if (access.kind === "secrets")
        for (const [variable, item] of access.items)
          fields[variable] = Redacted.value(yield* secret(item));
      return {
        kind: "fields",
        requirement,
        input: { ...base, fields: Redacted.make(fields) },
      } satisfies AccountWrite as AccountWrite;
    }
    const { client, grant } = access;
    const clientSecret =
      client.client_secret_item_id === null
        ? undefined
        : yield* secret(client.client_secret_item_id);
    const registration = yield* Schema.decodeUnknownEffect(OAuthRegistration)({
      client_id: client.client_id,
      token_endpoint_auth_method:
        clientSecret === undefined
          ? "none"
          : (tokenEndpointAuthMethod(client.token_endpoint_auth_method) ?? "client_secret_post"),
      ...(clientSecret === undefined ? {} : { client_secret: Redacted.value(clientSecret) }),
    }).pipe(Effect.catch(() => fail("Its OAuth client could not be read.")));
    const accessToken = yield* secret(access.accessItem);
    const refreshToken =
      grant === "authorization_code" && plan.row.refresh_item_id !== null
        ? yield* secret(plan.row.refresh_item_id)
        : undefined;
    return {
      kind: "grant",
      requirement,
      input: {
        ...base,
        ...(grant === "authorization_code"
          ? { redirectUri: client.origin_redirect_uri ?? v1OAuthCallback }
          : {}),
        client: Redacted.make(registration),
        accessToken,
        refreshToken,
        ...expiresAt,
        renewal: access.renewal,
      },
    } satisfies AccountWrite as AccountWrite;
  });

/** Why v2 refused to save a connection's grant, as the user reads it, for an import and a check. */
const grantRefusals = (write: Extract<AccountWrite, { kind: "grant" }>) =>
  Effect.catchTags({
    OAuthSetupFailed: (error: OAuthSetupFailed) => fail(oauthSetupReason(error.reason)),
    AuthMethodInvalid: () => fail("Its sign-in method is not in the imported app."),
    OAuthGrantNotImportable: (error: OAuthGrantNotImportable) =>
      write.firstParty === undefined
        ? fail("Its sign-in could not be carried over to v2. Reconnect it in v2.")
        : fail(
            firstPartyRefusal(
              write.firstParty.name,
              write.firstParty.client,
              write.firstParty.hosts,
              error,
            ),
          ),
  });

/** Whether a connection's app is public: it takes no account, so the connection needs none. */
export const needsNoAccount = (plan: ConnectionPlan, accounts: AppAccountRequirements) =>
  plan.access.kind === "none" && accounts.service === undefined && accounts.workspace === undefined;

/**
 * Save the connection's account: an org connection's is shared with everyone and created by the
 * owner, a member's is their own. The map row commits with it.
 */
export const importAccount = (
  context: ItemContext,
  plan: ConnectionPlan,
  app: Pick<DeployedApp, "id" | "requirements">,
  record: (result: MapResult) => Effect.Effect<void, V1ImportUnavailable>,
) =>
  Effect.gen(function* () {
    const actor = actorOf(context, plan.row);
    if (actor === undefined) return yield* fail("Its member is not imported.");
    return yield* saveAccount(context, plan, app, record, actor).pipe(
      Effect.provideService(CurrentUserId, actor),
    );
  });

const saveAccount = (
  context: ItemContext,
  plan: ConnectionPlan,
  app: Pick<DeployedApp, "id" | "requirements">,
  record: (result: MapResult) => Effect.Effect<void, V1ImportUnavailable>,
  actor: string,
) =>
  Effect.gen(function* () {
    const creation =
      plan.row.owner === "org"
        ? accountDestination({ kind: "shared", audience: { kind: "everyone" } })
        : personalAccountCreation(actor);
    const write = yield* accountWrite(
      context,
      plan,
      app.requirements.accounts,
      organizationOwner(context.target.id),
      (itemId) => readSecret(context, plan.row, itemId),
    );
    if (write.kind === "fields")
      return yield* context.executor[StorageHost].transaction(
        Effect.gen(function* () {
          const account = yield* context.executor.managedAccounts.add(write.input).pipe(creation);
          yield* record(imported("account", account.id));
          return account.id;
        }),
      );
    const account = yield* context.executor[OAuthGrantImport]
      .importOAuthGrant(write.input)
      .pipe(creation, grantRefusals(write));
    // Discovery ran outside a transaction; the account is recorded as soon as it exists.
    yield* record(imported("account", account.id));
    return account.id;
  });

/**
 * Check the connection's account as `importAccount` would save it, against the requirements its
 * app's build declares, and save nothing: the dry run's check that every account moves. Its
 * refusals are the import's, with the same reasons. `secret` reads what the import would read
 * from v1's Vault, such as the values the dry run has already read.
 */
export const checkAccount = (
  context: Pick<ItemContext, "executor" | "source" | "firstParty"> & {
    readonly snapshot: ConnectionSnapshot;
    /** Names the check in its errors; nothing is saved under it. */
    readonly owner: OwnerId;
  },
  plan: ConnectionPlan,
  accounts: AppAccountRequirements,
  secret: SecretReader,
) =>
  Effect.gen(function* () {
    const write = yield* accountWrite(context, plan, accounts, context.owner, secret);
    const host = context.executor[OAuthGrantImport];
    if (write.kind === "fields")
      return yield* host.checkAccountFields({
        provider: write.input.provider,
        definition: write.requirement.definition,
        method: write.input.method,
        fields: write.input.fields,
      });
    return yield* host
      .checkOAuthGrant({ ...write.input, definition: write.requirement.definition })
      .pipe(grantRefusals(write));
  });

/**
 * Link the connection's account to its app as linking it in v2 does: an org connection's to the
 * app's `workspace` requirement for everyone, by the owner; a member's to its `service`
 * requirement for them (decision 9). Both take many accounts, so every imported connection of an
 * integration stays usable. Linking again changes nothing, so a retried item does not duplicate it.
 */
export const linkConnectionAccount = (
  context: ItemContext,
  row: Pick<ConnectionRow, "owner" | "subject">,
  app: Pick<DeployedApp, "id">,
  account: AccountId,
) =>
  Effect.gen(function* () {
    if (row.owner === "org")
      return yield* linkAppAccount(context.executor, context.sql, {
        app: app.id,
        requirement: connectionRequirement(row),
        account,
        linkedBy: context.owner,
      });
    const member = actorOf(context, row);
    if (member === undefined) return yield* fail("Its member is not imported.");
    return yield* linkUserAccount(context.executor, context.sql, {
      app: app.id,
      requirement: connectionRequirement(row),
      account,
      subject: member,
    });
  });

// ---------------------------------------------------------------------------------------------
// Toolkits.

type RunTarget = ConnectionApp["runsAs"][number];

/**
 * What an earlier item request imported: an integration's app, and a connection's account and the
 * target its tools run as (its linked account, or the app itself for a public app).
 */
export interface ImportedLookup {
  readonly app: (
    integration: IntegrationRow,
  ) => Effect.Effect<string | undefined, V1ImportUnavailable>;
  readonly connection: (
    connection: ConnectionRow,
  ) => Effect.Effect<
    { readonly target: RunTarget; readonly account: string | null } | undefined,
    V1ImportUnavailable
  >;
}

/**
 * What a connection's tools run as once its account is linked (see `linkConnectionAccount`): an org
 * connection's account is an app link, which a call reaches through the app itself, since a grant
 * names only the caller's own accounts; a member's is their own account.
 */
export const connectionTarget = (
  row: Pick<ConnectionRow, "owner">,
  account: AccountId,
): RunTarget => (row.owner === "org" ? { kind: "app" } : { kind: "account", id: account });

/**
 * The import map's view of earlier item requests. A connection is done once its `profile` row is:
 * the row keeps the kind it had when imports made a profile per connection, so imports started
 * then still read. Its `v2_kind` is `app` for a public app's connection, whose tools run as the
 * app; otherwise the connection's account, recorded in its `connection` row, is linked to the app
 * and its tools run as `connectionTarget` says. Its `v2_id` is the linked account, or, in a row
 * from before profiles were removed, the profile, which the item's result replaces with that
 * account.
 */
export const mapLookup = (store: ImportStore): ImportedLookup => ({
  app: (integration) =>
    store
      .find("integration", integration.row_id)
      .pipe(
        Effect.map((found) =>
          found?.status === "imported" && found.v2_id !== null ? found.v2_id : undefined,
        ),
      ),
  connection: (connection) =>
    Effect.gen(function* () {
      const linked = yield* store.find("profile", connection.row_id);
      if (linked?.status !== "imported" || linked.v2_id === null) return undefined;
      if (linked.v2_kind === "app") return { target: { kind: "app" } as const, account: null };
      const account = yield* store.find("connection", connection.row_id);
      if (account?.status !== "imported" || account.v2_id === null) return undefined;
      return {
        target: connectionTarget(connection, AccountId.make(account.v2_id)),
        account: account.v2_id,
      };
    }),
});

const sameTarget = (a: RunTarget, b: RunTarget) =>
  a.kind === "app" ? b.kind === "app" : b.kind === "account" && a.id === b.id;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/**
 * A toolkit's scoped MCP connection: for each imported app whose tools it granted, the tools v1
 * served through it (`selected`, by the app's names) and what the connections it granted run as:
 * the app itself for an org connection or a public app's, and a member's own account for theirs. v2 selects an app's tools and accounts
 * separately, so a tool v1 granted for only some of those connections becomes available through
 * all of them; the note says so.
 *
 * Each member gets their own copy (decision 11), which reaches org connections and, for the
 * member's own toolkit, their own connections; never another member's.
 */
export const toolkitPolicy = (
  context: { readonly snapshot: V1Snapshot; readonly source: Pick<V1Source, "tools"> },
  lookup: ImportedLookup,
  toolkit: V1Toolkit,
  member: string,
) =>
  Effect.gen(function* () {
    const { snapshot, source } = context;
    const apps: ConnectionApp[] = [];
    const notes: string[] = [];
    const missingApps: string[] = [];
    const missingConnections = new Set<string>();
    const blockedElsewhere = new Set<string>();
    const widened: string[] = [];
    const visible = visibleTo(member);
    const reached = toolkitConnections(snapshot, toolkit).filter(visible);
    for (const integration of snapshot.integrations) {
      if (!reached.some((connection) => connection.integration === integration.slug)) continue;
      const appId = yield* lookup.app(integration);
      const label = integrationLabel(integration);
      if (appId === undefined) {
        missingApps.push(label);
        continue;
      }
      // Approvals are the app's, for every member, so they read every member's tools.
      const all = yield* source.tools(snapshot.tenant, snapshot.subjects, integration.slug);
      const aliases = integration.plugin_id === "mcp" ? mcpNaming(all).aliases : {};
      const omitted = new Set(
        approvalRules(toolActions(snapshot, integration, all, aliases)).omitted,
      );
      const tools = all.filter(visible);
      const names = new Set<string>();
      const granted = new Map<string, ConnectionRow>();
      const pairs = new Set<string>();
      for (const tool of tools) {
        const action = toolkitAction(
          toolkit,
          `${integration.slug}.${tool.owner}.${tool.connection}.${tool.name}`,
        );
        if (action === undefined || action === "block") continue;
        const name = Object.hasOwn(aliases, tool.name)
          ? (aliases[tool.name] ?? tool.name)
          : tool.name;
        if (omitted.has(name)) {
          blockedElsewhere.add(`${label} ${name}`);
          continue;
        }
        const connection = snapshot.connections.find(
          (candidate) =>
            candidate.integration === integration.slug &&
            candidate.owner === tool.owner &&
            candidate.subject === tool.subject &&
            candidate.name === tool.connection,
        );
        if (connection === undefined) continue;
        names.add(name);
        granted.set(connection.row_id, connection);
        pairs.add(`${connection.row_id} ${name}`);
      }
      if (names.size === 0) continue;
      const targets: RunTarget[] = [];
      for (const connection of granted.values()) {
        const target = (yield* lookup.connection(connection))?.target;
        if (target === undefined) missingConnections.add(`${label} ${connection.name}`);
        else if (!targets.some((other) => sameTarget(other, target))) targets.push(target);
      }
      const [first, ...rest] = targets;
      if (first === undefined) continue;
      if (names.size * granted.size > pairs.size) widened.push(label);
      apps.push({
        app: AppId.make(appId),
        runsAs: [first, ...rest],
        tools: { kind: "selected", names: [...names].sort().map((name) => ToolName.make(name)) },
      });
    }
    if (reached.length === 0) notes.push(grantsNoConnection);
    if (missingApps.length > 0) notes.push(`Not imported, so left out: ${missingApps.join(", ")}.`);
    if (missingConnections.size > 0)
      notes.push(
        `${plural(missingConnections.size, "connection was", "connections were")} not imported and ${missingConnections.size === 1 ? "is" : "are"} left out: ${[...missingConnections].join(", ")}.`,
      );
    if (blockedElsewhere.size > 0)
      notes.push(
        `${plural(blockedElsewhere.size, "tool", "tools")} v1 allowed only through this toolkit ${blockedElsewhere.size === 1 ? "is" : "are"} blocked in the workspace, so ${blockedElsewhere.size === 1 ? "it is" : "they are"} left out: ${[...blockedElsewhere].sort().join(", ")}.`,
      );
    if (widened.length > 0)
      notes.push(
        `v2 grants an app's selected tools through every selected account, so some tools are now available through more accounts of ${widened.join(", ")} than in v1.`,
      );
    if (toolkit.access.some((pattern) => pattern.split(".")[0] === "executor"))
      notes.push("It granted v1's built-in tools, which v2 does not have.");
    return { policy: { apps } satisfies ConnectionPolicy, notes };
  });

/**
 * The connection's id: stable for the toolkit, the member's copy and the organization, so a retry
 * updates it.
 */
export const toolkitConnectionId = (organization: string, toolkit: V1Toolkit, member: string) =>
  sourceHash([organization, toolkit.row.row_id, member]).pipe(
    Effect.map((hash) => ConnectionId.make(`v1-${hash.slice(0, 40)}`)),
  );

/** The members who get a copy of a toolkit: everyone for an org toolkit, else its owner. */
export const toolkitMembers = (toolkit: V1Toolkit, members: readonly string[]) =>
  toolkit.row.owner === "org"
    ? members
    : members.filter((member) => member === toolkit.row.subject);

/** The map key of one member's copy of a toolkit. */
export const toolkitCopyKey = (toolkit: Pick<V1Toolkit, "row">, member: string) =>
  toolkitCopyId(toolkit.row.row_id, member);

/** Create or update a member's copy of the toolkit: a scoped MCP connection they own. */
export const importToolkit = (context: ItemContext, toolkit: V1Toolkit, member: string) =>
  Effect.gen(function* () {
    const user = context.users.get(member);
    if (user === undefined) return yield* fail("Its member is not imported.");
    const { policy, notes } = yield* toolkitPolicy(
      context,
      mapLookup(context.store),
      toolkit,
      member,
    );
    const owner = { userId: user, resource: context.target.id };
    const id = yield* toolkitConnectionId(context.target.id, toolkit, member);
    const name = (toolkit.data.name.trim() === "" ? toolkit.data.slug : toolkit.data.name).slice(
      0,
      80,
    );
    const existing = yield* context.connections.list(owner);
    const saved = existing.some((connection) => connection.id === id)
      ? yield* context.connections.update(owner, { id, name, policy })
      : yield* context.connections.create(owner, { id, name, policy });
    return imported("mcp_connection", saved.id, notes.length === 0 ? undefined : notes.join(" "));
  }).pipe(
    Effect.catchTags({
      ConnectionIdTaken: () => fail("Its MCP connection was removed in v2."),
      ConnectionNotFound: () => fail("Its MCP connection was removed in v2."),
    }),
  );

// ---------------------------------------------------------------------------------------------
// Artifacts.

/** Where one role of an artifact's code maps to in v2, or why it does not. */
export interface ArtifactRoleMapping {
  readonly role: string;
  readonly integration: string;
  readonly v1: ArtifactBinding | null;
  readonly app: { readonly id: string; readonly name: string } | null;
  readonly account: string | null;
  readonly problem: string | null;
}

/** Each role's imported app and linked account, read from the import map. */
export const artifactMapping = (
  snapshot: Pick<V1Snapshot, "integrations" | "connections">,
  lookup: ImportedLookup,
  row: ArtifactRow,
) =>
  Effect.gen(function* () {
    const planned = artifactPlan(snapshot, row);
    const roles = yield* Effect.forEach(planned.roles, ({ use, integration, connection }) =>
      Effect.gen(function* () {
        const mapping = (
          rest: Partial<Omit<ArtifactRoleMapping, "role" | "integration" | "v1">>,
        ): ArtifactRoleMapping => ({
          role: use.role,
          integration: use.integration,
          v1: use.binding ?? null,
          app: null,
          account: null,
          problem: null,
          ...rest,
        });
        if (integration === undefined)
          return mapping({ problem: "Its integration no longer exists in v1." });
        const appId = yield* lookup.app(integration);
        if (appId === undefined) return mapping({ problem: "Its integration was not imported." });
        const app = { id: appId, name: integrationLabel(integration) };
        if (use.binding === undefined)
          return mapping({ app, problem: "v1 bound no connection to it." });
        if (connection === undefined)
          return mapping({ app, problem: "Its connection no longer exists in v1." });
        const imported = yield* lookup.connection(connection);
        if (imported === undefined)
          return mapping({ app, problem: "Its connection was not imported." });
        return mapping({ app, account: imported.account });
      }),
    );
    return { roles, builtIn: planned.builtIn };
  });

const commentText = (text: string) => text.replace(/\*\//g, "*\\/");
const htmlText = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The artifact's app package: its v1 code unchanged as the page component, the page and package
 * scaffolding, an app with no tools yet, and `v1-artifact.json` with each role's mapping.
 */
export const artifactFiles = (
  row: ArtifactRow,
  mapping: { readonly roles: readonly ArtifactRoleMapping[]; readonly builtIn: boolean },
) => {
  const title = row.title.trim() === "" ? "Artifact" : row.title;
  return [
    packageFile(title, { react: "^19.2.0", "react-dom": "^19.2.0" }),
    {
      path: "index.ts",
      content: `import { defineApp, router } from "apps";

/**
 * Imported from the Executor v1 artifact ${commentText(JSON.stringify(title))}. Its page,
 * ui/artifact.tsx, called other integrations' tools from the browser (\`tools.<integration>...\`),
 * and a v2 app's page calls only its own app's tools. Add tools here that do what the page needs,
 * then rewrite the page to call them through \`apps/client\`. v1-artifact.json lists the imported
 * app and account each \`tools.<role>\` call used.
 */
export default defineApp({}, { tools: router({}) });
`,
    },
    {
      path: "ui/index.html",
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${htmlText(title)}</title>
    <script type="module" src="./main.tsx"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`,
    },
    {
      path: "ui/main.tsx",
      content: `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// v1 ran artifact.tsx with its globals in scope (React hooks, TanStack Query, its UI components
// and \`tools\`) and rendered its \`App\`. Import what it uses there and export \`App\`.
import { App } from "./artifact.tsx";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing app root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
    },
    { path: "ui/artifact.tsx", content: row.code },
    {
      path: "v1-artifact.json",
      content: `${JSON.stringify(
        {
          title: row.title,
          description: row.description,
          builtInTools: mapping.builtIn,
          roles: Object.fromEntries(
            mapping.roles.map(({ role, ...rest }) => [role, rest] as const),
          ),
        },
        null,
        2,
      )}\n`,
    },
  ];
};

/** What the user should know: what needs repair, and where each role's calls now go. */
export const artifactNote = (mapping: {
  readonly roles: readonly ArtifactRoleMapping[];
  readonly builtIn: boolean;
}) => {
  const mapped = mapping.roles.filter((role) => role.problem === null);
  const unmapped = mapping.roles.filter((role) => role.problem !== null);
  return [
    artifactRepairNote,
    ...(mapped.length === 0
      ? []
      : [
          `Its calls map to ${mapped
            .map(
              (role) =>
                `${role.role} → ${role.app?.name ?? role.integration} (${role.v1?.connection ?? "no connection"})`,
            )
            .join(", ")}.`,
        ]),
    ...unmapped.map((role) => `${role.role}: ${role.problem}`),
    ...(mapping.builtIn ? ["It also calls v1's built-in tools, which v2 does not have."] : []),
  ].join(" ");
};

/**
 * Save the artifact as a private app without a version: `apps.create` keeps its source and builds
 * nothing, so it does not run until it is repaired. An earlier import's app gets a new commit.
 */
export const importArtifact = (
  context: ItemContext,
  row: ArtifactRow,
  mapping: { readonly roles: readonly ArtifactRoleMapping[]; readonly builtIn: boolean },
  existing: AppId | undefined,
) =>
  Effect.gen(function* () {
    // An org artifact's creator is the owner; a member's artifact stays theirs.
    const creator = actorOf(context, row);
    if (creator === undefined) return yield* fail("Its member is not imported.");
    return yield* saveArtifact(context, row, mapping, existing).pipe(
      Effect.provideService(CurrentUserId, creator),
    );
  });

const saveArtifact = (
  context: ItemContext,
  row: ArtifactRow,
  mapping: { readonly roles: readonly ArtifactRoleMapping[]; readonly builtIn: boolean },
  existing: AppId | undefined,
) =>
  Effect.gen(function* () {
    const owner = organizationOwner(context.target.id);
    const title = row.title.trim() === "" ? "Artifact" : row.title;
    const files = yield* Schema.decodeUnknownEffect(SourceFiles)(artifactFiles(row, mapping)).pipe(
      Effect.catch(() => fail("Its source is too large for an app.")),
    );
    const note = artifactNote(mapping);
    if (existing !== undefined) {
      const updated = yield* Effect.gen(function* () {
        const workspace = yield* context.executor.apps.workspace({ app: existing, owner });
        const scoped = yield* scopeGeneratedPackage(files, context.target.slug, title).pipe(
          Effect.catch(() => fail("The app package could not be named.")),
        );
        yield* context.executor.apps.commit({
          app: existing,
          owner,
          expected: workspace.revision.commit,
          files: scoped,
          message: "Update from the Executor v1 artifact",
        });
        return Option.some(existing);
      }).pipe(Effect.catchTag("AppNotFound", () => Effect.succeed(Option.none<AppId>())));
      if (Option.isSome(updated)) return { ...imported("undeployed_app", updated.value, note) };
    }
    for (let attempt = 1; attempt <= 5; attempt++) {
      const candidate =
        attempt === 1 ? title.slice(0, 120) : `${title.slice(0, 110)} (v1 ${attempt})`;
      const scoped = yield* scopeGeneratedPackage(files, context.target.slug, candidate).pipe(
        Effect.catch(() => fail("The app package could not be named.")),
      );
      const created = yield* context.executor.apps
        .create({ owner, name: candidate, files: scoped })
        .pipe(
          Effect.map((app) => Option.some(app.id)),
          Effect.catchTags({
            AppNameTaken: () => Effect.succeed(Option.none<AppId>()),
            AppSlugTaken: () => Effect.succeed(Option.none<AppId>()),
          }),
        );
      if (Option.isSome(created)) return imported("undeployed_app", created.value, note);
    }
    return yield* fail("Every name for this app is taken in the organization.");
  });
