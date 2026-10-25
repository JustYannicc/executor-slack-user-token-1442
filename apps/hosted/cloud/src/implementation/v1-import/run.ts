/**
 * One v1 organization's move, as the `V1Import` Workflow runs it (`notes/v1-import.md`, "Where it
 * runs" and "Cutover per organization"). Each step is durable and retried on its own; every write
 * first looks up its import map row, so a step that runs again after a partial write never makes a
 * second copy. Step results hold ids, counts and reasons, never a secret: a step that reads a
 * secret from v1's Vault encrypts and saves it in the same step.
 *
 * A dry run (`mode: "dry-run"`) reads v1 and v2, generates and compiles every app without keeping
 * the build, reads every secret without keeping it, and writes only its report. It writes nothing
 * to v1, to v2's database or to the app build store.
 *
 * Each step opens one view of v1 (`V1ImportEnvironment.source`): one read-only Postgres connection
 * and the step's tool listings, released with the step.
 */
import {
  HostedExecutor,
  organizationOwner,
  type McpConnectionStore,
  type OrganizationId,
} from "@executor-js/hosted-server";
import { AccountId, AppId, OAuthGrantImport, OwnerId, type Executor } from "@executor-js/sdk/core";
import { Context, Effect, Option, Predicate, type Redacted, Schema, type Scope } from "effect";
import { freeMembers } from "../../contracts/billing-catalog.ts";
import { V1ImportDatabase, V1ImportUnavailable } from "../../contracts/v1-import.ts";
import {
  V1OrgReport,
  type V1ImportVerification,
  type V1StaleCategory,
  v1ImportInFlightKey,
  v1ImportReportKey,
  v1ImportRunPrefix,
  type V1ImportParams,
  type V1OrgOutcome,
} from "../../contracts/v1-import-run.ts";
import {
  decodeToolkit,
  firstPartyClientPrefix,
  matchPattern,
  type ConnectionRow,
  type IntegrationRow,
} from "./formats.ts";
import {
  importMembership,
  importOrganization,
  importUser,
  matchUser,
  plannedSlug,
  slugBase,
  slugCandidates,
  type UserMatch,
} from "./identity.ts";
import {
  ItemFailed,
  artifactMapping,
  checkAccount,
  checkFixedAccount,
  checkIntegration,
  connectionTarget,
  importAccount,
  importArtifact,
  importFixedAccount,
  importIntegration,
  importToolkit,
  linkConnectionAccount,
  mapLookup,
  needsNoAccount,
  readSecretCompared,
  refreshCopiedGrant,
  refused,
  toolkitCopyKey,
  toolkitMembers,
  updateCopiedAccount,
  toolkitPolicy,
  type AppAccountRequirements,
  type DroppedFixed,
  type ImportedLookup,
  type ItemContext,
  type StaleTool,
} from "./items.ts";
import {
  memberProfile,
  planMembers,
  v1Billing,
  type PlannedMember,
  type SkippedMember,
  type V1Billing,
} from "./members.ts";
import {
  connectionPlan,
  integrationLabel,
  integrationPlan,
  policyPlan,
  type FirstPartyClients,
} from "./plan.ts";
import {
  V1ImportUnreadable,
  allSnapshotTables,
  unreadableReason,
  type V1Snapshot,
  type V1SnapshotTable,
  type V1Source,
} from "./source.ts";
import { makeImportStore, sourceHash, type MapKind, type MapResult } from "./store.ts";
import { V1MovedState } from "./moved-flag.ts";
import { importRefusal, movedFlag, type V1ImportWrites } from "./writes.ts";

/** The note on an imported policy that matches none of the tools v1 last listed. */
export const noToolMatches = "It matches no tool v1 last listed for its integration.";

/** Why a member's own `approve` rule does not move into a shared workspace (decision 10). */
export const personalApproveDropped =
  "In a workspace with more than one member, a member's own approve rules are not imported, so these tools ask again.";

/** Why a connection or rule of an integration whose app was not imported cannot move. */
const integrationNotImported = "Its integration was not imported.";
/** Why an item an earlier run imported is left out: its users removed it in v2 since. */
const removedInV2 = "Its users removed it in v2 after an earlier run imported it.";
/** The note on an item an earlier run imported that its users changed in v2 since. */
const keptInV2 = "Kept as its users changed it in v2 after an earlier run imported it.";
/** The note on a copied account that took v1's final tokens (`refreshCopiedGrants`). */
const tookV1Note = "Took v1's newer sign-in.";
/** The note on a copied account that moved to its regenerated app's provider (`followAppProvider`). */
const followedNote = "Moved to its app's new sign-in methods.";

/**
 * Before the import deploys anything, each account an earlier run saved takes v1's final tokens
 * if they are newer (`refreshCopiedGrant`). A deployment starts work that uses the app's accounts,
 * such as reconciling its webhook sources, and an account still holding the copy's tokens would
 * renew with a refresh token v1 has rotated since: a service that ends the grant when an old
 * refresh token comes back then refuses v1's tokens too. Returns the connections whose account
 * took v1's tokens.
 */
const refreshCopiedGrants = (context: ImportContext, ids: readonly string[]) =>
  Effect.gen(function* () {
    const took: string[] = [];
    for (const id of ids) {
      const row = context.snapshot.connections.find((candidate) => candidate.row_id === id);
      const saved = yield* context.store.find("connection", id);
      if (row === undefined || saved?.status !== "imported" || saved.v2_id === null) continue;
      if ((yield* context.store.sinceImported("connection", id)) === "removed") continue;
      if ((yield* refreshCopiedGrant(context, row, AccountId.make(saved.v2_id))) === "replaced")
        took.push(id);
    }
    return took;
  });

/** The v2 kind of an app imported as source without a version, which needs repair. */
const undeployedApp = "undeployed_app";

/** Private report storage: the `AppBuilds` bucket, under `v1-import/`. */
export interface V1ImportReports {
  readonly put: (key: string, value: unknown) => Effect.Effect<void, V1ImportUnavailable>;
  readonly get: (key: string) => Effect.Effect<Option.Option<unknown>, V1ImportUnavailable>;
  readonly remove: (key: string) => Effect.Effect<void, V1ImportUnavailable>;
  /** Object names under a prefix, at most `limit` (up to 1000) a page. */
  readonly list: (
    prefix: string,
    cursor: string | undefined,
    limit: number,
  ) => Effect.Effect<
    { readonly keys: readonly string[]; readonly cursor: string | undefined },
    V1ImportUnavailable
  >;
}

/** What the importer reaches beyond the product's executor and database. */
export class V1ImportEnvironment extends Context.Service<
  V1ImportEnvironment,
  {
    /** A read-only view of v1. Each step opens one, which lives as long as the step's scope. */
    readonly source: Effect.Effect<V1Source, V1ImportUnavailable, Scope.Scope>;
    /** Members' scoped MCP connections, which toolkits become. */
    readonly connections: McpConnectionStore;
    readonly reports: V1ImportReports;
    /**
     * Which organizations this deployment may import, writing v2 (`writes.ts`); dry runs never
     * write. The operator routes check it and the allow table before starting, and the run again.
     */
    readonly writes: V1ImportWrites;
    /**
     * How long an import waits after freezing its organization in v1 before it reads what it
     * copies, so v1 requests already past the flag, such as a token refresh, can finish.
     */
    readonly freezeSettleSeconds: number;
    /** v1's first-party OAuth client IDs, by the name of the v2 client each must be (decision 2). */
    readonly v1FirstPartyClients: Readonly<Record<string, string>>;
    /** The deployment secret slug suffixes are derived with (`slugCandidates`). */
    readonly slugKey: Effect.Effect<Redacted.Redacted<string>>;
  }
>()("cloud/V1ImportEnvironment") {}

/**
 * A step that still failed after its retries; the run records it and goes on or stops. `failure`
 * is the tag of its last attempt's error, which names its kind without its message or data.
 */
export class V1ImportStepFailed extends Schema.TaggedError<V1ImportStepFailed>()(
  "V1ImportStepFailed",
  { step: Schema.String, failure: Schema.String },
) {}

/** A durable wait, kept by the host across restarts. */
export type V1ImportSleep<S> = (name: string, seconds: number) => Effect.Effect<void, never, S>;

/** One durable step in its own scope, retried by its host. `S` is what the host's steps need. */
export type V1ImportStep<S> = <A, R>(
  name: string,
  work: Effect.Effect<A, unknown, R>,
) => Effect.Effect<A, V1ImportStepFailed, Exclude<R, Scope.Scope> | S>;

/**
 * Storage and transport failures retry the step, as do builds that ran out of memory or whose
 * compiler did not answer, and source operations Git storage could not complete, which say nothing
 * about the source. Anything v2 refuses fails the item.
 */
const transient = (error: unknown) =>
  Predicate.isTagged(error, "StorageError") ||
  Predicate.isTagged(error, "AuthenticationUnavailable") ||
  Predicate.isTagged(error, "CredentialsError") ||
  Predicate.isTagged(error, "V1ImportUnavailable") ||
  Predicate.isTagged(error, "BuildMemoryExceeded") ||
  Predicate.isTagged(error, "BuildUnanswered") ||
  // Git storage that could not complete an operation says nothing about the source either.
  (Predicate.isTagged(error, "SourceError") &&
    Predicate.hasProperty(error, "reason") &&
    (error.reason === "git" || error.reason === "storage"));

const refusal = (error: unknown) =>
  error instanceof ItemFailed
    ? error.reason
    : error instanceof V1ImportUnreadable
      ? unreadableReason(error)
      : `Executor v2 refused it (${Predicate.hasProperty(error, "_tag") ? String(error._tag) : "error"}).`;

/**
 * An item's result for a refusal: skipped when v1 cannot run it either (stale), otherwise failed,
 * which blocks the organization.
 */
const refusalOutcome = (error: unknown): Pick<Outcome, "status" | "reason" | "stale"> =>
  error instanceof ItemFailed && error.stale !== undefined
    ? { status: "skipped", reason: clip(error.reason), stale: error.stale }
    : { status: "failed", reason: clip(refusal(error)) };

/**
 * A connection's result for a refusal. One that v2 cannot take as v1 kept it moves without its
 * account, for its owner to connect again in v2 (`reconnect`), and does not block the
 * organization. An outage, a Vault that did not answer, an integration that did not move and a
 * first-party client this deployment does not hold as v1's (`firstParty`) are failures, which
 * block it: trying again, or configuring the client, can move the connection with its account.
 */
const connectionRefusal = (
  error: unknown,
  firstParty: FirstPartyMismatch | undefined,
): Pick<Outcome, "status" | "reason" | "stale" | "reconnect"> => {
  const decided = refusalOutcome(error);
  return decided.status === "failed" &&
    firstParty === undefined &&
    error instanceof ItemFailed &&
    error.outage === undefined &&
    error.vault !== "unavailable" &&
    error.reason !== integrationNotImported
    ? { status: "skipped", reason: decided.reason, reconnect: true }
    : decided;
};

/** A rule that matches no tool v1 lists: it still moves, is reported, and does not block. */
const unmatchedRule = (row: { readonly pattern: string; readonly action: string }) =>
  ({
    note: noToolMatches,
    unmatched: { pattern: row.pattern, action: row.action },
    stale: "unmatched_rule",
  }) as const;

