/**
 * The server-side v1 move: an operator starts the `V1Import` Workflow for v1 organizations with the
 * deployment's operator token, and reads each organization's report. The scenarios write synthetic
 * v1 rows into the managed Cloud's emulated v1 database, members into the emulated v1 WorkOS and
 * secrets into its Vault, and read v2's own rows to prove what was and was not written.
 */
import { randomUUID } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Schedule, Schema } from "effect";
import { TestLive, withCase } from "../support/case.ts";
import { Browser } from "../support/browser.ts";
import { writeRows, type RowStatement } from "../support/cloud-rows.ts";
import { Emulators } from "../support/emulators.ts";
import { Telemetry } from "../support/evidence.ts";
import { Onboarding } from "../support/onboarding.ts";
import { v1ImportOperator, v1RunId } from "../support/v1-import.ts";
import { scenarios } from "../test-plan.ts";

const services = Layer.mergeAll(Onboarding.layer, Emulators.layer);

const row = (sql: string, ...params: string[]): RowStatement => ({ sql, params });
const Rows = Schema.Array(Schema.Array(Schema.Unknown));

/** v2's own rows, read as the database holds them. */
const cloudRows = <S extends Schema.Top>(schema: S, sql: string, ...params: string[]) =>
  writeRows("sso-database.json", [row(sql, ...params)]).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Rows)),
    Effect.flatMap((results) => Schema.decodeUnknownEffect(Schema.Array(schema))(results[0] ?? [])),
  );

/** The emulated v1's rows, read as its owner. */
const v1Rows = <S extends Schema.Top>(schema: S, sql: string, ...params: string[]) =>
  writeRows("v1-database.json", [row(sql, ...params)]).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Rows)),
    Effect.flatMap((results) => Schema.decodeUnknownEffect(Schema.Array(schema))(results[0] ?? [])),
  );

const Flag = Schema.Struct({
  state: Schema.String,
  v2_org_id: Schema.NullOr(Schema.String),
  v2_org_slug: Schema.NullOr(Schema.String),
});
const movedFlag = (organization: string) =>
  v1Rows(
    Flag,
    "select state, v2_org_id, v2_org_slug from org_moved_to_v2 where org_id = $1",
    organization,
  );
const importState = (organization: string) =>
  cloudRows(
    Schema.Struct({ state: Schema.String }),
    "select state from private_v1_import_org where v1_org_id = $1",
    organization,
  );

const Response = Schema.Struct({ status: Schema.Number, body: Schema.Unknown });
const Source = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});

/** Call Cloud's API from the signed-in page, as the dashboard does. */
const call = (step: string, path: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    return yield* browser
      .use(step, (page) =>
        page.evaluate(
          (path) =>
            fetch(path).then((response) =>
              response.json().then((body: unknown) => ({ status: response.status, body })),
            ),
          path,
        ),
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Response)));
  });

/** Sign in with Google as a v1 member; v2 keeps them on v1 until their workspace moves. */
const signInOnV1 = (email: string) =>
  Effect.gen(function* () {
    const onboarding = yield* Onboarding,
      browser = yield* Browser;
    yield* browser.use("Open Cloud sign-in", (page) => page.goto("/login"));
    yield* onboarding.chooseSocial("google");
    yield* browser.use("Choose the v1 member on the Google emulator", (page) =>
      page.getByRole("button").filter({ hasText: email }).click(),
    );
    yield* browser.use("v2 keeps the member on v1", (page) =>
      page.getByText("Your workspace is on Executor v1").waitFor({ state: "visible" }),
    );
  });

const vaultScope = (organization: string, user?: string) =>
  user === undefined
    ? `executor/org/${encodeURIComponent(organization)}`
    : `executor/user/${encodeURIComponent(organization)}/${encodeURIComponent(user)}`;

const personalApproveDropped =
  "In a workspace with more than one member, a member's own approve rules are not imported, so these tools ask again.";

/**
 * A shared workspace's MCP server that takes an API key: the organization's `team` connection, a
 * `mine` connection of two members, and a `gone` connection of someone who left. Rules: one member
 * approves `search` for themselves, another blocks `delete_item`, and the former member blocked
 * `search`. An org toolkit grants the `team` connection; one member's own toolkit grants theirs.
 */
const seedShared = (
  organization: string,
  slug: string,
  members: { readonly first: string; readonly second: string; readonly former: string },
) =>
  Effect.gen(function* () {
    const emulators = yield* Emulators;
    const tracker = `shared_${randomUUID().slice(0, 6)}`;
    const keyOf = (owner: "org" | "user", name: string) =>
      `connection:${owner}:${tracker}:${name}:token`;
    const secrets = [
      [vaultScope(organization), keyOf("org", "team"), "synthetic-team-key"],
      [vaultScope(organization, members.first), keyOf("user", "mine"), "synthetic-first-key"],
      [vaultScope(organization, members.second), keyOf("user", "mine"), "synthetic-second-key"],
      [vaultScope(organization, members.former), keyOf("user", "gone"), "synthetic-former-key"],
    ] as const;
    for (const [scope, item, value] of secrets)
      yield* emulators.v1VaultObject(`${scope}/secrets/${encodeURIComponent(item)}`, value);
    const mcp = {
      transport: "remote",
      endpoint: "https://shared.example.com/mcp",
      remoteTransport: "auto",
      authenticationTemplate: [
        { slug: "header", kind: "apikey", placements: [{ carrier: "header", name: "X-Key" }] },
        // Unused here; the dry run's first-party connections sign in with it.
        { slug: "oauth2", kind: "oauth2" },
      ],
    };
    const connection = (owner: "org" | "user", subject: string, name: string, age: string) =>
      row(
        "insert into connection (tenant, owner, subject, integration, name, template, item_ids, created_at) values ($1, $2, $3, $4, $5, 'header', $6::json, now() - $7::interval)",
        organization,
        owner,
        subject,
        tracker,
        name,
        JSON.stringify({ token: keyOf(owner, name) }),
        age,
      );
    const tools = (owner: "org" | "user", subject: string, name: string) =>
      ["search", "delete_item"].map((tool) =>
        row(
          "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name, annotations) values ($1, $2, $3, $4, $5, 'mcp', $6, $7::json)",
          organization,
          owner,
          subject,
          tracker,
          name,
          tool,
          JSON.stringify({ mcp: { toolName: tool } }),
        ),
      );
    const policy = (subject: string, pattern: string, action: string) =>
      row(
        "insert into tool_policy (tenant, owner, subject, pattern, action, position) values ($1, 'user', $2, $3, $4, 'a0')",
        organization,
        subject,
        pattern,
        action,
      );
    const storage = (
      owner: "org" | "user",
      subject: string,
      collection: string,
      key: string,
      data: object,
    ) =>
      row(
        "insert into plugin_storage (tenant, owner, subject, plugin_id, collection, key, data) values ($1, $2, $3, 'toolkits', $4, $5, $6::json)",
        organization,
        owner,
        subject,
        collection,
        key,
        JSON.stringify(data),
      );
    yield* writeRows("v1-database.json", [
      row(
        "insert into organizations (id, name, slug) values ($1, $2, $3)",
        organization,
        "Synthetic shared workspace",
        slug,
      ),
      row(
        "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'mcp', 'Shared Tracker', $3::json)",
        organization,
        tracker,
        JSON.stringify(mcp),
      ),
      connection("org", "", "team", "3 days"),
      connection("user", members.first, "mine", "2 days"),
      connection("user", members.second, "mine", "1 day"),
      connection("user", members.former, "gone", "4 days"),
      ...tools("org", "", "team"),
      ...tools("user", members.first, "mine"),
      ...tools("user", members.second, "mine"),
      ...tools("user", members.former, "gone"),
      policy(members.second, `${tracker}.*.*.search`, "approve"),
      policy(members.first, `${tracker}.*.*.delete_item`, "block"),
      policy(members.former, `${tracker}.*.*.search`, "block"),
      storage("org", "", "toolkits", "tk_team", { id: "tk_team", name: "Team kit", slug: "team" }),
      storage("org", "", "toolkitConnections", "tc_team", {
        id: "tc_team",
        toolkitId: "tk_team",
        pattern: `${tracker}.org.team.*`,
        position: "a0",
      }),
      storage("user", members.first, "toolkits", "tk_mine", {
        id: "tk_mine",
        name: "Mine",
        slug: "mine",
      }),
      storage("user", members.first, "toolkitConnections", "tc_mine", {
        id: "tc_mine",
        toolkitId: "tk_mine",
        pattern: `${tracker}.user.mine.*`,
        position: "a0",
      }),
    ]);
    return { tracker };
  });