/**
 * A step's work that ends with `onUnreadable`'s result when v1 returned rows the import cannot
 * read: another attempt reads the same, so the step does not retry it.
 */
const unlessUnreadable =
  <B>(onUnreadable: (reason: string) => B) =>
  <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A | B, E, R> =>
    work.pipe(
      Effect.catch((error) =>
        error instanceof V1ImportUnreadable
          ? Effect.succeed(onUnreadable(unreadableReason(error)))
          : Effect.fail(error),
      ),
    );

/** Long build errors are cut so a step result stays small. */
const clip = (text: string) => (text.length > 2000 ? `${text.slice(0, 2000)}…` : text);

// ---------------------------------------------------------------------------------------------
// Assessment: who and what moves.

/** The item ids of each kind, in the order they move. */
interface ItemKeys {
  readonly integrations: readonly string[];
  readonly connections: readonly string[];
  readonly policies: readonly string[];
  readonly toolkits: readonly string[];
  readonly artifacts: readonly string[];
}

/**
 * What the assessment decided. It is a step result, which Workflows keep, so it names members by
 * WorkOS id only; the steps that need an email or a name read it again.
 */
interface Assessment {
  readonly status: "ready" | "held_back" | "failed";
  readonly reason: string | null;
  readonly billing: V1Billing | null;
  readonly members: readonly PlannedMember[];
  readonly skippedMembers: readonly SkippedMember[];
  readonly organization: { readonly name: string; readonly slug: string } | null;
  readonly sso: boolean | null;
  /** The organization's own API keys, and the WorkOS id of the owner they act as. */
  readonly apiKeys:
    | { readonly read: false }
    | {
        readonly read: true;
        readonly keys: ReadonlyArray<{ readonly id: string; readonly name: string | null }>;
        readonly owner: string | null;
      };
  /** Members whose email an existing v2 user has, by WorkOS id. */
  readonly emailMatches: ReadonlyArray<{
    readonly user: string;
    readonly match: Exclude<UserMatch["kind"], "create">;
  }>;
  readonly slug: V1OrgReport["slug"];
  readonly v1Counts: Readonly<Record<string, number>>;
  readonly items: ItemKeys;
}

const noItems: ItemKeys = {
  integrations: [],
  connections: [],
  policies: [],
  toolkits: [],
  artifacts: [],
};

/** An organization that could not be assessed or imported, with why. */
const failedAssessment = (reason: string): Assessment => ({
  status: "failed",
  reason,
  billing: null,
  members: [],
  skippedMembers: [],
  organization: null,
  sso: null,
  apiKeys: { read: false },
  emailMatches: [],
  slug: null,
  v1Counts: {},
  items: noItems,
});

const subjectsOf = (members: readonly PlannedMember[]) => {
  const [first, ...rest] = members.map((member) => member.user);
  return first === undefined ? undefined : ([first, ...rest] as const);
};

/**
 * The step's one view of v1, and the organization's rows the members it moves can see, of the
 * tables the step uses.
 */
const openStep = <T extends V1SnapshotTable>(
  organization: string,
  members: readonly PlannedMember[],
  tables: readonly T[],
) =>
  Effect.gen(function* () {
    const environment = yield* V1ImportEnvironment;
    const source = yield* environment.source;
    const subjects = subjectsOf(members);
    if (subjects === undefined) return yield* new V1ImportUnavailable();
    const snapshot = yield* source.snapshot(organization, subjects, members.length > 1, tables);
    return { source, snapshot };
  });

/**
 * The v2 slugs the organization tries (`slugCandidates`). Its unsuffixed slug is left to another
 * live v1 organization whose slug is exactly that: one whose own slug differs from it, or the
 * older of two that both have it.
 */
const slugPlan = (source: V1Source, organization: string, slug: string) =>
  Effect.gen(function* () {
    const environment = yield* V1ImportEnvironment;
    const base = slugBase(slug);
    const holders = yield* source.slugHolders(organization, base);
    const reserved = holders.some((holder) => slug !== base || holder < organization);
    return yield* slugCandidates(yield* environment.slugKey, organization, slug, reserved);
  });

/**
 * Read the organization's members, plan and rows, and decide whether it moves now. Enterprise
 * organizations move by hand (decision 15). An import also holds back paid organizations, which
 * move with their subscription once the billing mapping exists (decision 5).
 */
const assess = (params: V1ImportParams) =>
  Effect.gen(function* () {
    const environment = yield* V1ImportEnvironment;
    const source = yield* environment.source;
    const sql = yield* Effect.flatten(V1ImportDatabase);
    const organization = params.v1OrgId;
    const memberships = yield* source.members(organization);
    const active = memberships.filter((membership) => membership.status === "active");
    const users = new Map(
      yield* Effect.forEach(
        active,
        (membership) =>
          source.user(membership.user).pipe(Effect.map((user) => [membership.user, user] as const)),
        { concurrency: 4 },
      ),
    );
    const billing = v1Billing(yield* source.plans(organization));
    const sso = Option.getOrNull(yield* Effect.option(source.sso(organization)));
    const planned = planMembers(memberships, users);
    const base = {
      billing,
      sso,
      skippedMembers: planned.skipped,
      apiKeys: { read: false } as const,
      emailMatches: [],
      slug: null,
      v1Counts: {
        members: active.length,
        pendingMembers: memberships.filter((membership) => membership.status === "pending").length,
        inactiveMembers: memberships.filter((membership) => membership.status === "inactive")
          .length,
      },
      items: noItems,
    };
    if (!planned.ok)
      return {
        ...base,
        status: "failed",
        reason: planned.reason,
        members: [],
        organization: null,
      } satisfies Assessment;
    const members = planned.members;
    const subjects = subjectsOf(members);
    if (subjects === undefined) return yield* new V1ImportUnavailable();
    const snapshot = yield* source.snapshot(
      organization,
      subjects,
      members.length > 1,
      allSnapshotTables,
    );
    const artifacts = yield* source.artifactSummaries(organization, subjects);
    const owner = members[0];
    const keys = yield* Effect.option(source.apiKeys(organization));
    const matches = yield* Effect.forEach(members, (member) => {
      const user = users.get(member.user);
      if (user === undefined) return Effect.fail(new V1ImportUnavailable());
      return matchUser(sql, memberProfile(user).email).pipe(
        Effect.map((match) => ({ user: member.user, match })),
      );
    });
    // An organization an earlier run imported keeps that organization and its slug.
    const store = makeImportStore(sql);
    const recorded = yield* store.find("organization", organization);
    const copy =
      recorded?.status === "imported" && recorded.v2_id !== null
        ? yield* store.target(recorded.v2_id)
        : undefined;
    const slug =
      copy === undefined
        ? yield* plannedSlug(
            sql,
            yield* slugPlan(source, organization, snapshot.organization.slug),
            snapshot.organization.slug,
          )
        : { slug: copy.slug, changed: copy.slug !== snapshot.organization.slug };
    const held =
      billing.kind === "enterprise"
        ? "Enterprise organizations move by hand, after their v2 SSO is set up."
        : billing.kind === "paid" && params.mode === "import"
          ? "Paid organizations move with their subscription once the billing mapping is built."
          : null;
    return {
      ...base,
      status: held === null ? "ready" : "held_back",
      reason: held,
      members,
      organization: snapshot.organization,
      apiKeys: Option.match(keys, {
        onNone: () => ({ read: false as const }),
        onSome: (found) => ({
          read: true as const,
          keys: found.map((key) => ({ id: key.id, name: key.name })),
          owner: found.length === 0 ? null : owner.user,
        }),
      }),
      emailMatches: matches.flatMap(({ user, match }) =>
        match.kind === "create" ? [] : [{ user, match: match.kind }],
      ),
      slug: { v1: snapshot.organization.slug, v2: slug.slug, changed: slug.changed },
      v1Counts: {
        ...base.v1Counts,
        importedMembers: members.length,
        integrations: snapshot.integrations.length,
        connections: snapshot.connections.length,
        oauthClients: snapshot.clients.length,
        policies: snapshot.policies.length,
        toolkits: snapshot.toolkits.length,
        artifacts: artifacts.length,
      },
      items: {
        integrations: snapshot.integrations.map((row) => row.row_id),
        connections: snapshot.connections.map((row) => row.row_id),
        policies: snapshot.policies.map((row) => row.row_id),
        toolkits: snapshot.toolkits.map((row) => row.row_id),
        artifacts: artifacts.map((row) => row.row_id),
      },
    } satisfies Assessment;
  });

// ---------------------------------------------------------------------------------------------
// Item outcomes, shared by both modes.

/** What one item did or would do. Dry-run details feed the report's lists. */
interface Outcome {
  readonly kind: "integration" | "connection" | "tool_policy" | "toolkit" | "artifact";
  readonly id: string;
  readonly label: string;
  /** The integration of a connection, by label. */
  readonly context: string | null;
  readonly status: "imported" | "planned" | "failed" | "skipped";
  readonly reason?: string | undefined;
  readonly note?: string | undefined;
  readonly v2Id?: string | undefined;
  readonly needsRepair?: true | undefined;
  readonly traced?: readonly string[] | undefined;
  /** v1 tools an integration's app leaves out because v1 could not run them either. */
  readonly staleTools?: readonly StaleTool[] | undefined;
  /** Fixed credentials an integration's app leaves out (decision 22). */
  readonly droppedCredentials?: readonly DroppedFixed[] | undefined;
  /**
   * The accounts a dry run's build of an integration's app takes, which its connections' accounts
   * are checked against as an import would save them. Provider definitions only, no secret.
   */
  readonly accounts?: AppAccountRequirements | undefined;
  /**
   * An org connection whose user-scoped secret members hold with different values: how many hold
   * it and how many distinct values (decision 23).
   */
  readonly memberSecrets?: { readonly members: number; readonly values: number } | undefined;
  /** A connection whose secret v1's Vault did not return: missing, or unavailable. */
  readonly vaultFailed?: "missing" | "unavailable" | undefined;
  /** A connection that signed in through a first-party client v2 does not offer as v1's. */
  readonly firstParty?: FirstPartyMismatch | undefined;
  /** A connection that moves without its account, for its owner to connect again in v2. */
  readonly reconnect?: true | undefined;
  readonly unmatched?: { readonly pattern: string; readonly action: string } | undefined;
  /**
   * Why v1 cannot run it either (decision 20): a skipped item, or a policy that matches no tool,
   * which still moves. Neither blocks the organization.
   */
  readonly stale?: V1StaleCategory | undefined;
  /** The stale integration a skipped rule goes with, by label. */
  readonly staleIntegration?: string | undefined;
  readonly unmappedRoles?: ReadonlyArray<{ readonly role: string; readonly problem: string }>;
  /** Scoped MCP connections a toolkit makes or would make, one per member copy. */
  readonly copies?: number | undefined;
}

const firstPartyName = (row: ConnectionRow) =>
  row.oauth_client?.startsWith(firstPartyClientPrefix) === true
    ? row.oauth_client.slice(firstPartyClientPrefix.length)
    : undefined;

/**
 * Why a v1 first-party client's grants cannot move to v2's client of the same name: v2 does not
 * offer it, it is not v1's client (its client ID differs), or v1's client ID is not configured
 * here, so nobody can tell. Copied refresh tokens are valid only for v1's client (decision 2).
 */
interface FirstPartyMismatch {
  readonly client: string;
  readonly reason: "unavailable" | "different_client" | "v1_unknown";
}

/**
 * The v2 clients v1's first-party connections move to: only one that is v1's own client, with
 * v1's client ID. Any other is a mismatch the report lists, and its connections cannot move.
 */
export const firstPartyClients = (executor: Executor, v1: Readonly<Record<string, string>>) => {
  const offered = (name: string) => executor[OAuthGrantImport].firstPartyClient(name);
  const mismatch = (name: string): FirstPartyMismatch | undefined => {
    const client = offered(name);
    if (client === undefined) return { client: name, reason: "unavailable" };
    const expected = Object.hasOwn(v1, name) ? v1[name] : undefined;
    if (expected === undefined) return { client: name, reason: "v1_unknown" };
    return client.clientId === expected ? undefined : { client: name, reason: "different_client" };
  };
  const lookup: FirstPartyClients = (name) =>
    mismatch(name) === undefined ? offered(name) : undefined;
  /** The mismatch a connection signed in with, if any. */
  const mismatchOf = (row: ConnectionRow) => {
    const name = firstPartyName(row);
    return name === undefined ? undefined : mismatch(name);
  };
  return { lookup, mismatchOf };
};

/** What a policy does: nothing for a rule v1 never applied, or a member's `approve` when shared. */
const policyDecision = (
  snapshot: Pick<V1Snapshot, "integrations" | "multiMember">,
  row: V1Snapshot["policies"][number],
):
  | { readonly kind: "skip"; readonly reason: string }
  | { readonly kind: "move"; readonly integrations: readonly string[] } => {
  const planned = policyPlan(snapshot, row);
  if (planned.status === "skipped") return { kind: "skip", reason: planned.reason };
  if (snapshot.multiMember && row.owner === "user" && row.action === "approve")
    return { kind: "skip", reason: personalApproveDropped };
  return {
    kind: "move",
    integrations: planned.integrations.map((integration) => integration.row_id),
  };
};

/**
 * The v1 tools of each integration that its v2 app leaves out, by integration row id: TRACE
 * operations' tools (decision 16) and stale tools (decision 21), from each integration's outcome.
 */
type DroppedTools = ReadonlyMap<string, ReadonlySet<string>>;

const droppedTools = (outcomes: readonly Outcome[]): DroppedTools =>
  new Map(
    outcomes.flatMap((outcome) =>
      outcome.kind === "integration" &&
      (outcome.traced !== undefined || outcome.staleTools !== undefined)
        ? [
            [
              outcome.id,
              new Set([
                ...(outcome.traced ?? []),
                ...(outcome.staleTools ?? []).map((tool) => tool.tool),
              ]),
            ] as const,
          ]
        : [],
    ),
  );

/** Integrations skipped as stale, by row id: their label and why. */
type StaleIntegrations = ReadonlyMap<
  string,
  { readonly label: string; readonly category: V1StaleCategory }
>;

const staleIntegrations = (outcomes: readonly Outcome[]): StaleIntegrations =>
  new Map(
    outcomes.flatMap((outcome) =>
      outcome.kind === "integration" && outcome.status === "skipped" && outcome.stale !== undefined
        ? [[outcome.id, { label: outcome.label, category: outcome.stale }] as const]
        : [],
    ),
  );

/** Why a connection or rule of a stale integration is skipped with it. */
const integrationSkipped = "Its integration is skipped: v1 cannot run it either.";

/** The stale integration a connection belongs to, if its integration was skipped as stale. */
const staleIntegrationOf = (
  snapshot: Pick<V1Snapshot, "integrations">,
  stale: StaleIntegrations,
  row: Pick<ConnectionRow, "integration">,
) => {
  const integration = snapshot.integrations.find((candidate) => candidate.slug === row.integration);
  return integration === undefined ? undefined : stale.get(integration.row_id);
};

/** The stale integration a rule is skipped with: every integration it applies to is stale. */
const staleRuleIntegration = (stale: StaleIntegrations, integrations: readonly string[]) => {
  const skipped = integrations.map((integration) => stale.get(integration));
  return skipped.length > 0 && skipped.every((found) => found !== undefined)
    ? skipped[0]
    : undefined;
};

/** An item skipped with its stale integration. */
const skippedWith = (
  base: Pick<Outcome, "kind" | "id" | "label" | "context">,
  integration: { readonly label: string; readonly category: V1StaleCategory },
): Outcome => ({
  ...base,
  status: "skipped",
  reason: integrationSkipped,
  stale: integration.category,
  staleIntegration: integration.label,
});

/**
 * Whether a policy matches any tool its integrations' v2 apps have: a tool v1 last listed that the
 * app keeps after rewriting. An MCP tool v1 listed without the server's own name is not generated,
 * and a dropped TRACE tool is left out.
 */
const policyMatches = (
  source: V1Source,
  snapshot: Pick<V1Snapshot, "tenant" | "subjects" | "integrations">,
  pattern: string,
  dropped: DroppedTools,
) =>
  Effect.gen(function* () {
    const first = pattern.split(".")[0];
    for (const integration of snapshot.integrations)
      if (first === "*" || integration.slug === first) {
        const left = dropped.get(integration.row_id);
        const tools = yield* source.tools(snapshot.tenant, snapshot.subjects, integration.slug);
        if (
          tools.some(
            (tool) =>
              (integration.plugin_id !== "mcp" || tool.upstream !== null) &&
              left?.has(tool.name) !== true &&
              matchPattern(
                pattern,
                `${integration.slug}.${tool.owner}.${tool.connection}.${tool.name}`,
              ),
          )
        )
          return true;
      }
    return false;
  });

// ---------------------------------------------------------------------------------------------
// Dry run: decide every item, write nothing.

/**
 * What an import would find in the map, decided from v1's rows: an integration's app when it can
 * be generated, a connection's account when it can be imported. The ids name nothing in v2.
 */
const plannedLookup = (
  snapshot: Pick<V1Snapshot, "integrations" | "clients">,
  firstParty: FirstPartyClients,
): ImportedLookup => ({
  app: (integration) =>
    Effect.succeed(
      integrationPlan(integration).ok ? `app_planned_${integration.row_id}` : undefined,
    ),
  connection: (connection) =>
    Effect.succeed(
      connectionPlan(snapshot, firstParty, connection).ok
        ? {
            target: connectionTarget(
              connection,
              AccountId.make(`acc_planned_${connection.row_id}`),
            ),
            account: `acc_planned_${connection.row_id}`,
          }
        : undefined,
    ),
});

const dryContext = <T extends V1SnapshotTable>(
  assessment: Assessment,
  organization: string,
  tables: readonly T[],
) =>
  Effect.gen(function* () {
    const environment = yield* V1ImportEnvironment;
    const { source, snapshot } = yield* openStep(organization, assessment.members, tables);
    const executor = yield* Effect.flatten(HostedExecutor);
    const clients = firstPartyClients(executor, environment.v1FirstPartyClients);
    return {
      source,
      snapshot,
      executor,
      firstParty: clients.lookup,
      mismatchOf: clients.mismatchOf,
    };
  });

const dryIntegration = (assessment: Assessment, organization: string, id: string) =>
  Effect.gen(function* () {
    const { source, snapshot, executor, firstParty } = yield* dryContext(
      assessment,
      organization,
      allSnapshotTables,
    );
    const row = snapshot.integrations.find((candidate) => candidate.row_id === id);
    if (row === undefined)
      return {
        kind: "integration",
        id,
        label: id,
        context: null,
        status: "skipped",
        reason: "It no longer exists in v1.",
      } satisfies Outcome;
    const label = integrationLabel(row);
    return yield* checkIntegration(
      {
        executor,
        snapshot,
        source,
        firstParty,
        owner: OwnerId.make(`v1:${organization}`),
        slug: assessment.slug?.v2 ?? snapshot.organization.slug,
      },
      row,
    ).pipe(
      Effect.flatMap((checked) => {
        const outcome: Outcome = {
          kind: "integration",
          id,
          label,
          context: null,
          status: "planned",
          note: checked.note,
          traced: checked.traced,
          staleTools: checked.stale,
          droppedCredentials: checked.dropped,
          accounts: checked.accounts,
        };
        // As an import's `withFixedAccount`: a refused fixed account fails the integration, whose
        // app its connections still get.
        return checkFixedAccount(
          { executor, snapshot, source, firstParty },
          row,
          checked.accounts,
        ).pipe(
          Effect.as(outcome),
          Effect.catch((error) =>
            transient(error)
              ? Effect.fail(error)
              : Effect.succeed<Outcome>({
                  ...outcome,
                  status: "failed",
                  reason: clip(refusal(error)),
                }),
          ),
        );
      }),
      Effect.catch((error) =>
        transient(error)
          ? Effect.fail(error)
          : Effect.succeed<Outcome>({
              kind: "integration",
              id,
              label,
              context: null,
              ...refusalOutcome(error),
            }),
      ),
    );
  });

/**
 * The apps a dry run built, by integration row id: the accounts each takes. An integration that
 * did not build has none, as an import would have imported no app for it.
 */
const builtApps = (outcomes: readonly Outcome[]): ReadonlyMap<string, AppAccountRequirements> =>
  new Map(
    outcomes.flatMap((outcome) =>
      outcome.kind === "integration" && outcome.accounts !== undefined
        ? [[outcome.id, outcome.accounts] as const]
        : [],
    ),
  );

/**
 * Decide each connection as `importConnectionItem` would, writing nothing: its plan, its app, and
 * the account `importAccount` would save, checked against its app's build (`checkAccount`), so
 * every account an import would refuse is refused here with the same reason. Each secret the
 * import reads is read too and kept nowhere; an org connection's secret a member saved is read in
 * every member's partition, to report members who hold different values, compared in memory.
 */