const IdRow = Schema.Struct({ id: Schema.String });

layer(TestLive, { excludeTestServices: true })("Cloud v1 import runs", (it) => {
  it.effect(scenarios.v1ImportShared.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const operator = yield* v1ImportOperator;
        // The oldest membership is a member's, so the oldest admin owns the organization: the
        // signed-in member, whose v2 account the import keeps.
        const older = `older-${randomUUID().slice(0, 8)}@example.test`;
        const first = yield* emulators.identity("google");
        const third = `third-${randomUUID().slice(0, 8)}@example.test`;
        const workspace = yield* emulators.v1Workspace([older, first.email, third]);
        const olderUser = workspace.user;
        const firstUser = yield* emulators.v1User(first.email);
        const thirdUser = yield* emulators.v1User(third);
        yield* emulators.setV1MemberRole(workspace.organization, olderUser, "member");
        // Someone who left: their rows stay in v1's database, and they are a member elsewhere.
        const former = yield* emulators.v1Workspace([
          `former-${randomUUID().slice(0, 8)}@example.test`,
        ]);
        const slug = `v1-${randomUUID().slice(0, 8)}`;
        const { tracker } = yield* seedShared(workspace.organization, slug, {
          first: firstUser,
          second: olderUser,
          former: former.user,
        });
        // The first member already has a v2 account with the same verified email.
        yield* signInOnV1(first.email);

        const run = v1RunId("shared");
        const started = yield* operator.start({
          mode: "import",
          runId: run,
          organizations: [workspace.organization],
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const report = yield* operator.waitForReport(run, workspace.organization);
        expect(report.status, report.reason ?? "").toBe("imported");
        expect(report.emailMatches).toEqual([{ email: first.email, match: "merge" }]);
        const target = report.v2Organization;
        if (target === undefined) return yield* Effect.die("The import named no organization");
        expect(target.slug).toBe(slug);
        // Verified, then cut over: v1 forwards the workspace to its v2 organization.
        const verification = report.verification;
        expect(verification).toMatchObject({
          members: { planned: 3, inV2: 3 },
          accounts: { checked: 3, unreadable: 0 },
          apps: { checked: 1, withoutVersion: 0 },
          passed: true,
        });
        expect(verification?.items.withResult).toBe(verification?.items.planned);
        expect(verification?.items.failed).toBe(0);
        expect(report.cutover).toBe(true);
        expect(yield* movedFlag(workspace.organization)).toEqual([
          { state: "moved", v2_org_id: target.id, v2_org_slug: slug },
        ]);
        expect(yield* importState(workspace.organization)).toEqual([{ state: "cutover" }]);
        const items = report.items ?? [];
        const statusOf = (kind: string, label: string) =>
          items
            .filter((item) => item.kind === kind && item.label === label)
            .map((item) => item.status);
        expect(statusOf("integration", "Shared Tracker")).toEqual(["imported"]);
        expect(statusOf("connection", "team")).toEqual(["imported"]);
        expect(statusOf("connection", "mine")).toEqual(["imported", "imported"]);
        // The former member's connection and rules are not read at all.
        expect(items.filter((item) => item.label === "gone")).toEqual([]);
        const policies = items.filter((item) => item.kind === "tool_policy");
        expect(policies).toHaveLength(2);
        expect(policies).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              label: `${tracker}.*.*.search`,
              status: "skipped",
              reason: personalApproveDropped,
            }),
            expect.objectContaining({ label: `${tracker}.*.*.delete_item`, status: "imported" }),
          ]),
        );
        expect(statusOf("toolkit", "Team kit")).toEqual(["imported"]);
        expect(statusOf("toolkit", "Mine")).toEqual(["imported"]);

        // Members and roles: the oldest admin owns it; every other admin stays one.
        const v2User = (email: string) =>
          cloudRows(
            Schema.Struct({ id: Schema.String, emailVerified: Schema.Boolean }),
            `select id, "emailVerified" from "user" where lower(email) = lower($1)`,
            email,
          ).pipe(Effect.map((users) => users[0]));
        const [firstV2, olderV2, thirdV2] = [
          yield* v2User(first.email),
          yield* v2User(older),
          yield* v2User(third),
        ];
        if (firstV2 === undefined || olderV2 === undefined || thirdV2 === undefined)
          return yield* Effect.die("A member has no v2 user");
        expect([olderV2.emailVerified, thirdV2.emailVerified]).toEqual([true, true]);
        const roles = yield* cloudRows(
          Schema.Struct({ userId: Schema.String, role: Schema.String }),
          `select "userId", role from member where "organizationId" = $1`,
          target.id,
        );
        expect(Object.fromEntries(roles.map((member) => [member.userId, member.role]))).toEqual({
          [olderV2.id]: "member",
          [firstV2.id]: "owner",
          [thirdV2.id]: "admin",
        });
        // Imported users are not queued for the welcome email.
        expect(
          yield* cloudRows(
            Schema.Struct({ user_id: Schema.String }),
            "select user_id from cloud_welcome_email where user_id in ($1, $2)",
            olderV2.id,
            thirdV2.id,
          ),
        ).toEqual([]);
        // The import map tells merged accounts from created ones.
        const mapped = yield* cloudRows(
          Schema.Struct({ v1_id: Schema.String, v2_kind: Schema.String, v2_id: Schema.String }),
          "select v1_id, v2_kind, v2_id from private_v1_import_map where v1_kind = 'user' and v1_org_id = $1",
          workspace.organization,
        );
        expect(
          Object.fromEntries(mapped.map((entry) => [entry.v1_id, [entry.v2_kind, entry.v2_id]])),
        ).toEqual({
          [firstUser]: ["merged_user", firstV2.id],
          [olderUser]: ["user", olderV2.id],
          [thirdUser]: ["user", thirdV2.id],
        });

        // The app is shared with everyone and created by the owner.
        const app = items.find((item) => item.kind === "integration")?.v2Id ?? "";
        expect(
          yield* cloudRows(
            Schema.Struct({ creator_id: Schema.NullOr(Schema.String), audience: Schema.String }),
            "select creator_id, audience from hosted_app_access where id = $1",
            app,
          ),
        ).toEqual([{ creator_id: firstV2.id, audience: "everyone" }]);
        // The org connection is a shared account linked for everyone; each member's is their own,
        // linked for them.
        const access = yield* cloudRows(
          Schema.Struct({
            account_id: Schema.String,
            kind: Schema.String,
            audience: Schema.NullOr(Schema.String),
            personal_user_id: Schema.NullOr(Schema.String),
          }),
          "select account_id, kind, audience, personal_user_id from hosted_account_access where organization_id = $1 and account_id in (select account from hosted_app_account_links where app = $2)",
          target.id,
          app,
        );
        expect(
          access
            .map((entry) => [entry.kind, entry.audience, entry.personal_user_id])
            .toSorted((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
        ).toEqual(
          [
            ["personal", null, firstV2.id],
            ["personal", null, olderV2.id],
            ["shared", "everyone", null],
          ].toSorted((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
        );
        const links = yield* cloudRows(
          Schema.Struct({
            requirement: Schema.String,
            subject: Schema.NullOr(Schema.String),
            account: Schema.String,
          }),
          "select requirement, subject, account from hosted_app_account_links where app = $1",
          app,
        );
        const shared = access.find((entry) => entry.kind === "shared")?.account_id;
        expect(
          links
            .map((link) => [link.requirement, link.subject, link.account === shared])
            .toSorted((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
        ).toEqual(
          [
            ["service", firstV2.id, false],
            ["service", olderV2.id, false],
            ["workspace", null, true],
          ].toSorted((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
        );

        // A member's block applies to everyone; their approve does not lower anyone's.
        const source = yield* call(
          "Read the shared app's source",
          `/api/organizations/${target.id}/apps/${app}/source`,
        );
        expect(source.status, JSON.stringify(source.body)).toBe(200);
        const files = (yield* Schema.decodeUnknownEffect(Source)(source.body)).files;
        const toolsFile = files.find((file) => file.path === "tools.ts")?.content ?? "";
        const compact = toolsFile.replace(/\s+/gu, "");
        expect(compact).toContain('constomitted=newSet<string>(["delete_item"])');
        // The member's own approve of `search` is dropped, so no tool skips its approval.
        expect(compact).toContain('constapprovals:Record<string,"always"|"never">={}');
        expect(files.find((file) => file.path === "index.ts")?.content).toContain(
          "workspace: provider.many()",
        );
        for (const secret of ["synthetic-team-key", "synthetic-first-key", "synthetic-second-key"])
          expect(JSON.stringify(files)).not.toContain(secret);

        // Every member has their own copy of the org toolkit; the personal one is its owner's.
        const copies = yield* cloudRows(
          Schema.Struct({ name: Schema.String, userId: Schema.String }),
          `select name, "userId" from "mcpConnection" where resource = $1 and not revoked`,
          target.id,
        );
        expect(
          copies
            .map((copy) => [copy.name, copy.userId])
            .toSorted((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
        ).toEqual(
          [
            ["Mine", firstV2.id],
            ["Team kit", firstV2.id],
            ["Team kit", olderV2.id],
            ["Team kit", thirdV2.id],
          ].toSorted((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
        );

        // Starting it again finds the same instance and writes nothing new.
        const again = yield* operator.start({
          mode: "import",
          runId: run,
          organizations: [workspace.organization],
        });
        expect(again.status).toBe(200);
        expect(
          yield* cloudRows(
            IdRow,
            `select o.id from organization o where o.slug like $1`,
            `${slug}%`,
          ),
        ).toEqual([{ id: target.id }]);
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportRollback.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators,
          browser = yield* Browser;
        const operator = yield* v1ImportOperator;
        const identity = yield* emulators.identity("google");
        const workspace = yield* emulators.v1Workspace([identity.email]);
        const slug = `v1-${randomUUID().slice(0, 8)}`;
        yield* writeRows("v1-database.json", [
          row(
            "insert into organizations (id, name, slug) values ($1, $2, $3)",
            workspace.organization,
            "Synthetic rollback workspace",
            slug,
          ),
          // Some v1 data, so v1's sign-in check holds the member on v1: a rule of an integration
          // v1 deleted, which has nothing to import.
          row(
            "insert into tool_policy (tenant, owner, subject, pattern, action, position) values ($1, 'org', '', $2, 'block', 'a0')",
            workspace.organization,
            `gone_${randomUUID().slice(0, 6)}.*.*.search`,
          ),
        ]);
        yield* signInOnV1(identity.email);

        const run = v1RunId("rollback");
        const started = yield* operator.start({
          mode: "import",
          runId: run,
          organizations: [workspace.organization],
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const report = yield* operator.waitForReport(run, workspace.organization);
        expect(report.status, report.reason ?? "").toBe("imported");
        expect(report.cutover).toBe(true);
        const target = report.v2Organization;
        if (target === undefined) return yield* Effect.die("The import named no organization");
        expect(yield* movedFlag(workspace.organization)).toEqual([
          { state: "moved", v2_org_id: target.id, v2_org_slug: target.slug },
        ]);

        // While its v2 organization exists, its grants could renew beside v1's: no rollback.
        const refused = yield* operator.rollback(workspace.organization);
        expect(refused.status).toBe(409);
        expect(JSON.stringify(refused.body)).toContain("still exists");
        expect((yield* movedFlag(workspace.organization))[0]?.state).toBe("moved");

        const deleted = yield* browser.use("Delete the imported v2 organization", (page) =>
          page.evaluate(
            (id) => fetch(`/api/organizations/${id}`, { method: "DELETE" }).then((r) => r.status),
            target.id,
          ),
        );
        expect(deleted).toBeLessThan(300);
        // Removal is durable and finishes shortly; the rollback waits for its organization row.
        const rolledBack = yield* operator.rollback(workspace.organization).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? Effect.succeed(response)
              : Effect.fail(new Error(JSON.stringify(response.body))),
          ),
          Effect.retry(Schedule.spaced("1 second").pipe(Schedule.upTo({ duration: "50 seconds" }))),
        );
        expect(rolledBack.body).toEqual({
          organization: workspace.organization,
          state: "rolled_back",
        });
        expect(yield* movedFlag(workspace.organization)).toEqual([
          { state: "rolled_back", v2_org_id: null, v2_org_slug: null },
        ]);
        expect(yield* importState(workspace.organization)).toEqual([{ state: "rolled_back" }]);
        // Users stay mapped, for their other organizations; everything else is gone.
        expect(
          yield* cloudRows(
            Schema.Struct({ v1_kind: Schema.String }),
            "select distinct v1_kind from private_v1_import_map where v1_org_id = $1",
            workspace.organization,
          ),
        ).toEqual([{ v1_kind: "user" }]);
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportDryRun.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const operator = yield* v1ImportOperator;
        const first = `dry-${randomUUID().slice(0, 8)}@example.test`;
        const second = `dry-${randomUUID().slice(0, 8)}@example.test`;
        const workspace = yield* emulators.v1Workspace([first, second]);
        const secondUser = yield* emulators.v1User(second);
        // Someone invited who has not accepted: their membership is pending, so they do not move.
        const inviteeEmail = `invited-${randomUUID().slice(0, 8)}@example.test`;
        const invited = yield* emulators.v1Workspace([inviteeEmail]);
        yield* emulators.inviteV1Member(workspace.organization, inviteeEmail);
        yield* emulators.setV1OrganizationMetadata(workspace.organization, {
          v1_setting: "synthetic",
        });
        const former = yield* emulators.v1Workspace([
          `gone-${randomUUID().slice(0, 8)}@example.test`,
        ]);
        // 44 characters: v2 allows 45, so the slug moves whole, though a suffixed slug would be
        // cut to leave room for its suffix.
        const slug = `v1-${randomUUID().slice(0, 8)}-a-long-workspace-name-kept-whole`;
        const { tracker } = yield* seedShared(workspace.organization, slug, {
          first: workspace.user,
          second: secondUser,
          former: former.user,
        });
        // What a dry run reports: a TRACE operation, a connection that cannot move, a secret the
        // Vault does not return, rules that match no v2 tool (one only a dropped TRACE tool), an
        // artifact whose role binds nothing, and first-party clients v2 lacks or holds under
        // another client ID than v1's.
        const traced = `traced_${randomUUID().slice(0, 6)}`;
        const document = JSON.stringify({
          openapi: "3.0.3",
          info: { title: "Traced", version: "1" },
          servers: [{ url: "https://traced.example.com" }],
          paths: {
            "/items": {
              get: { operationId: "listItems", responses: { "200": { description: "ok" } } },
              trace: { operationId: "traceItems", responses: { "200": { description: "ok" } } },
            },
          },
        });
        const hash = randomUUID().replaceAll("-", "");
        yield* writeRows("v1-database.json", [
          row(
            "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'openapi', 'Traced API', $3::json)",
            workspace.organization,
            traced,
            JSON.stringify({ specHash: hash, authenticationTemplate: [] }),
          ),
          row(
            "insert into blob (namespace, key, value) values ($1, $2, $3)",
            `o:${workspace.organization}/openapi`,
            `spec/${hash}`,
            document,
          ),
          ...[
            ["items.listItems", "get"],
            ["items.traceItems", "trace"],
          ].map(([tool, method]) =>
            row(
              "insert into plugin_storage (tenant, plugin_id, collection, key, data) values ($1, 'openapi', 'operation', $2, $3::json)",
              workspace.organization,
              `op.${tool}`,
              JSON.stringify({
                integration: traced,
                toolName: tool,
                binding: { method, pathTemplate: "/items" },
              }),
            ),
          ),
          row(
            "insert into connection (tenant, owner, subject, integration, name, template, item_ids, oauth_client, oauth_client_owner) values ($1, 'user', $2, $3, 'linear', 'oauth2', '{\"token\":\"oauth:user:linear:token\"}', 'first-party:linear', 'org')",
            workspace.organization,
            workspace.user,
            tracker,
          ),
          row(
            "insert into connection (tenant, owner, subject, integration, name, template, item_ids, oauth_client, oauth_client_owner) values ($1, 'org', '', $2, 'mail', 'oauth2', '{\"token\":\"oauth:org:mail:token\"}', 'first-party:synthetic-cloud-mail', 'org')",
            workspace.organization,
            tracker,
          ),
          row(
            "insert into connection (tenant, owner, subject, integration, name, template, item_ids) values ($1, 'org', '', $2, 'lost', 'header', $3::json)",
            workspace.organization,
            tracker,
            JSON.stringify({ token: `connection:org:${tracker}:lost:token` }),
          ),
          row(
            "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name) values ($1, 'org', '', $2, '', 'openapi', 'items.traceItems')",
            workspace.organization,
            traced,
          ),
          row(
            "insert into tool_policy (tenant, owner, subject, pattern, action) values ($1, 'org', '', $2, 'block')",
            workspace.organization,
            `${traced}.*.*.items.traceItems`,
          ),
          row(
            "insert into tool_policy (tenant, owner, subject, pattern, action) values ($1, 'org', '', $2, 'require_approval')",
            workspace.organization,
            `${tracker}.*.*.unlisted`,
          ),
          row(
            "insert into artifact (tenant, owner, subject, title, code, bindings) values ($1, 'org', '', 'Board', 'export const App = () => tools.missing_service.list()', '{}'::json)",
            workspace.organization,
          ),
        ]);
        // Held back: an Enterprise organization, decided by its plan. A dry run still checks its
        // items, so its report is a work list too.
        const enterprise = yield* emulators.v1Workspace([
          `ent-${randomUUID().slice(0, 8)}@example.test`,
        ]);
        yield* emulators.v1Plan(enterprise.organization, "enterprise");
        yield* writeRows("v1-database.json", [
          row(
            "insert into organizations (id, name, slug) values ($1, 'Synthetic enterprise', $2)",
            enterprise.organization,
            `v1-${randomUUID().slice(0, 8)}`,
          ),
          row(
            "insert into tool_policy (tenant, owner, subject, pattern, action) values ($1, 'org', '', 'gone.*', 'block')",
            enterprise.organization,
          ),
        ]);

        // v1 returns rows the import cannot read: an OpenAPI operation stored without its binding.
        // The integration reports which rows, not an outage, and without retrying.
        const brokenWorkspace = yield* emulators.v1Workspace([
          `broken-${randomUUID().slice(0, 8)}@example.test`,
        ]);
        const broken = `broken_${randomUUID().slice(0, 6)}`;
        const brokenHash = randomUUID().replaceAll("-", "");
        yield* writeRows("v1-database.json", [
          row(
            "insert into organizations (id, name, slug) values ($1, 'Synthetic broken rows', $2)",
            brokenWorkspace.organization,
            `v1-${randomUUID().slice(0, 8)}`,
          ),
          row(
            "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'openapi', 'Broken ops', $3::json)",
            brokenWorkspace.organization,
            broken,
            JSON.stringify({ specHash: brokenHash, authenticationTemplate: [] }),
          ),
          row(
            "insert into blob (namespace, key, value) values ($1, $2, $3)",
            `o:${brokenWorkspace.organization}/openapi`,
            `spec/${brokenHash}`,
            document,
          ),
          row(
            "insert into plugin_storage (tenant, plugin_id, collection, key, data) values ($1, 'openapi', 'operation', 'op.items.listItems', $2::json)",
            brokenWorkspace.organization,
            JSON.stringify({ integration: broken, toolName: "items.listItems" }),
          ),
        ]);

        // Nobody else can start or read a run: without the token the routes are not there.
        for (const authorization of [undefined, "Bearer wrong-token"]) {
          const refused = yield* operator.send("POST", "/api/internal/v1-import/start", {
            body: { mode: "dry-run", runId: "refused", organizations: [workspace.organization] },
            authorization,
          });
          expect(refused.status).toBe(404);
        }

        const run = v1RunId("dry");
        const started = yield* operator.start({
          mode: "dry-run",
          runId: run,
          organizations: [
            workspace.organization,
            enterprise.organization,
            brokenWorkspace.organization,
          ],
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        expect(started.body).toEqual({
          started: [workspace, enterprise, brokenWorkspace].map(({ organization }) => ({
            organization,
            instance: `${organization}-dry-${run}`,
          })),
          deferred: [],
          skipped: [],
          next: null,
          // The bound counts every run on this Cloud, so other scenarios' organizations too.
          inFlight: expect.any(Number),
          errored: [],
        });
        const { inFlight } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ inFlight: Schema.Number }),
        )(started.body);
        expect(inFlight).toBeGreaterThanOrEqual(3);
        const report = yield* operator.waitForReport(run, workspace.organization);
        expect(report.mode).toBe("dry-run");
        expect(report.status).toBe("blocked");
        expect(report.items).toBeUndefined();
        expect(report.slug).toEqual({ v1: slug, v2: slug, changed: false });
        expect(report.emailMatches).toEqual([]);
        expect(report.skippedMembers).toEqual([{ user: invited.user, reason: "pending" }]);
        expect(report.counts.v1).toMatchObject({
          members: 2,
          pendingMembers: 1,
          importedMembers: 2,
          integrations: 2,
          policies: 4,
          toolkits: 2,
          artifacts: 1,
        });
        expect(report.counts.v2).toMatchObject({
          users: 2,
          members: 2,
          apps: 2,
          mcpConnections: 3,
        });
        expect(report.integrationFailures).toEqual([]);
        expect(report.droppedTraceTools).toEqual([
          { integration: "Traced API", tools: ["items.traceItems"] },
        ]);
        expect(report.firstPartyMismatches).toHaveLength(2);
        expect(report.firstPartyMismatches).toEqual(
          expect.arrayContaining([
            { client: "linear", reason: "unavailable", connections: 1 },
            { client: "synthetic-cloud-mail", reason: "different_client", connections: 1 },
          ]),
        );
        expect(report.vaultFailures).toEqual([
          expect.objectContaining({
            label: "lost",
            integration: "Shared Tracker",
            reason: "missing",
          }),
        ]);
        expect(
          report.connectionFailures
            .flatMap((failure) => failure.connections.map((c) => c.label))
            .toSorted(),
        ).toEqual(["linear", "mail"]);
        // v1 cannot send a secret its Vault no longer holds either: it is skipped, not blocking.
        expect(report.staleItems).toEqual([
          expect.objectContaining({
            kind: "connection",
            label: "lost",
            integration: "Shared Tracker",
            category: "missing_credential",
          }),
        ]);
        // v1 listed the TRACE tool, but its v2 app leaves it out, so its rule matches no v2 tool.
        expect(report.unmatchedRules).toHaveLength(2);
        expect(report.unmatchedRules).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              pattern: `${tracker}.*.*.unlisted`,
              action: "require_approval",
            }),
            expect.objectContaining({
              pattern: `${traced}.*.*.items.traceItems`,
              action: "block",
            }),
          ]),
        );
        expect(report.artifacts).toEqual([
          expect.objectContaining({
            title: "Board",
            unmappedRoles: [expect.objectContaining({ role: "missing_service" })],
          }),
        ]);
        expect(report.flags).toMatchObject({ overFreeMemberLimit: false, paidPlans: [] });

        const held = yield* operator.waitForReport(run, enterprise.organization);
        expect(held).toMatchObject({
          status: "held_back",
          reason: "Enterprise organizations move by hand, after their v2 SSO is set up.",
          flags: { paidPlans: ["enterprise"] },
          counts: { v1: { policies: 1 }, v2: { skippedPolicies: 1 } },
        });

        // A dry run writes nothing to v2 and nothing to v1.
        expect(
          yield* cloudRows(
            IdRow,
            "select v1_id as id from private_v1_import_map where v1_org_id = $1 union all select v1_org_id from private_v1_import_org where v1_org_id = $1",
            workspace.organization,
          ),
        ).toEqual([]);
        expect(
          yield* cloudRows(
            IdRow,
            `select id from "user" where lower(email) in (lower($1), lower($2))`,
            first,
            second,
          ),
        ).toEqual([]);
        expect(
          yield* cloudRows(IdRow, "select id from organization where slug = $1", slug),
        ).toEqual([]);
        expect(yield* emulators.v1OrganizationMetadata(workspace.organization)).toEqual({
          v1_setting: "synthetic",
        });
        // Nor anything outside its reports: each app is compiled and its requirements declared,
        // but no build is kept in the app build store or its cache. Its run's spans say so.
        const telemetry = yield* Telemetry;
        const steps = yield* telemetry
          .search("v1_import.step", {
            "executor.v1_import.organization": workspace.organization,
            "executor.v1_import.step": "integration",
          })
          .pipe(
            Effect.filterOrFail(
              (found) => found.data.length >= 2,
              () => new Error("The integration steps' spans have not arrived"),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
          );
        for (const trace of new Set(steps.data.map((entry) => entry.traceId))) {
          const spans = (yield* telemetry.query(trace)).data.map(({ span }) => span.operationName);
          expect(spans.filter((name) => name === "sdk.apps.build")).toHaveLength(2);
          expect(spans.filter((name) => name === "runtime.cloud.requirements")).toHaveLength(2);
          expect(spans).not.toContain("runtime.cloud.retain");
        }

        const unreadable = yield* operator.waitForReport(run, brokenWorkspace.organization);
        expect(unreadable.status).toBe("blocked");
        expect(unreadable.integrationFailures).toEqual([
          {
            id: expect.any(String),
            label: "Broken ops",
            error:
              "v1's openapi operation rows could not be read: they do not have the shape the import expects.",
          },
        ]);

        // The aggregate lists every organization once their reports exist.
        const aggregate = yield* operator.aggregate(run);
        expect(aggregate).toMatchObject({
          runId: run,
          complete: true,
          organizations: 3,
          pending: [],
          errored: [],
          statuses: { blocked: 2, held_back: 1 },
          heldBack: [{ organization: enterprise.organization }],
          integrationFailures: [
            {
              organization: brokenWorkspace.organization,
              entry: expect.objectContaining({ label: "Broken ops" }),
            },
          ],
          pages: 1,
        });
        expect(aggregate.blocked.toSorted()).toEqual(
          [workspace.organization, brokenWorkspace.organization].toSorted(),
        );
        // A page at a time, it combines to the same aggregate.
        expect(yield* operator.aggregate(run, 1)).toEqual({ ...aggregate, pages: 3 });
        for (const query of [{ cursor: "not-a-cursor" }, { limit: 0 }, { limit: 201 }])
          expect((yield* operator.aggregatePage(run, query)).status, JSON.stringify(query)).toBe(
            400,
          );

        // Without a list, a batch takes the next live organizations in id order.
        const batch = yield* operator.start({
          mode: "dry-run",
          runId: v1RunId("batch"),
          limit: 1,
        });
        expect(batch.status, JSON.stringify(batch.body)).toBe(200);
        expect(batch.body).toMatchObject({
          started: [expect.anything()],
          next: expect.any(String),
        });

        // An id in v1's list that is not a v1 organization id is skipped, and the walk moves on.
        const prefix = `org_zz${randomUUID().replaceAll("-", "").slice(0, 20)}`;
        const invalid = `${prefix}-bad`;
        yield* writeRows("v1-database.json", [
          row(
            "insert into organizations (id, name, slug) values ($1, 'Synthetic invalid id', $2)",
            invalid,
            `v1-${randomUUID().slice(0, 8)}`,
          ),
        ]);
        const walk = v1RunId("walk");
        const skipped = yield* operator.start({
          mode: "dry-run",
          runId: walk,
          after: prefix,
          limit: 1,
        });
        expect(skipped.status, JSON.stringify(skipped.body)).toBe(200);
        expect(skipped.body).toEqual({
          started: [],
          deferred: [],
          skipped: [{ organization: invalid, reason: "invalid_id" }],
          next: invalid,
          inFlight: expect.any(Number),
          errored: [],
        });
        expect(yield* operator.aggregate(walk)).toMatchObject({
          complete: true,
          organizations: 0,
        });
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportStale.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const operator = yield* v1ImportOperator;
        const secondEmail = `stale-second-${randomUUID().slice(0, 8)}@example.test`;
        const workspace = yield* emulators.v1Workspace([
          `stale-${randomUUID().slice(0, 8)}@example.test`,
          secondEmail,
        ]);
        const second = yield* emulators.v1User(secondEmail);
        const organization = workspace.organization;
        const suffix = randomUUID().slice(0, 6);
        const live = `live_${suffix}`;
        const local = `local_${suffix}`;
        const relative = `relative_${suffix}`;
        const corrupt = `corrupt_${suffix}`;
        const graph = `graph_${suffix}`;
        const hosts = `hosts_${suffix}`;
        const regional = `regional_${suffix}`;
        const revised = `revised_${suffix}`;
        const pastedMcp = `pastedmcp_${suffix}`;
        const gatedMcp = `gatedmcp_${suffix}`;
        const item = (owner: "org" | "user", name: string, integration = live) =>
          `connection:${owner}:${integration}:${name}:token`;
        const saved = (scope: string, itemId: string, value: string) =>
          emulators.v1VaultObject(`${scope}/secrets/${encodeURIComponent(itemId)}`, value);
        // An org connection whose secret a member saved before it was shared: v1 reads it in that
        // member's partition. Another member saved a different value for it, which the report
        // flags without naming either. A token saved on the OAuth method without a client, which
        // v1 sent as is. A connection whose secret the Vault no longer holds has none.
        yield* saved(
          vaultScope(organization, workspace.user),
          item("user", "shared"),
          "synthetic-shared-key",
        );
        yield* saved(
          vaultScope(organization, second),
          item("user", "shared"),
          "synthetic-other-shared-key",
        );
        yield* saved(vaultScope(organization), item("org", "pasted"), "synthetic-pasted-token");
        yield* saved(
          vaultScope(organization),
          item("org", "hostskey", hosts),
          "synthetic-hosts-key",
        );
        yield* saved(
          vaultScope(organization),
          item("org", "signin", pastedMcp),
          "synthetic-signin-token",
        );
        yield* saved(
          vaultScope(organization),
          "oauth-client:org:pasted-client:secret",
          "synthetic-stale-secret-0123456789",
        );
        yield* saved(
          vaultScope(organization),
          item("org", "signin", gatedMcp),
          "synthetic-gated-token",
        );
        const mcp = {
          transport: "remote",
          endpoint: "https://live.example.com/mcp",
          remoteTransport: "auto",
          authenticationTemplate: [
            { slug: "header", kind: "apikey", placements: [{ carrier: "header", name: "X-Key" }] },
            { slug: "oauth", kind: "oauth2" },
          ],
        };
        const spec = (servers: readonly object[]) =>
          JSON.stringify({
            openapi: "3.0.3",
            info: { title: "Stale", version: "1" },
            servers,
            paths: {
              "/items": {
                get: { operationId: "listItems", responses: { "200": { description: "ok" } } },
              },
            },
          });
        const relativeHash = randomUUID().replaceAll("-", "");
        const corruptHash = randomUUID().replaceAll("-", "");
        const hostsHash = randomUUID().replaceAll("-", "");
        const regionalHash = randomUUID().replaceAll("-", "");
        const revisedHash = randomUUID().replaceAll("-", "");
        const ok = { "200": { description: "ok" } };
        // Operations on two services' hosts, and one on a WebSocket server v1 never called.
        const hostsSpec = JSON.stringify({
          openapi: "3.0.3",
          info: { title: "Two services", version: "1" },
          servers: [{ url: "https://api.one.example.com" }],
          paths: {
            "/items": { get: { operationId: "listItems", responses: ok } },
            "/events": {
              get: {
                operationId: "listEvents",
                servers: [{ url: "https://events.two.example.org" }],
                responses: ok,
              },
            },
            "/stream": {
              get: {
                operationId: "openStream",
                servers: [{ url: "wss://stream.two.example.org" }],
                responses: ok,
              },
            },
          },
        });
        const operation = (integration: string, tool: string, path: string) =>
          row(
            "insert into plugin_storage (tenant, plugin_id, collection, key, data) values ($1, 'openapi', 'operation', $2, $3::json)",
            organization,
            `op.${integration}.${tool}`,
            JSON.stringify({
              integration,
              toolName: tool,
              binding: { method: "get", pathTemplate: path },
            }),
          );
        const tool = (integration: string, connection: string, name: string, plugin: string) =>
          row(
            "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name) values ($1, 'org', '', $2, $3, $4, $5)",
            organization,
            integration,
            connection,
            plugin,
            name,
          );
        const oauthClient = (slug: string, clientId: string, secretItem: string | null) =>
          row(
            "insert into oauth_client (tenant, owner, subject, slug, token_url, client_id, client_secret_item_id, origin_kind) values ($1, 'org', '', $2, 'https://signin.example.com/token', $3, nullif($4, ''), 'manual')",
            organization,
            slug,
            clientId,
            secretItem ?? "",
          );
        const oauthMcp = (headers: Record<string, string>, host: string) => ({
          transport: "remote",
          endpoint: `https://${host}/mcp`,
          remoteTransport: "auto",
          headers,
          authenticationTemplate: [{ slug: "oauth", kind: "oauth2" }],
        });
        const integration = (slug: string, plugin: string, name: string, config: object) =>
          row(
            "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, $3, $4, $5::json)",
            organization,
            slug,
            plugin,
            name,
            JSON.stringify(config),
          );
        const connection = (
          integration: string,
          name: string,
          template: string,
          items: object,
          client: string | null = null,
        ) =>
          row(
            "insert into connection (tenant, owner, subject, integration, name, template, item_ids, oauth_client, oauth_client_owner) values ($1, 'org', '', $2, $3, $4, $5::json, nullif($6, ''), nullif($7, ''))",
            organization,
            integration,
            name,
            template,
            JSON.stringify(items),
            client ?? "",
            client === null ? "" : "org",
          );
        const policy = (pattern: string) =>
          row(
            "insert into tool_policy (tenant, owner, subject, pattern, action) values ($1, 'org', '', $2, 'block')",
            organization,
            pattern,
          );
        yield* writeRows("v1-database.json", [
          row(
            "insert into organizations (id, name, slug) values ($1, 'Synthetic stale items', $2)",
            organization,
            `v1-${randomUUID().slice(0, 8)}`,
          ),
          integration(live, "mcp", "Live MCP", mcp),
          integration(local, "mcp", "Local tool", { transport: "stdio", command: "tool" }),
          integration(relative, "openapi", "Relative API", {
            specHash: relativeHash,
            authenticationTemplate: [],
          }),
          integration(corrupt, "openapi", "Corrupt API", {
            specHash: corruptHash,
            authenticationTemplate: [],
          }),
          integration(graph, "graphql", "Ftp GraphQL", {
            endpoint: "ftp://graph.example.com/graphql",
            authenticationTemplate: [],
          }),
          integration(hosts, "openapi", "Two-service API", {
            specHash: hostsHash,
            authenticationTemplate: [
              {
                slug: "header",
                kind: "apikey",
                placements: [{ carrier: "header", name: "X-Key" }],
              },
            ],
          }),
          integration(regional, "openapi", "Regional API", {
            specHash: regionalHash,
            authenticationTemplate: [],
          }),
          integration(revised, "openapi", "Revised API", {
            specHash: revisedHash,
            authenticationTemplate: [],
          }),
          // The organization revised its specification after v1 last listed the tools.
          row(
            "update integration set config_revised_at = 2000 where tenant = $1 and slug = $2",
            organization,
            revised,
          ),
          // An MCP server's fixed headers that are its OAuth client's own ID and secret.
          integration(
            pastedMcp,
            "mcp",
            "Pasted MCP",
            oauthMcp(
              {
                CLIENT_ID: "synthetic-stale-client-0123456789",
                CLIENT_SECRET: "synthetic-stale-secret-0123456789",
              },
              "pasted.example.com",
            ),
          ),
          // A self-hosted MCP server behind a gateway that takes its own client ID and secret.
          integration(
            gatedMcp,
            "mcp",
            "Gated MCP",
            oauthMcp(
              {
                "CF-Access-Client-Id": "synthetic0gateway1client2id.access",
                "CF-Access-Client-Secret": "synthetic-gateway-secret-0123456789",
              },
              "gated.example.com",
            ),
          ),
          row(
            "insert into blob (namespace, key, value) values ($1, $2, $3)",
            `o:${organization}/openapi`,
            `spec/${hostsHash}`,
            hostsSpec,
          ),
          row(
            "insert into blob (namespace, key, value) values ($1, $2, $3)",
            `o:${organization}/openapi`,
            `spec/${regionalHash}`,
            spec([{ url: "https://{region}.regional.example.com" }]),
          ),
          row(
            "insert into blob (namespace, key, value) values ($1, $2, $3)",
            `o:${organization}/openapi`,
            `spec/${revisedHash}`,
            spec([{ url: "https://revised.example.com" }]),
          ),
          operation(hosts, "items.list", "/items"),
          operation(hosts, "events.list", "/events"),
          operation(hosts, "stream.open", "/stream"),
          operation(revised, "items.list", "/items"),
          oauthClient(
            "pasted-client",
            "synthetic-stale-client-0123456789",
            "oauth-client:org:pasted-client:secret",
          ),
          oauthClient("gated-client", "synthetic-gated-client", null),
          row(
            "insert into blob (namespace, key, value) values ($1, $2, $3)",
            `o:${organization}/openapi`,
            `spec/${relativeHash}`,
            spec([{ url: "/v1" }]),
          ),
          row(
            "insert into blob (namespace, key, value) values ($1, $2, $3)",
            `o:${organization}/openapi`,
            `spec/${corruptHash}`,
            JSON.stringify("synthetic text that is not a specification"),
          ),
          connection(live, "shared", "header", { token: item("user", "shared") }),
          connection(live, "pasted", "oauth", { token: item("org", "pasted") }),
          connection(live, "lost", "header", { token: item("org", "lost") }),
          connection(live, "nokey", "header", {}),
          connection(
            live,
            "unclient",
            "oauth",
            { token: item("org", "unclient") },
            "deleted-client",
          ),
          connection(local, "files", "none", {}),
          connection(hosts, "hostskey", "header", { token: item("org", "hostskey", hosts) }),
          connection(revised, "main", "none", {}),
          row(
            "update connection set tools_synced_at = 1000 where tenant = $1 and integration = $2",
            organization,
            revised,
          ),
          tool(revised, "main", "items.list", "openapi"),
          tool(revised, "main", "items.old", "openapi"),
          connection(
            pastedMcp,
            "signin",
            "oauth",
            { token: item("org", "signin", pastedMcp) },
            "pasted-client",
          ),
          connection(
            gatedMcp,
            "signin",
            "oauth",
            { token: item("org", "signin", gatedMcp) },
            "gated-client",
          ),
          row(
            "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name, annotations) values ($1, 'org', '', $2, 'shared', 'mcp', 'search', $3::json)",
            organization,
            live,
            JSON.stringify({ mcp: { toolName: "search" } }),
          ),
          policy(`${live}.*.*.search`),
          policy(`${live}.*.*.unlisted`),
          policy(`${local}.*`),
        ]);

        const run = v1RunId("stale");
        const started = yield* operator.start({
          mode: "dry-run",
          runId: run,
          organizations: [organization],
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const report = yield* operator.waitForReport(run, organization);
        // Nothing blocks it: every item that does not move is one v1 cannot run either.
        expect(report.status, JSON.stringify(report)).toBe("planned");
        expect(report.integrationFailures).toEqual([]);
        expect(report.connectionFailures).toEqual([]);
        expect(report.counts.v2).toMatchObject({ apps: 5, accounts: 6, policies: 2 });
        const stale = report.staleItems
          .map((entry) => [entry.kind, entry.label, entry.integration, entry.category])
          .toSorted((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
        expect(stale).toEqual(
          [
            ["integration", "Local tool", null, "local_server"],
            ["integration", "Relative API", null, "no_base_url"],
            ["integration", "Corrupt API", null, "unreadable_spec"],
            ["integration", "Ftp GraphQL", null, "not_http"],
            ["integration", "Regional API", null, "undefined_server_variable"],
            // An operation on a WebSocket server, and a tool the revised specification dropped,
            // are left out of apps that move.
            ["tool", "stream.open", "Two-service API", "not_http"],
            ["tool", "items.old", "Revised API", "removed_tool"],
            ["connection", "files", "Local tool", "local_server"],
            ["connection", "lost", "Live MCP", "missing_credential"],
            ["connection", "nokey", "Live MCP", "incomplete_credential"],
            ["connection", "unclient", "Live MCP", "missing_client"],
            ["tool_policy", `${local}.*`, "Local tool", "local_server"],
          ].toSorted((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
        );
        // The member's saved secret and the client-less token are read, so neither is stale.
        expect(report.vaultFailures).toEqual([
          expect.objectContaining({ label: "lost", reason: "missing" }),
        ]);
        // A rule that matches no tool still moves, is reported, and does not block.
        expect(report.unmatchedRules).toEqual([
          expect.objectContaining({ pattern: `${live}.*.*.unlisted`, action: "block" }),
        ]);
        // The fixed headers that repeat the MCP server's own OAuth client are left out and
        // reported; the gateway's own credentials move in a second account.
        expect(report.droppedCredentials).toEqual([
          {
            integration: "Pasted MCP",
            carrier: "header",
            name: "CLIENT_ID",
            reason: "oauth_client_id",
          },
          {
            integration: "Pasted MCP",
            carrier: "header",
            name: "CLIENT_SECRET",
            reason: "oauth_client_secret",
          },
        ]);
        // Two members hold different values for the org connection's secret; the first's moves.
        expect(report.memberSecretMismatches).toEqual([
          expect.objectContaining({
            label: "shared",
            integration: "Live MCP",
            members: 2,
            values: 2,
          }),
        ]);
        for (const value of [
          "synthetic-shared-key",
          "synthetic-other-shared-key",
          "synthetic-pasted-token",
          "synthetic-stale-client-0123456789",
          "synthetic-stale-secret-0123456789",
          "synthetic0gateway1client2id",
          "synthetic-gateway-secret",
        ])
          expect(JSON.stringify(report)).not.toContain(value);

        const aggregate = yield* operator.aggregate(run);
        expect(aggregate).toMatchObject({
          statuses: { planned: 1 },
          blocked: [],
          staleItems: {
            byCategory: {
              "integration local_server": 1,
              "integration no_base_url": 1,
              "integration unreadable_spec": 1,
              "integration not_http": 1,
              "integration undefined_server_variable": 1,
              "tool not_http": 1,
              "tool removed_tool": 1,
              "connection local_server": 1,
              "connection missing_credential": 1,
              "connection incomplete_credential": 1,
              "connection missing_client": 1,
              "tool_policy local_server": 1,
            },
          },
        });
        expect(aggregate.staleItems.items).toHaveLength(12);
        expect(aggregate.droppedCredentials).toHaveLength(2);
        expect(aggregate.memberSecretMismatches).toHaveLength(1);
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportBounded.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const operator = yield* v1ImportOperator;
        // v1's database has no row for this organization, so every read of it fails: its
        // assessment fails each attempt and retries for seconds before its report says so.
        const unreadable = yield* emulators.v1Workspace([
          `unread-${randomUUID().slice(0, 8)}@example.test`,
        ]);
        const plain = yield* emulators.v1Workspace([
          `plain-${randomUUID().slice(0, 8)}@example.test`,
        ]);
        yield* writeRows("v1-database.json", [
          row(
            "insert into organizations (id, name, slug) values ($1, 'Synthetic plain', $2)",
            plain.organization,
            `v1-${randomUUID().slice(0, 8)}`,
          ),
        ]);
        const run = v1RunId("bounded");
        const start = (organizations: readonly string[]) =>
          operator
            .start({ mode: "dry-run", runId: run, organizations, maxInFlight: 1 })
            .pipe(
              Effect.tap((response) =>
                Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
              ),
            );
        const instance = (organization: string) => `${organization}-dry-${run}`;

        // One organization at a time: the second waits for room.
        expect((yield* start([unreadable.organization, plain.organization])).body).toEqual({
          started: [
            { organization: unreadable.organization, instance: instance(unreadable.organization) },
          ],
          deferred: [plain.organization],
          skipped: [],
          next: null,
          inFlight: 1,
          errored: [],
        });
        // The first is still retrying its assessment, so a later start has no room either, and
        // does not start or count it again.
        expect((yield* start([unreadable.organization, plain.organization])).body).toEqual({
          started: [],
          deferred: [plain.organization],
          skipped: [{ organization: unreadable.organization, reason: "running" }],
          next: null,
          inFlight: 1,
          errored: [],
        });
        // The bound is the deployment's, not the run's: another run has no room either.
        const other = yield* operator.start({
          mode: "dry-run",
          runId: v1RunId("other"),
          organizations: [plain.organization],
          maxInFlight: 1,
        });
        expect(other.status, JSON.stringify(other.body)).toBe(200);
        expect(other.body).toMatchObject({
          started: [],
          deferred: [plain.organization],
          inFlight: 1,
        });

        // A step that keeps failing ends the run with a report that says so, not a pending one.
        const failed = yield* operator.waitForReport(run, unreadable.organization);
        expect(failed).toMatchObject({
          status: "failed",
          reason:
            "It could not be assessed: v1 or v2 kept failing while it was read (V1ImportUnavailable).",
        });
        expect((yield* start([plain.organization])).body).toEqual({
          started: [{ organization: plain.organization, instance: instance(plain.organization) }],
          deferred: [],
          skipped: [],
          next: null,
          inFlight: 1,
          errored: [],
        });
        expect((yield* operator.waitForReport(run, plain.organization)).status).toBe("planned");
        expect(yield* operator.aggregate(run)).toMatchObject({
          complete: true,
          organizations: 2,
          pending: [],
          errored: [],
          statuses: { failed: 1, planned: 1 },
        });
      }).pipe(Effect.provide(services)),
    ),
  );
});