const dryConnections = (
  assessment: Assessment,
  organization: string,
  ids: readonly string[],
  stale: StaleIntegrations,
  apps: ReadonlyMap<string, AppAccountRequirements>,
) =>
  Effect.gen(function* () {
    const { source, snapshot, executor, firstParty, mismatchOf } = yield* dryContext(
      assessment,
      organization,
      ["integrations", "connections", "clients"],
    );
    return yield* Effect.forEach(ids, (id) =>
      Effect.gen(function* () {
        const row = snapshot.connections.find((candidate) => candidate.row_id === id);
        if (row === undefined)
          return {
            kind: "connection",
            id,
            label: id,
            context: null,
            status: "skipped",
            reason: "It no longer exists in v1.",
          } satisfies Outcome;
        const integration = snapshot.integrations.find(
          (candidate) => candidate.slug === row.integration,
        );
        const context = integration === undefined ? row.integration : integrationLabel(integration);
        const base = { kind: "connection", id, label: row.name, context } as const;
        const skipped = staleIntegrationOf(snapshot, stale, row);
        if (skipped !== undefined) return skippedWith(base, skipped);
        const plan = connectionPlan(snapshot, firstParty, row);
        if (!plan.ok)
          return plan.stale === null
            ? ({
                ...base,
                ...connectionRefusal(new ItemFailed({ reason: plan.reason }), mismatchOf(row)),
                firstParty: mismatchOf(row),
              } satisfies Outcome)
            : ({
                ...base,
                status: "skipped",
                reason: plan.reason,
                stale: plan.stale,
              } satisfies Outcome);
        const accounts = integration === undefined ? undefined : apps.get(integration.row_id);
        if (accounts === undefined)
          return { ...base, status: "failed", reason: integrationNotImported } satisfies Outcome;
        if (needsNoAccount(plan.value, accounts))
          return { ...base, status: "planned" } satisfies Outcome;
        const differing: Array<{ readonly members: number; readonly values: number }> = [];
        const refusedBy = yield* checkAccount(
          { executor, source, snapshot, firstParty, owner: OwnerId.make(`v1:${organization}`) },
          plan.value,
          accounts,
          (item) =>
            readSecretCompared({ source, snapshot }, row, item).pipe(
              Effect.map((read) => {
                if (read.values > 1) differing.push({ members: read.holders, values: read.values });
                return read.value;
              }),
            ),
        ).pipe(
          Effect.as(undefined),
          Effect.catch((error) => (transient(error) ? Effect.fail(error) : Effect.succeed(error))),
        );
        if (refusedBy !== undefined)
          return {
            ...base,
            ...connectionRefusal(refusedBy, undefined),
            ...(refusedBy instanceof ItemFailed && refusedBy.vault !== undefined
              ? { vaultFailed: refusedBy.vault }
              : {}),
          } satisfies Outcome;
        return {
          ...base,
          status: "planned",
          ...(differing.length === 0
            ? {}
            : {
                memberSecrets: {
                  members: Math.max(...differing.map((entry) => entry.members)),
                  values: Math.max(...differing.map((entry) => entry.values)),
                },
              }),
        } satisfies Outcome;
      }),
    );
  });

const dryPolicies = (
  assessment: Assessment,
  organization: string,
  dropped: DroppedTools,
  stale: StaleIntegrations,
) =>
  Effect.gen(function* () {
    const { source, snapshot } = yield* dryContext(assessment, organization, [
      "integrations",
      "policies",
    ]);
    return yield* Effect.forEach(snapshot.policies, (row) =>
      Effect.gen(function* () {
        const decided = policyDecision(snapshot, row);
        const base = {
          kind: "tool_policy",
          id: row.row_id,
          label: row.pattern,
          context: row.action,
        } as const;
        if (decided.kind === "skip")
          return { ...base, status: "skipped", reason: decided.reason } satisfies Outcome;
        const skipped = staleRuleIntegration(stale, decided.integrations);
        if (skipped !== undefined) return skippedWith(base, skipped);
        const matches = yield* policyMatches(source, snapshot, row.pattern, dropped);
        return {
          ...base,
          status: "planned",
          ...(matches ? {} : unmatchedRule(row)),
        } satisfies Outcome;
      }),
    );
  });

const dryToolkits = (assessment: Assessment, organization: string) =>
  Effect.gen(function* () {
    const { source, snapshot, firstParty } = yield* dryContext(
      assessment,
      organization,
      allSnapshotTables,
    );
    const lookup = plannedLookup(snapshot, firstParty);
    return yield* Effect.forEach(snapshot.toolkits, (row) =>
      Effect.gen(function* () {
        const toolkit = decodeToolkit(row, snapshot.toolkitRules);
        if (toolkit === undefined)
          return {
            kind: "toolkit",
            id: row.row_id,
            label: row.key,
            context: null,
            status: "failed",
            reason: "Its toolkit could not be read.",
          } satisfies Outcome;
        const members = toolkitMembers(toolkit, snapshot.subjects);
        // Plan each member's copy as an import would.
        yield* Effect.forEach(members, (member) =>
          toolkitPolicy({ snapshot, source }, lookup, toolkit, member),
        );
        return {
          kind: "toolkit",
          id: row.row_id,
          label: toolkit.data.name,
          context: null,
          status: "planned",
          copies: members.length,
        } satisfies Outcome;
      }),
    );
  });

/** The artifacts with their code, which only these steps read. */
const artifactRows = (
  source: V1Source,
  snapshot: Pick<V1Snapshot, "tenant" | "subjects">,
  ids: readonly string[],
) => {
  const [first, ...rest] = ids;
  return first === undefined
    ? Effect.succeed([])
    : source.artifacts(snapshot.tenant, snapshot.subjects, [first, ...rest]);
};

const dryArtifacts = (assessment: Assessment, organization: string) =>
  Effect.gen(function* () {
    const { source, snapshot, firstParty } = yield* dryContext(assessment, organization, [
      "integrations",
      "connections",
      "clients",
    ]);
    const lookup = plannedLookup(snapshot, firstParty);
    const rows = yield* artifactRows(source, snapshot, assessment.items.artifacts);
    return yield* Effect.forEach(rows, (row) =>
      artifactMapping(snapshot, lookup, row).pipe(
        Effect.map((mapping): Outcome => ({
          kind: "artifact",
          id: row.row_id,
          label: row.title,
          context: null,
          status: "planned",
          needsRepair: true,
          unmappedRoles: mapping.roles.flatMap((role) =>
            role.problem === null ? [] : [{ role: role.role, problem: role.problem }],
          ),
        })),
      ),
    );
  });

// ---------------------------------------------------------------------------------------------
// Import: write v2, recording every resource in the import map.

interface Identity {
  readonly target: { readonly id: string; readonly slug: string };
  readonly owner: string;
  /** WorkOS user id to v2 user id, for every imported member. */
  readonly users: ReadonlyArray<readonly [string, string]>;
}

/**
 * Users, the organization and memberships, in that order. Each is recorded as it is written. A
 * member who can be neither merged nor added fails the organization, without retrying.
 */
const importIdentity = (params: V1ImportParams, assessment: Assessment) =>
  writeIdentity(params, assessment).pipe(
    Effect.map((identity) => ({ ok: true as const, identity })),
    Effect.catchTag("ItemFailed", (error) =>
      Effect.succeed({ ok: false as const, reason: error.reason }),
    ),
  );

const writeIdentity = (params: V1ImportParams, assessment: Assessment) =>
  Effect.gen(function* () {
    const environment = yield* V1ImportEnvironment;
    const source = yield* environment.source;
    const sql = yield* Effect.flatten(V1ImportDatabase);
    const store = makeImportStore(sql);
    const organization = params.v1OrgId;
    const [owner, ...others] = assessment.members;
    if (owner === undefined || assessment.organization === null)
      return yield* new V1ImportUnavailable();
    const users: Array<readonly [string, string]> = [];
    // Emails and names are read again here rather than kept in the assessment.
    for (const member of assessment.members) {
      const profile = memberProfile(yield* source.user(member.user));
      users.push([member.user, yield* importUser(sql, store, organization, member, profile)]);
    }
    const ownerUser = users[0]?.[1];
    if (ownerUser === undefined) return yield* new V1ImportUnavailable();
    const target = yield* importOrganization(sql, store, {
      organization,
      owner: ownerUser,
      name: assessment.organization.name,
      slug: assessment.organization.slug,
      candidates: yield* slugPlan(source, organization, assessment.organization.slug),
    });
    for (const [index, member] of others.entries()) {
      const user = users[index + 1]?.[1];
      if (user === undefined) return yield* new V1ImportUnavailable();
      yield* importMembership(sql, store, { organization, target: target.id, member, user });
    }
    return {
      target: { id: target.id, slug: target.slug },
      owner: ownerUser,
      users,
    } satisfies Identity;
  });

const importContext = (params: V1ImportParams, assessment: Assessment, identity: Identity) =>
  Effect.gen(function* () {
    const environment = yield* V1ImportEnvironment;
    const { source, snapshot } = yield* openStep(
      params.v1OrgId,
      assessment.members,
      allSnapshotTables,
    );
    const executor: Executor = yield* Effect.flatten(HostedExecutor);
    const sql = yield* Effect.flatten(V1ImportDatabase);
    const clients = firstPartyClients(executor, environment.v1FirstPartyClients);
    const context = {
      executor,
      connections: environment.connections,
      store: makeImportStore(sql),
      sql,
      source,
      snapshot,
      target: { id: identity.target.id as OrganizationId, slug: identity.target.slug },
      owner: identity.owner,
      users: new Map(identity.users),
      firstParty: clients.lookup,
    } satisfies ItemContext;
    return { ...context, mismatchOf: clients.mismatchOf };
  });

/** An import step's context: the items' own, and the first-party clients that do not match. */
type ImportContext = Effect.Success<ReturnType<typeof importContext>>;

const outcomeOf = (
  base: Pick<Outcome, "kind" | "id" | "label" | "context">,
  result: MapResult,
): Outcome =>
  result.status === "imported"
    ? {
        ...base,
        status: "imported",
        v2Id: result.v2Id,
        note: result.note,
        ...(result.v2Kind === undeployedApp ? { needsRepair: true as const } : {}),
      }
    : { ...base, status: result.status, reason: result.reason };

/**
 * Record an item's failure unless it is transient, which fails the step so it is retried. The
 * map keeps the reason, so a rerun shows the same result until the item is fixed.
 */
const recorded =
  (context: ItemContext, kind: MapKind, id: string, hash: string) => (result: MapResult) =>
    context.store.record({ organization: context.snapshot.tenant, kind, id, result, hash });

const failedItem =
  (
    context: ItemContext,
    kind: MapKind,
    id: string,
    hash: string,
    base: Pick<Outcome, "kind" | "id" | "label" | "context" | "firstParty">,
  ) =>
  (error: unknown) =>
    Effect.gen(function* () {
      if (transient(error)) return yield* Effect.fail(error);
      const decided: Pick<Outcome, "status" | "reason" | "stale" | "reconnect"> =
        kind === "profile" ? connectionRefusal(error, base.firstParty) : refusalOutcome(error);
      const result: MapResult =
        decided.status === "skipped"
          ? { status: "skipped", reason: decided.reason ?? "" }
          : { status: "failed", reason: refusal(error) };
      yield* recorded(context, kind, id, hash)(result);
      return {
        ...outcomeOf(base, result),
        ...(decided.stale === undefined ? {} : { stale: decided.stale }),
        ...(decided.reconnect === undefined ? {} : { reconnect: decided.reconnect }),
        ...(base.firstParty === undefined || decided.stale !== undefined
          ? {}
          : { firstParty: base.firstParty }),
        ...(error instanceof ItemFailed && error.vault !== undefined
          ? { vaultFailed: error.vault }
          : {}),
      };
    });

const integrationHash = (context: ItemContext, id: string) =>
  Effect.gen(function* () {
    const { snapshot, firstParty } = context;
    const row = snapshot.integrations.find((candidate) => candidate.row_id === id);
    if (row === undefined) return undefined;
    // Policies, toolkits' policies, members and connections' sign-in shape the generated source.
    const hash = yield* sourceHash({
      integration: row,
      policies: snapshot.policies,
      multiMember: snapshot.multiMember,
      toolkits: snapshot.toolkits,
      toolkitRules: snapshot.toolkitRules,
      connections: snapshot.connections
        .filter((connection) => connection.integration === row.slug)
        .map((connection) => [
          connection.row_id,
          connection.owner,
          connection.template,
          connection.oauth_client,
          ...(firstPartyName(connection) === undefined
            ? []
            : [firstParty(firstPartyName(connection) ?? "") !== undefined]),
        ]),
    });
    return { row, hash };
  });

const importIntegrationItem = (context: ItemContext, id: string) =>
  Effect.gen(function* () {
    const found = yield* integrationHash(context, id);
    if (found === undefined)
      return {
        kind: "integration",
        id,
        label: id,
        context: null,
        status: "skipped",
        reason: "It no longer exists in v1.",
      } satisfies Outcome;
    const { row, hash } = found;
    const base = { kind: "integration", id, label: integrationLabel(row), context: null } as const;
    const existing = yield* context.store.find("integration", id);
    const app =
      existing?.status === "imported" && existing.v2_id !== null
        ? AppId.make(existing.v2_id)
        : undefined;
    const since =
      app === undefined ? "kept" : yield* context.store.sinceImported("integration", id);
    // An app its users removed in v2 since stays removed.
    if (since === "removed")
      return { ...base, status: "skipped", reason: removedInV2 } satisfies Outcome;
    if (app !== undefined && (existing?.source_hash === hash || since === "changed"))
      // An earlier attempt may have stopped before the app's fixed account was saved. An app its
      // users deployed again in v2 since stays as they made it.
      return yield* withFixedAccount(
        context,
        row,
        app,
        outcomeOf(base, {
          status: "imported",
          v2Kind: "app",
          v2Id: app,
          ...(since === "changed"
            ? { note: keptInV2 }
            : existing?.reason === null || existing?.reason === undefined
              ? {}
              : { note: existing.reason }),
        }),
      );
    return yield* importIntegration(context, row, app).pipe(
      Effect.tap(({ result }) => recorded(context, "integration", id, hash)(result)),
      Effect.map(({ result, app: deployed, traced, stale, dropped }) => ({
        deployed,
        outcome: {
          ...outcomeOf(base, result),
          traced,
          staleTools: stale,
          droppedCredentials: dropped,
        },
      })),
      Effect.catch(failedItem(context, "integration", id, hash, base)),
      // The app's fixed account, once the app is recorded, so a retry keeps the app.
      Effect.flatMap((done) =>
        "deployed" in done
          ? withFixedAccount(context, row, done.deployed, done.outcome)
          : Effect.succeed(done),
      ),
    );
  });

/**
 * The integration's outcome once its app's fixed account is saved and linked, if it takes one. A
 * refusal fails the integration's outcome without changing its app's map row, so a rerun keeps
 * the app and saves the account again.
 */
const withFixedAccount = (
  context: ItemContext,
  row: IntegrationRow,
  app: AppId,
  outcome: Outcome,
) =>
  importFixedAccount(context, row, app).pipe(
    Effect.as(outcome),
    Effect.catch((error) =>
      transient(error)
        ? Effect.fail(error)
        : Effect.succeed<Outcome>({ ...outcome, status: "failed", reason: clip(refusal(error)) }),
    ),
  );

/**
 * A connection is imported once its account is saved and linked to its app, which its `profile`
 * row records (see `mapLookup`).
 */
const importConnectionItem = (
  context: ImportContext,
  id: string,
  stale: StaleIntegrations,
  tookV1: ReadonlySet<string>,
) =>
  Effect.gen(function* () {
    const { snapshot, store, executor, firstParty } = context;
    const row = snapshot.connections.find((candidate) => candidate.row_id === id);
    if (row === undefined)
      return {
        kind: "connection",
        id,
        label: id,
        context: null,
        status: "skipped",
        reason: "It no longer exists in v1.",
      } satisfies Outcome;
    const integration = snapshot.integrations.find(
      (candidate) => candidate.slug === row.integration,
    );
    const base = {
      kind: "connection",
      id,
      label: row.name,
      context: integration === undefined ? row.integration : integrationLabel(integration),
      firstParty: context.mismatchOf(row),
    } as const;
    const hash = yield* sourceHash(row);
    const skipped = staleIntegrationOf(snapshot, stale, row);
    if (skipped !== undefined) {
      const outcome = skippedWith(base, skipped);
      yield* recorded(
        context,
        "profile",
        id,
        hash,
      )({ status: "skipped", reason: integrationSkipped });
      return outcome;
    }
    const linked = yield* store.find("profile", id);
    if (linked?.status === "imported" && linked.v2_id !== null) {
      const saved = yield* store.find("connection", id);
      const account =
        saved?.status === "imported" && saved.v2_id !== null ? saved.v2_id : undefined;
      // An account its users removed in v2 since stays removed; verification leaves it out.
      if (account !== undefined && (yield* store.sinceImported("connection", id)) === "removed")
        return { ...base, status: "skipped", reason: removedInV2, v2Id: account } satisfies Outcome;
      // An account an earlier run saved took v1's tokens before anything deployed, if they were
      // newer (`refreshCopiedGrants`), and follows its app's provider (`updateCopiedAccount`).
      const updated =
        account === undefined
          ? { tokens: "kept" as const, followed: false }
          : yield* updateCopiedAccount(context, row, AccountId.make(account));
      const notes = [
        ...(updated.tokens === "replaced" || tookV1.has(id) ? [tookV1Note] : []),
        ...(updated.followed ? [followedNote] : []),
      ];
      return outcomeOf(base, {
        status: "imported",
        v2Kind: "account",
        v2Id: linked.v2_kind === "profile" && account !== undefined ? account : linked.v2_id,
        ...(notes.length === 0 ? {} : { note: notes.join(" ") }),
      });
    }
    return yield* Effect.gen(function* () {
      const plan = connectionPlan(snapshot, firstParty, row);
      if (!plan.ok) return yield* refused(plan);
      const appRow =
        integration === undefined
          ? undefined
          : yield* store.find("integration", integration.row_id);
      if (appRow?.status !== "imported" || appRow.v2_id === null)
        return yield* new ItemFailed({ reason: integrationNotImported });
      // The app its users removed in v2 since takes no new connections.
      if (
        integration !== undefined &&
        (yield* store.sinceImported("integration", integration.row_id)) === "removed"
      )
        return { ...base, status: "skipped", reason: removedInV2 } satisfies Outcome;
      const app = yield* executor.apps.get({
        owner: organizationOwner(context.target.id),
        app: AppId.make(appRow.v2_id),
      });
      // A public app needs no account or link.
      if (needsNoAccount(plan.value, app.requirements.accounts)) {
        const result: MapResult = { status: "imported", v2Kind: "app", v2Id: app.id };
        yield* recorded(context, "profile", id, hash)(result);
        return outcomeOf(base, result);
      }
      const accountRow = yield* store.find("connection", id);
      const account =
        accountRow?.status === "imported" && accountRow.v2_id !== null
          ? AccountId.make(accountRow.v2_id)
          : yield* importAccount(
              context,
              plan.value,
              app,
              recorded(context, "connection", id, hash),
            );
      yield* linkConnectionAccount(context, row, app, account);
      const result: MapResult = { status: "imported", v2Kind: "account", v2Id: account };
      yield* recorded(context, "profile", id, hash)(result);
      return outcomeOf(base, result);
    }).pipe(Effect.catch(failedItem(context, "profile", id, hash, base)));
  });

const importPolicyItem = (
  context: ItemContext,
  id: string,
  dropped: DroppedTools,
  stale: StaleIntegrations,
) =>
  Effect.gen(function* () {
    const { snapshot, store } = context;
    const row = snapshot.policies.find((candidate) => candidate.row_id === id);
    if (row === undefined)
      return {
        kind: "tool_policy",
        id,
        label: id,
        context: null,
        status: "skipped",
        reason: "It no longer exists in v1.",
      } satisfies Outcome;
    const base = { kind: "tool_policy", id, label: row.pattern, context: row.action } as const;
    const hash = yield* sourceHash({ row, multiMember: snapshot.multiMember });
    const decided = policyDecision(snapshot, row);
    if (decided.kind === "skip") {
      const result: MapResult = { status: "skipped", reason: decided.reason };
      yield* recorded(context, "tool_policy", id, hash)(result);
      return outcomeOf(base, result);
    }
    const skipped = staleRuleIntegration(stale, decided.integrations);
    if (skipped !== undefined) {
      yield* recorded(
        context,
        "tool_policy",
        id,
        hash,
      )({ status: "skipped", reason: integrationSkipped });
      return skippedWith(base, skipped);
    }
    // The rule is already in each matching app's tools.ts. One that matches none of the tools v1
    // last listed still moves, for tools the server may list again.
    const apps: string[] = [];
    for (const integration of decided.integrations) {
      const found = yield* store.find("integration", integration);
      if (found?.status === "imported" && found.v2_id !== null) apps.push(found.v2_id);
    }
    const matches = yield* policyMatches(context.source, snapshot, row.pattern, dropped);
    const result: MapResult =
      apps[0] === undefined
        ? { status: "failed", reason: integrationNotImported }
        : {
            status: "imported",
            v2Kind: "app",
            v2Id: apps[0],
            ...(matches ? {} : { note: noToolMatches }),
          };
    yield* recorded(context, "tool_policy", id, hash)(result);
    return {
      ...outcomeOf(base, result),
      ...(result.status === "imported" && !matches ? unmatchedRule(row) : {}),
    };
  });

/** Each member's copy of a toolkit is one map row; the toolkit's outcome is its first failure. */
const importToolkitItem = (context: ItemContext, id: string) =>
  Effect.gen(function* () {
    const { snapshot } = context;
    const row = snapshot.toolkits.find((candidate) => candidate.row_id === id);
    if (row === undefined)
      return {
        kind: "toolkit",
        id,
        label: id,
        context: null,
        status: "skipped",
        reason: "It no longer exists in v1.",
      } satisfies Outcome;
    const toolkit = decodeToolkit(row, snapshot.toolkitRules);
    const hash = yield* sourceHash({ row, rules: toolkit });
    if (toolkit === undefined) {
      const base = { kind: "toolkit", id, label: row.key, context: null } as const;
      const result: MapResult = { status: "failed", reason: "Its toolkit could not be read." };
      yield* recorded(context, "toolkit", id, hash)(result);
      return outcomeOf(base, result);
    }
    const base = { kind: "toolkit", id, label: toolkit.data.name, context: null } as const;
    const members = toolkitMembers(toolkit, snapshot.subjects);
    const copies = yield* Effect.forEach(members, (member) => {
      const key = toolkitCopyKey(toolkit, member);
      return Effect.gen(function* () {
        // The opt-in import keyed its one copy by the toolkit alone; a move into its organization
        // records that copy under the member's key instead of making them another.
        const user = context.users.get(member);
        const found = yield* context.store.find("toolkit", key);
        const existing =
          found === undefined &&
          user !== undefined &&
          (yield* context.store.adoptToolkitCopy({
            organization: context.snapshot.tenant,
            toolkit: toolkit.row.row_id,
            member,
            user,
          }))
            ? yield* context.store.find("toolkit", key)
            : found;
        const since =
          existing?.status === "imported" && existing.v2_id !== null
            ? yield* context.store.sinceImported("toolkit", key)
            : "kept";
        // A copy its member removed or changed in v2 since stays as they left it.
        if (since === "removed")
          return { ...base, status: "skipped", reason: removedInV2 } satisfies Outcome;
        if (since === "changed" && existing?.v2_id !== null && existing?.v2_id !== undefined)
          return outcomeOf(base, {
            status: "imported",
            v2Kind: "mcp_connection",
            v2Id: existing.v2_id,
            note: keptInV2,
          });
        // Otherwise its connection follows the apps and accounts imported since; saving it again
        // is safe.
        const copy = existing?.status === "imported" ? existing.v2_id : null;
        return yield* importToolkit(context, toolkit, member, copy ?? undefined).pipe(
          Effect.tap(recorded(context, "toolkit", key, hash)),
          Effect.map((result) => outcomeOf(base, result)),
          Effect.catch(failedItem(context, "toolkit", key, hash, base)),
        );
      });
    });
    const failed = copies.find((copy) => copy.status === "failed");
    const first = copies[0];
    if (failed !== undefined) return { ...failed, copies: copies.length };
    if (first === undefined)
      return {
        ...base,
        status: "skipped",
        reason: "None of its members is imported.",
      } satisfies Outcome;
    return { ...first, copies: copies.length };
  });

const importArtifactItem = (context: ItemContext, id: string) =>
  Effect.gen(function* () {
    const { snapshot, store } = context;
    const [row] = yield* artifactRows(context.source, snapshot, [id]);
    if (row === undefined)
      return {
        kind: "artifact",
        id,
        label: id,
        context: null,
        status: "skipped",
        reason: "It no longer exists in v1.",
      } satisfies Outcome;
    const base = { kind: "artifact", id, label: row.title, context: null } as const;
    const mapping = yield* artifactMapping(snapshot, mapLookup(store), row);
    // Its source and the mapping written into it.
    const hash = yield* sourceHash({ artifact: row, mapping });
    const existing = yield* store.find("artifact", id);
    const since =
      existing?.status === "imported" && existing.v2_id !== null
        ? yield* store.sinceImported("artifact", id)
        : "kept";
    // An app its users removed or deployed again in v2 since stays as they left it.
    if (since === "removed")
      return { ...base, status: "skipped", reason: removedInV2 } satisfies Outcome;
    if (
      existing?.status === "imported" &&
      existing.v2_id !== null &&
      (existing.source_hash === hash || since === "changed")
    )
      return outcomeOf(base, {
        status: "imported",
        v2Kind: existing.v2_kind ?? undeployedApp,
        v2Id: existing.v2_id,
        ...(since === "changed"
          ? { note: keptInV2 }
          : existing.reason === null
            ? {}
            : { note: existing.reason }),
      });
    const app =
      existing?.status === "imported" && existing.v2_id !== null
        ? AppId.make(existing.v2_id)
        : undefined;
    return yield* importArtifact(context, row, mapping, app).pipe(
      Effect.tap(recorded(context, "artifact", id, hash)),
      Effect.map((result) => ({
        ...outcomeOf(base, result),
        unmappedRoles: mapping.roles.flatMap((role) =>
          role.problem === null ? [] : [{ role: role.role, problem: role.problem }],
        ),
      })),
      Effect.catch(failedItem(context, "artifact", id, hash, base)),
    );
  });

/** What the verify step returns: each problem, and the counts when it could count. */
interface Verified {
  readonly problems: readonly string[];
  readonly verification: V1ImportVerification | undefined;
}

const MemberCount = Schema.Array(Schema.Struct({ members: Schema.NumberFromString }));

/**
 * Cutover step 4 (`V1ImportVerification`): every planned item has a result and none failed, every
 * planned member is a member of the v2 organization, every imported account its users have not
 * removed since has credentials that decrypt, and every imported integration's app has an active
 * version. Members its users added in v2 after an earlier run are theirs. Returns the counts and
 * each problem found.
 */
const verify = (
  organization: string,
  context: ItemContext,
  outcomes: readonly Outcome[],
  items: ItemKeys,
  members: readonly PlannedMember[],
) =>
  Effect.gen(function* () {
    const problems: string[] = [];
    const planned = {
      integration: items.integrations.length,
      connection: items.connections.length,
      tool_policy: items.policies.length,
      toolkit: items.toolkits.length,
      artifact: items.artifacts.length,
    } satisfies Record<Outcome["kind"], number>;
    for (const [kind, count] of Object.entries(planned)) {
      const results = outcomes.filter((outcome) => outcome.kind === kind).length;
      if (results !== count) problems.push(`${count - results} ${kind} items have no result.`);
    }
    const failed = outcomes.filter((outcome) => outcome.status === "failed").length;
    if (failed > 0) problems.push(`${failed} items failed.`);

    const plannedUsers = members.flatMap((member) => {
      const user = context.users.get(member.user);
      return user === undefined ? [] : [user];
    });
    const inV2 =
      plannedUsers.length === 0
        ? 0
        : Number(
            (yield* context.sql`
        select count(*)::text as members from member
        where "organizationId" = ${context.target.id} and ${context.sql.in("userId", plannedUsers)}
      `.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(MemberCount)),
              Effect.mapError(() => new V1ImportUnavailable()),
            ))[0]?.members ?? 0,
          );
    const unmapped = members.filter((member) => !context.users.has(member.user)).length;
    if (unmapped > 0) problems.push(`${unmapped} members have no v2 user.`);
    if (inV2 !== members.length)
      problems.push(`The v2 organization has ${inV2} of the ${members.length} planned members.`);

    const removed = new Set(
      outcomes.flatMap((outcome) =>
        outcome.reason === removedInV2 && outcome.v2Id !== undefined ? [outcome.v2Id] : [],
      ),
    );
    // A connection v1 no longer has is not planned; its account is left out too when its users
    // removed it in v2 since an earlier run imported it.
    const plannedConnections = new Set(items.connections);
    const accounts = new Set<string>();
    for (const row of yield* context.store.rows(organization)) {
      if (row.status !== "imported" || row.v2_kind !== "account" || row.v2_id === null) continue;
      if (removed.has(row.v2_id)) continue;
      if (
        (row.v1_kind === "connection" || row.v1_kind === "profile") &&
        !plannedConnections.has(row.v1_id) &&
        (yield* context.store.sinceImported("connection", row.v1_id)) === "removed"
      )
        continue;
      accounts.add(row.v2_id);
    }
    let unreadable = 0;
    for (const account of accounts)
      if (!(yield* context.executor[OAuthGrantImport].credentialsReadable(AccountId.make(account))))
        unreadable++;
    if (unreadable > 0)
      problems.push(`${unreadable} imported accounts' credentials do not decrypt with v2's key.`);

    let apps = 0;
    let withoutVersion = 0;
    for (const outcome of outcomes)
      if (
        outcome.kind === "integration" &&
        outcome.status === "imported" &&
        outcome.v2Id !== undefined
      ) {
        apps++;
        const app = yield* context.executor.apps.get({
          owner: organizationOwner(context.target.id),
          app: AppId.make(outcome.v2Id),
        });
        if (app.activeVersion === null) {
          withoutVersion++;
          problems.push(`${outcome.label} has no active version.`);
        }
      }
    const verification: V1ImportVerification = {
      items: {
        planned: Object.values(planned).reduce((sum, count) => sum + count, 0),
        withResult: outcomes.length,
        failed,
      },
      members: { planned: members.length, inV2 },
      accounts: { checked: accounts.size, unreadable },
      apps: { checked: apps, withoutVersion },
      passed: problems.length === 0,
    };
    return { problems, verification };
  });

// ---------------------------------------------------------------------------------------------
// Report.

/**
 * Whether the organization cannot convert until the importer handles something: a failed item, a
 * first-party mismatch or an email conflict. Stale items (decision 20), skipped or, for rules
 * that match no tool, imported with a note, never block. Email conflicts
 * come from the assessment, so a report written without members' emails still counts them.
 */
const blocking = (report: Omit<V1OrgReport, "status">, assessment: Assessment) =>
  report.integrationFailures.length > 0 ||
  report.connectionFailures.some((failure) => failure.reconnect !== true) ||
  report.firstPartyMismatches.length > 0 ||
  assessment.emailMatches.some((match) => match.match === "conflict");

/** The members' emails the report names, read again from v1's WorkOS by the report's step. */
interface ReportPeople {
  readonly emailMatches: V1OrgReport["emailMatches"];
  /** The email of the owner the organization's API keys act as. */
  readonly actsAs: string | null;
}

const noPeople: ReportPeople = { emailMatches: [], actsAs: null };

const reportPeople = (assessment: Assessment) =>
  Effect.gen(function* () {
    const environment = yield* V1ImportEnvironment;
    const source = yield* environment.source;
    const email = (user: string) =>
      source.user(user).pipe(Effect.map((found) => memberProfile(found).email));
    const emailMatches = yield* Effect.forEach(
      assessment.emailMatches,
      ({ user, match }) => email(user).pipe(Effect.map((found) => ({ email: found, match }))),
      { concurrency: 4 },
    );
    const owner = assessment.apiKeys.read ? assessment.apiKeys.owner : null;
    return {
      emailMatches,
      actsAs: owner === null ? null : yield* email(owner),
    } satisfies ReportPeople;
  });

/** What an import wrote: its problems, its organization, its check and whether it cut over. */
interface Imported {
  readonly problems: readonly string[];
  readonly target: Identity["target"];
  readonly verification?: V1ImportVerification | undefined;
  readonly cutover?: boolean | undefined;
}

const reportOf = (
  params: V1ImportParams,
  assessment: Assessment,
  outcomes: readonly Outcome[],
  imported: Imported | undefined,
  people: ReportPeople,
): V1OrgReport => {
  // Connections that cannot move with their account: failed ones block, the rest move to reconnect.
  const failedConnections = outcomes.filter(
    (outcome) =>
      outcome.kind === "connection" && (outcome.status === "failed" || outcome.reconnect === true),
  );
  const reasons = new Map<string, { reconnect: boolean; outcomes: Outcome[] }>();
  for (const outcome of failedConnections) {
    const reconnect = outcome.reconnect === true;
    const key = JSON.stringify([outcome.reason ?? "", reconnect]);
    reasons.set(key, {
      reconnect,
      outcomes: [...(reasons.get(key)?.outcomes ?? []), outcome],
    });
  }
  const firstParty = new Map<string, { mismatch: FirstPartyMismatch; connections: number }>();
  for (const outcome of outcomes)
    if (outcome.firstParty !== undefined) {
      const key = `${outcome.firstParty.client} ${outcome.firstParty.reason}`;
      const known = firstParty.get(key);
      firstParty.set(key, {
        mismatch: outcome.firstParty,
        connections: (known?.connections ?? 0) + 1,
      });
    }
  const count = (kind: Outcome["kind"], status?: Outcome["status"]) =>
    outcomes.filter(
      (outcome) => outcome.kind === kind && (status === undefined || outcome.status === status),
    ).length;
  const done = params.mode === "import" ? "imported" : "planned";
  // Toolkits and artifacts are never stale: they move with what they can reach. An app that
  // moves can leave stale tools out.
  const staleItems: V1OrgReport["staleItems"] = outcomes.flatMap((outcome) => [
    ...(outcome.status === "skipped" &&
    outcome.stale !== undefined &&
    (outcome.kind === "integration" ||
      outcome.kind === "connection" ||
      outcome.kind === "tool_policy")
      ? [
          {
            kind: outcome.kind,
            id: outcome.id,
            label: outcome.label,
            integration:
              outcome.kind === "connection" ? outcome.context : (outcome.staleIntegration ?? null),
            category: outcome.stale,
            reason: outcome.reason ?? "",
          },
        ]
      : []),
    ...(outcome.kind === "integration" && outcome.status !== "failed"
      ? (outcome.staleTools ?? []).map((tool) => ({
          kind: "tool" as const,
          id: `${outcome.id}/${tool.tool}`,
          label: tool.tool,
          integration: outcome.label,
          category: tool.stale,
          reason: tool.reason,
        }))
      : []),
  ]);
  const members = assessment.members.length;
  const merged = assessment.emailMatches.filter((match) => match.match === "merge").length;
  const body: Omit<V1OrgReport, "status"> = {
    organization: params.v1OrgId,
    runId: params.runId,
    mode: params.mode,
    reason: assessment.reason,
    counts: {
      v1: assessment.v1Counts,
      v2: {
        users: members - merged,
        mergedUsers: merged,
        members,
        apps: count("integration", done),
        accounts: count("connection", done),
        mcpConnections: outcomes
          .filter((outcome) => outcome.kind === "toolkit" && outcome.status === done)
          .reduce((total, outcome) => total + (outcome.copies ?? 0), 0),
        undeployedApps: count("artifact", done),
        policies: count("tool_policy", done),
        skippedPolicies: count("tool_policy", "skipped"),
        staleSkipped: staleItems.length,
      },
    },
    emailMatches: people.emailMatches,
    skippedMembers: assessment.skippedMembers.map((member) => ({
      user: member.user,
      reason: member.reason,
    })),
    slug: assessment.slug,
    integrationFailures: outcomes.flatMap((outcome) =>
      outcome.kind === "integration" && outcome.status === "failed"
        ? [{ id: outcome.id, label: outcome.label, error: outcome.reason ?? "" }]
        : [],
    ),
    droppedTraceTools: outcomes.flatMap((outcome) =>
      outcome.traced !== undefined && outcome.traced.length > 0
        ? [{ integration: outcome.label, tools: outcome.traced }]
        : [],
    ),
    connectionFailures: [...reasons.values()].map(({ reconnect, outcomes: connections }) => ({
      reason: connections[0]?.reason ?? "",
      ...(reconnect ? { reconnect: true as const } : {}),
      connections: connections.map((outcome) => ({
        id: outcome.id,
        label: outcome.label,
        integration: outcome.context ?? "",
      })),
    })),
    firstPartyMismatches: [...firstParty.values()].map(({ mismatch, connections }) => ({
      client: mismatch.client,
      reason: mismatch.reason,
      connections,
    })),
    unmatchedRules: outcomes.flatMap((outcome) =>
      outcome.unmatched === undefined ? [] : [{ id: outcome.id, ...outcome.unmatched }],
    ),
    staleItems,
    droppedCredentials: outcomes.flatMap((outcome) =>
      outcome.kind === "integration" && outcome.status !== "failed"
        ? (outcome.droppedCredentials ?? []).map((entry) => ({
            integration: outcome.label,
            carrier: entry.secret.carrier,
            name: entry.secret.name,
            reason: entry.reason,
          }))
        : [],
    ),
    memberSecretMismatches: outcomes.flatMap((outcome) =>
      outcome.memberSecrets === undefined
        ? []
        : [
            {
              id: outcome.id,
              label: outcome.label,
              integration: outcome.context ?? "",
              ...outcome.memberSecrets,
            },
          ],
    ),
    orgApiKeys: assessment.apiKeys.read
      ? { read: true, keys: assessment.apiKeys.keys, actsAs: people.actsAs }
      : { read: false },
    artifacts: outcomes.flatMap((outcome) =>
      outcome.kind === "artifact"
        ? [{ id: outcome.id, title: outcome.label, unmappedRoles: outcome.unmappedRoles ?? [] }]
        : [],
    ),
    flags: {
      sso: assessment.sso,
      overFreeMemberLimit: assessment.billing?.kind === "free" && members > freeMembers,
      paidPlans:
        assessment.billing === null || assessment.billing.kind === "free"
          ? []
          : assessment.billing.plans,
    },
    vaultFailures: outcomes.flatMap((outcome) =>
      outcome.vaultFailed === undefined
        ? []
        : [
            {
              id: outcome.id,
              label: outcome.label,
              integration: outcome.context ?? "",
              reason: outcome.vaultFailed,
            },
          ],
    ),
    ...(imported === undefined ? {} : { v2Organization: imported.target }),
    ...(imported?.verification === undefined ? {} : { verification: imported.verification }),
    ...(imported?.cutover === undefined ? {} : { cutover: imported.cutover }),
    ...(params.mode === "import"
      ? {
          items: outcomes.map((outcome) => ({
            kind: outcome.kind,
            id: outcome.id,
            label: outcome.label,
            context: outcome.context,
            status: outcome.status === "planned" ? ("skipped" as const) : outcome.status,
            ...(outcome.v2Id === undefined ? {} : { v2Id: outcome.v2Id }),
            ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
            ...(outcome.note === undefined ? {} : { note: outcome.note }),
            ...(outcome.needsRepair === true ? { needsRepair: true as const } : {}),
          })),
        }
      : {}),
  };
  const status: V1OrgOutcome =
    assessment.status === "held_back"
      ? "held_back"
      : assessment.status === "failed"
        ? "failed"
        : imported !== undefined
          ? imported.problems.length === 0
            ? "imported"
            : "failed"
          : blocking(body, assessment)
            ? "blocked"
            : "planned";
  return {
    ...body,
    status,
    reason:
      body.reason ??
      (imported !== undefined && imported.problems.length > 0 ? imported.problems.join(" ") : null),
  };
};

/**
 * The report in R2 and its run marker beside it; for an import, also the organization's state row.
 * Then the organization's in-flight entry is removed, if possible: a start that finds the entry
 * after the marker removes it then. With `keepWritten`, a report an earlier attempt already wrote
 * stays, and the rest is written from it. Returns the status written.
 */
const writeReport = (
  draft: V1OrgReport,
  identity: Identity | undefined,
  keepWritten: boolean,
  state: V1OrgState | undefined,
) =>
  Effect.gen(function* () {
    const environment = yield* V1ImportEnvironment;
    const key = v1ImportReportKey(draft.organization, draft.runId);
    const written = keepWritten
      ? Option.flatMap(yield* environment.reports.get(key), Schema.decodeUnknownOption(V1OrgReport))
      : Option.none<V1OrgReport>();
    const report = Option.isSome(written) ? written.value : draft;
    if (Option.isNone(written)) {
      const encoded = yield* Schema.encodeEffect(V1OrgReport)(report).pipe(
        Effect.mapError(() => new V1ImportUnavailable()),
      );
      yield* environment.reports.put(key, encoded);
    }
    yield* environment.reports.put(`${v1ImportRunPrefix(report.runId)}${report.organization}`, {
      status: report.status,
      mode: report.mode,
    });
    if (report.mode === "import") {
      const sql = yield* Effect.flatten(V1ImportDatabase);
      const summary = { status: report.status, reason: report.reason, counts: report.counts };
      yield* sql`
        insert into private_v1_import_org (v1_org_id, v2_org_id, state, run_id, report, updated_at)
        values (${report.organization}, ${identity?.target.id ?? null}, ${state ?? "failed"},
          ${report.runId}, ${JSON.stringify(summary)}::jsonb, now())
        on conflict (v1_org_id) do update set
          v2_org_id = coalesce(excluded.v2_org_id, private_v1_import_org.v2_org_id),
          state = excluded.state, run_id = excluded.run_id, report = excluded.report,
          updated_at = now()
      `.pipe(Effect.mapError(() => new V1ImportUnavailable()));
    }
    yield* environment.reports
      .remove(v1ImportInFlightKey(report.runId, report.organization))
      .pipe(
        Effect.catch(() =>
          Effect.logWarning("v1 import in-flight entry left for the next start to remove"),
        ),
      );
    return report.status;
  });

// ---------------------------------------------------------------------------------------------
// The freeze and cutover (`moved-flag.ts`).

/**
 * Where an import leaves its organization (`private_v1_import_org.state`): `cutover` once v1
 * forwards it to v2, `rolled_back` when it was unfrozen with nothing copied, and `failed` while it
 * stays frozen in v1 for a person to restart or roll back.
 */
type V1OrgState = "cutover" | "failed" | "rolled_back";

const flagWriter = Effect.gen(function* () {
  const environment = yield* V1ImportEnvironment;
  const flag = movedFlag(environment.writes);
  if (flag === undefined)
    return yield* Effect.die(new Error("This deployment cannot write v1's moved flag."));
  return flag;
});

const OrgState = Schema.Array(Schema.Struct({ state: Schema.String }));

/**
 * Cutover step 2: mark the organization `moving` in v1, which freezes it there, and record it as
 * frozen. An organization that has already cut over is never frozen again, which would take it
 * back from v2: that stops the instance for a person.
 */
const freezeInV1 = (params: V1ImportParams) =>
  Effect.gen(function* () {
    const flag = yield* flagWriter;
    const sql = yield* Effect.flatten(V1ImportDatabase);
    const current = yield* sql`
      select state from private_v1_import_org where v1_org_id = ${params.v1OrgId}
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(OrgState)),
      Effect.mapError(() => new V1ImportUnavailable()),
    );
    if (current[0]?.state === "cutover")
      return yield* Effect.die(
        new Error("This organization has already moved to v2; roll it back before importing it."),
      );
    yield* flag.set(params.v1OrgId, V1MovedState.Moving());
    yield* sql`
      insert into private_v1_import_org (v1_org_id, v2_org_id, state, run_id, report, updated_at)
      values (${params.v1OrgId}, null, 'frozen', ${params.runId}, '{}'::jsonb, now())
      on conflict (v1_org_id) do update set
        state = 'frozen', run_id = excluded.run_id, updated_at = now()
    `.pipe(Effect.mapError(() => new V1ImportUnavailable()));
  });

/** Unfreeze an organization nothing was copied from: v1 serves it as before. */
const releaseInV1 = (organization: string) =>
  Effect.flatMap(flagWriter, (flag) => flag.set(organization, V1MovedState.RolledBack()));

/** Cutover step 5: v1 forwards the organization to v2 and redirects its dashboard there. */
const cutOverInV1 = (organization: string, target: Identity["target"]) =>
  Effect.flatMap(flagWriter, (flag) =>
    flag.set(organization, V1MovedState.Moved({ v2Organization: target.id, v2Slug: target.slug })),
  );

/** What a person must do with an organization that could not be cut over. */
export const notCutOver =
  "It was imported and verified, but v1 could not be told it moved, so it stays frozen in v1.";

// ---------------------------------------------------------------------------------------------
// The run.

/** Connections move a few per step, so a large organization stays within step limits. */
const connectionBatch = 10;

const chunks = <A>(values: readonly A[], size: number) =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, index * size + size),
  );

/** An item that could not be checked or moved, with why. */
const failedOutcome = (kind: Outcome["kind"], id: string, reason: string): Outcome => ({
  kind,
  id,
  label: id,
  context: null,
  status: "failed",
  reason,
});

/**
 * An item whose step still failed after its retries, with the kind of its last failure: a dry
 * run reports it and goes on.
 */
const unavailableOutcome = (kind: Outcome["kind"], id: string, error: V1ImportStepFailed) =>
  failedOutcome(
    kind,
    id,
    `It could not be checked: v1, v2 or the compiler kept failing while it was (${error.failure}).`,
  );

/** Why a report leaves out members' emails: v1's WorkOS did not return them. */
export const reportPeopleUnread =
  "Its members' emails could not be read from v1's WorkOS, so the report leaves out its email matches and the owner its API keys act as.";

/**
 * Move or check one organization. Import mode needs the deployment's write switch and the
 * organization's row in `private_v1_import_allowed` (`writes.ts`), and holds back what a dry run only
 * reports. It follows "Cutover per organization": it freezes the organization in v1 before reading
 * anything it copies, imports it, verifies it, and only then marks it moved, so v1 forwards it. An
 * organization it copies nothing from is unfrozen again; one that fails after copying stays frozen
 * (`failed`) for a person to restart or roll back.
 *
 * Every run ends with a report. A step that still fails after its retries becomes the report's
 * reason; only when even that report cannot be written does the instance error, which the run's
 * aggregate lists.
 */
export const runV1Import = <S>(
  params: V1ImportParams,
  step: V1ImportStep<S>,
  sleep: V1ImportSleep<S>,
) =>
  Effect.gen(function* () {
    const environment = yield* V1ImportEnvironment;
    // Checked again in its own step, so the allow table is read once per instance, not on replay.
    const refusal =
      params.mode === "import"
        ? yield* step("allowed", importRefusal(environment.writes, [params.v1OrgId])).pipe(
            Effect.catchTag("V1ImportStepFailed", (error) =>
              Effect.succeed(
                `Its row in the allow table could not be read: v2's database kept failing (${error.failure}).`,
              ),
            ),
          )
        : undefined;
    if (refusal !== undefined) return yield* Effect.die(new Error(refusal));
    const organization = params.v1OrgId;

    /**
     * Write the report. If that still fails, write it without members' emails, which v1's WorkOS
     * may not have returned, and say so; a report an attempt already wrote is kept.
     */
    const finish = (
      assessment: Assessment,
      outcomes: readonly Outcome[],
      imported: Imported | undefined,
      identity: Identity | undefined,
      state: V1OrgState | undefined,
    ) =>
      step(
        "report",
        Effect.gen(function* () {
          const people = yield* reportPeople(assessment);
          return yield* writeReport(
            reportOf(params, assessment, outcomes, imported, people),
            identity,
            false,
            state,
          );
        }),
      ).pipe(
        Effect.catchTag("V1ImportStepFailed", () =>
          step(
            "report without people",
            writeReport(
              reportOf(
                params,
                {
                  ...assessment,
                  reason:
                    assessment.reason === null
                      ? reportPeopleUnread
                      : `${assessment.reason} ${reportPeopleUnread}`,
                },
                outcomes,
                imported,
                noPeople,
              ),
              identity,
              true,
              state,
            ),
          ),
        ),
      );

    if (params.mode === "import") {
      const frozen = yield* step("freeze", freezeInV1(params).pipe(Effect.as(undefined))).pipe(
        Effect.catchTag("V1ImportStepFailed", (error) =>
          Effect.succeed(
            `It could not be frozen in v1: v1's database kept failing (${error.failure}).`,
          ),
        ),
      );
      if (frozen !== undefined)
        return yield* finish(failedAssessment(frozen), [], undefined, undefined, "failed");
      yield* sleep("settle", environment.freezeSettleSeconds);
    }

    const assessment: Assessment = yield* step(
      "assess",
      assess(params).pipe(unlessUnreadable(failedAssessment)),
    ).pipe(
      Effect.catchTag("V1ImportStepFailed", (error) =>
        Effect.succeed(
          failedAssessment(
            `It could not be assessed: v1 or v2 kept failing while it was read (${error.failure}).`,
          ),
        ),
      ),
    );
    // A dry run checks a held-back organization's items too, so the report is its work list.
    if (
      assessment.status === "failed" ||
      (assessment.status === "held_back" && params.mode === "import")
    ) {
      // Nothing was copied, so an import gives the organization straight back to v1.
      const state =
        params.mode === "import"
          ? yield* step("unfreeze", releaseInV1(organization)).pipe(
              Effect.as<V1OrgState>("rolled_back"),
              Effect.catchTag("V1ImportStepFailed", () => Effect.succeed<V1OrgState>("failed")),
            )
          : undefined;
      return yield* finish(assessment, [], undefined, undefined, state);
    }
    const items = assessment.items;

    if (params.mode === "dry-run") {
      const outcomes: Outcome[] = [];
      for (const id of items.integrations)
        outcomes.push(
          yield* step(
            `integration ${id}`,
            dryIntegration(assessment, organization, id).pipe(
              unlessUnreadable((reason) => failedOutcome("integration", id, reason)),
            ),
          ).pipe(
            Effect.catchTag("V1ImportStepFailed", (error) =>
              Effect.succeed(unavailableOutcome("integration", id, error)),
            ),
          ),
        );
      const skippedIntegrations = staleIntegrations(outcomes);
      const apps = builtApps(outcomes);
      for (const [index, batch] of chunks(items.connections, connectionBatch).entries())
        outcomes.push(
          ...(yield* step(
            `connections ${index}`,
            dryConnections(assessment, organization, batch, skippedIntegrations, apps).pipe(
              unlessUnreadable((reason) =>
                batch.map((id) => failedOutcome("connection", id, reason)),
              ),
            ),
          ).pipe(
            Effect.catchTag("V1ImportStepFailed", (error) =>
              Effect.succeed(batch.map((id) => unavailableOutcome("connection", id, error))),
            ),
          )),
        );
      const dropped = droppedTools(outcomes);
      const later = [
        [
          "policies",
          dryPolicies(assessment, organization, dropped, skippedIntegrations),
          "tool_policy",
          items.policies,
        ],
        ["toolkits", dryToolkits(assessment, organization), "toolkit", items.toolkits],
        ["artifacts", dryArtifacts(assessment, organization), "artifact", items.artifacts],
      ] as const;
      for (const [name, work, kind, ids] of later)
        outcomes.push(
          ...(yield* step(
            name,
            work.pipe(
              unlessUnreadable((reason): readonly Outcome[] =>
                ids.map((id) => failedOutcome(kind, id, reason)),
              ),
            ),
          ).pipe(
            Effect.catchTag("V1ImportStepFailed", (error) =>
              Effect.succeed(ids.map((id) => unavailableOutcome(kind, id, error))),
            ),
          )),
        );
      return yield* finish(assessment, outcomes, undefined, undefined, undefined);
    }

    const written = yield* step(
      "identity",
      importIdentity(params, assessment).pipe(
        unlessUnreadable((reason) => ({ ok: false as const, reason })),
      ),
    ).pipe(
      Effect.catchTag("V1ImportStepFailed", (error) =>
        Effect.succeed({
          ok: false as const,
          reason: `Its v2 identity could not be written: v1 or v2 kept failing (${error.failure}).`,
        }),
      ),
    );
    if (!written.ok)
      return yield* finish(
        { ...assessment, status: "failed", reason: written.reason },
        [],
        undefined,
        undefined,
        "failed",
      );
    const identity = written.identity;
    const context = importContext(params, assessment, identity);
    const outcomes: Outcome[] = [];
    // An item whose step fails after its retries keeps the organization from converting.
    const one = (
      kind: Outcome["kind"],
      name: string,
      id: string,
      work: (context: ImportContext) => Effect.Effect<Outcome, unknown, never>,
    ) =>
      step(
        name,
        Effect.flatMap(context, work).pipe(
          unlessUnreadable((reason) => failedOutcome(kind, id, reason)),
        ),
      ).pipe(
        Effect.catchTag("V1ImportStepFailed", (error) =>
          Effect.succeed(unavailableOutcome(kind, id, error)),
        ),
      );
    const many = (
      kind: Outcome["kind"],
      name: string,
      ids: readonly string[],
      work: (context: ImportContext, id: string) => Effect.Effect<Outcome, unknown, never>,
    ) =>
      step(
        name,
        Effect.flatMap(context, (ctx) => Effect.forEach(ids, (id) => work(ctx, id))).pipe(
          unlessUnreadable((reason): readonly Outcome[] =>
            ids.map((id) => failedOutcome(kind, id, reason)),
          ),
        ),
      ).pipe(
        Effect.catchTag("V1ImportStepFailed", (error) =>
          Effect.succeed(ids.map((id) => unavailableOutcome(kind, id, error))),
        ),
      );
    // Copied accounts take v1's final tokens before any deployment can renew their own.
    const tookV1 = new Set<string>();
    for (const [index, batch] of chunks(items.connections, connectionBatch).entries())
      for (const id of yield* step(
        `grants ${index}`,
        Effect.flatMap(context, (ctx) => refreshCopiedGrants(ctx, batch)),
      ).pipe(Effect.catchTag("V1ImportStepFailed", () => Effect.succeed([]))))
        tookV1.add(id);
    for (const id of items.integrations)
      outcomes.push(
        yield* one("integration", `integration ${id}`, id, (ctx) => importIntegrationItem(ctx, id)),
      );
    const skippedIntegrations = staleIntegrations(outcomes);
    // Oldest first, so each app's links keep v1's order.
    for (const [index, batch] of chunks(items.connections, connectionBatch).entries())
      outcomes.push(
        ...(yield* many("connection", `connections ${index}`, batch, (ctx, id) =>
          importConnectionItem(ctx, id, skippedIntegrations, tookV1),
        )),
      );
    const dropped = droppedTools(outcomes);
    outcomes.push(
      ...(yield* many("tool_policy", "policies", items.policies, (ctx, id) =>
        importPolicyItem(ctx, id, dropped, skippedIntegrations),
      )),
    );
    for (const id of items.toolkits)
      outcomes.push(
        yield* one("toolkit", `toolkit ${id}`, id, (ctx) => importToolkitItem(ctx, id)),
      );
    for (const id of items.artifacts)
      outcomes.push(
        yield* one("artifact", `artifact ${id}`, id, (ctx) => importArtifactItem(ctx, id)),
      );
    const checked = yield* step(
      "verify",
      Effect.flatMap(context, (ctx) =>
        verify(organization, ctx, outcomes, items, assessment.members),
      ).pipe(
        unlessUnreadable((reason): Verified => ({ problems: [reason], verification: undefined })),
      ),
    ).pipe(
      Effect.catchTag("V1ImportStepFailed", () =>
        Effect.succeed<Verified>({
          problems: ["The import could not be verified."],
          verification: undefined,
        }),
      ),
    );
    const problems = checked.problems;
    // Cutover step 5, only once verification passed. Step 6 sends no email (decision 13).
    const cutOver =
      problems.length === 0 &&
      (yield* step("cut over", cutOverInV1(organization, identity.target)).pipe(
        Effect.as(true),
        Effect.catchTag("V1ImportStepFailed", () => Effect.succeed(false)),
      ));
    return yield* finish(
      assessment,
      outcomes,
      {
        problems: problems.length === 0 && !cutOver ? [notCutOver] : problems,
        target: identity.target,
        verification: checked.verification,
        cutover: cutOver,
      },
      identity,
      cutOver ? "cutover" : "failed",
    );
  });
