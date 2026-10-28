/**
 * Installed catalog apps roll forward to the feed's current source. Each sweep builds the catalog
 * source first, saving nothing. Only an untouched copy whose linked accounts all keep working is
 * deployed; anything else becomes an offer a manager applies. Results live in organization
 * metadata. A daily job queues member setup for every organization with a copy, and member setup
 * sweeps, as the Executor app's upgrades did.
 */
import { createCatalog } from "@executor-js/catalog";
import {
  StorageError,
  sourceFilesEqual,
  type App,
  type Executor,
  type OwnerId,
  type SourceFiles,
} from "@executor-js/sdk/core";
import type { HostEgress } from "@executor-js/utils/url-policy";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { type OrganizationId, organizationOwner } from "../contracts/organization.ts";
import { OrganizationDefaults } from "../contracts/organization-defaults.ts";
import { ScheduleWakeup } from "../contracts/schedules.ts";
import {
  breakingChanges,
  catalogEntryId,
  decideCatalogOffer,
  decideCatalogUpdate,
} from "./catalog-app-changes.ts";
import {
  activeSource,
  appLinks,
  commitCatalogSource,
  deployCatalogSource,
  digestOf,
  recordOf,
  sameRecord,
  saveCatalogRecord,
  savedRecords,
  sourceDigest,
  type ActiveSource,
  type CatalogOutcome,
  type Saved,
} from "./catalog-app-records.ts";
import { pinnedOnly } from "@executor-js/app-management/data-steps";

/** The official app feed installs read, through the same egress. */
export interface CatalogAppFeed {
  readonly egress: HostEgress;
  readonly url: string;
}

/**
 * Decide one catalog copy against the catalog's `files`. Returns what to record, or undefined to
 * keep the earlier record. Only an untouched copy no linked account breaks on is deployed, and
 * only a deploy that became active over the version it was decided against is recorded as the
 * catalog's own.
 */
const decideCatalogApp = (
  executor: Executor,
  input: {
    readonly owner: OwnerId;
    readonly app: App;
    readonly files: SourceFiles;
    readonly recorded: Saved | undefined;
    readonly current: ActiveSource;
  },
) =>
  Effect.gen(function* () {
    const { owner, app, files, recorded, current } = input;
    const { active, commit, clean } = current;
    const digest = yield* sourceDigest(files);
    // The digest recorded at apply stands in for the files, which retain binary ones by
    // reference; without one, comparing files can only miss, costing one redeploy.
    const unchanged =
      (recorded?.applied === digest && recorded.version === active) ||
      sourceFilesEqual(current.files, files);
    const step = decideCatalogUpdate({ unchanged, clean });
    if (step === "skip") return undefined;
    if (step === "record")
      return {
        record: {
          version: active,
          applied: digest,
          ...(clean
            ? { workspace: commit }
            : recorded?.workspace === undefined
              ? {}
              : { workspace: recorded.workspace }),
        },
        active,
        deployed: false,
      } satisfies CatalogOutcome;
    // The same source was already offered against this version, workspace and links: keep it.
    const links = yield* appLinks(app.id);
    const linked = yield* digestOf(
      links.map((link) => [link.requirement, link.subject, link.account, link.provider]).sort(),
    );
    const offer = recorded?.offer;
    if (
      offer?.source === digest &&
      offer.active === active &&
      offer.links === linked &&
      recorded?.workspace === commit
    )
      return undefined;
    // Compile without saving: requirements decide before anything, migrations included, runs.
    const built = yield* executor.apps.build({ owner, name: app.name, files });
    const breaks = breakingChanges(links, app.requirements.accounts, built.requirements.accounts);
    const versions = (yield* executor.apps.versions({ owner, app: app.id, versionOwner: owner }))
      .length;
    const { untouched, decision } = decideCatalogOffer({
      versions,
      active,
      recorded: recorded?.version,
      breaking: breaks.reconnect > 0 || breaks.reasons.length > 0,
    });
    if (decision === "apply")
      return yield* deployCatalogSource(executor, {
        owner,
        app: app.id,
        files,
        digest,
        active,
        commit,
        workspace: current.workspace,
      });
    return {
      record: {
        ...(recorded?.version === undefined ? {} : { version: recorded.version }),
        ...(recorded?.applied === undefined ? {} : { applied: recorded.applied }),
        workspace: commit,
        offer: { ...breaks, source: digest, active, links: linked, touched: !untouched },
      },
      active,
      deployed: false,
    } satisfies CatalogOutcome;
  });

/**
 * The catalog's own version is active and its workspace is still on the revision recorded clean,
 * yet holds other source, as after an update whose commit failed: commit the active source there,
 * keeping a framework pin, so the workspace shows what runs. Undefined when the app is no heal
 * candidate, null when the commit failed. Never heals a version this feature did not record.
 */
const healWorkspace = (
  executor: Executor,
  owner: OwnerId,
  app: App,
  current: ActiveSource,
  recorded: Saved | undefined,
) =>
  Effect.gen(function* () {
    if (
      recorded?.version !== current.active ||
      recorded.workspace !== current.commit ||
      pinnedOnly(current.workspace, current.files)
    )
      return undefined;
    const saved = yield* commitCatalogSource(executor, {
      owner,
      app: app.id,
      files: current.files,
      commit: current.commit,
      workspace: current.workspace,
      message: "Show the running catalog source",
    });
    if (saved === undefined) return null;
    return { ...current, commit: saved.commit, workspace: saved.files, clean: true };
  });

/**
 * Heal the workspace if needed, then decide the copy. A healed workspace is recorded even when
 * nothing else changes.
 */
const updateCatalogApp = (
  executor: Executor,
  input: {
    readonly owner: OwnerId;
    readonly app: App;
    readonly files: SourceFiles;
    readonly recorded: Saved | undefined;
  },
) =>
  Effect.gen(function* () {
    const { owner, app, recorded } = input;
    const read = yield* activeSource(executor, owner, app, recorded);
    if (read === undefined) return undefined;
    const healed = yield* healWorkspace(executor, owner, app, read, recorded);
    if (healed === null) return undefined;
    const current = healed ?? read;
    const outcome = yield* decideCatalogApp(executor, { ...input, current });
    if (outcome !== undefined || healed === undefined) return outcome;
    return {
      record: { ...recorded, workspace: current.commit },
      active: current.active,
      deployed: false,
    } satisfies CatalogOutcome;
  });

/** A build failure is the feed source's own; it stays until the feed changes. */
const unbuildable = (entry: string) =>
  Effect.logWarning("Catalog app update does not build", { entry }).pipe(Effect.as(undefined));

/** What a log may say about a failure: its tag or name, never its content. */
const failureKind = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : error instanceof Error
      ? error.name
      : "unknown";

/**
 * Sweep one organization's copies of `feed`'s apps. Each app's failure is logged and the rest
 * continue; an unreachable feed stops the sweep. An entry whose source the feed no longer serves,
 * or whose source does not build, is left as is. The next pass tries again.
 */
export const catalogAppUpdates = (
  executor: Executor,
  feed: CatalogAppFeed,
  organization: OrganizationId,
) =>
  Effect.suspend(() => {
    let intent = false;
    return Effect.gen(function* () {
      const owner = organizationOwner(organization);
      const saved = yield* savedRecords(organization);
      if (saved === undefined) return;
      const catalog = createCatalog({ egress: feed.egress, feedUrl: feed.url });
      for (const app of yield* executor.apps.list({ owner })) {
        const entry = catalogEntryId(app.copiedFrom?.reference, feed.url);
        if (entry === undefined || app.activeVersion === null) continue;
        const recorded = recordOf(saved, app.id);
        yield* Effect.gen(function* () {
          const prepared = yield* catalog.prepare({ entry });
          if (prepared.origin?.reference !== app.copiedFrom?.reference) return;
          const outcome = yield* updateCatalogApp(executor, {
            owner,
            app,
            files: prepared.files,
            recorded,
          });
          if (outcome === undefined) return;
          // A deploy leaves the app's webhook sources pending.
          if (outcome.deployed) intent = true;
          // A pass that changes nothing writes nothing.
          if (!outcome.deployed && sameRecord(outcome.record, recorded)) return;
          const wrote = yield* saveCatalogRecord(executor, organization, app.id, recorded, outcome);
          if (!wrote && outcome.deployed)
            yield* Effect.logWarning("Catalog app update deployed but was not recorded", { entry });
        }).pipe(
          Effect.catchTags({
            CatalogImportFailed: () => Effect.void,
            AppNotFound: () => Effect.void,
            VersionBuildFailed: () => unbuildable(entry),
            BuildMemoryExceeded: () => unbuildable(entry),
          }),
          // Every other entry reads the same feed.
          Effect.catchIf(
            (error) => error._tag !== "CatalogUnavailable",
            (error) =>
              Effect.logWarning("Catalog app update failed", {
                entry,
                failure: failureKind(error),
              }),
          ),
        );
      }
    }).pipe(
      Effect.ensuring(
        Effect.suspend(() => (intent ? Effect.flatten(ScheduleWakeup) : Effect.void)),
      ),
    );
  });

/**
 * Member setup, then a sweep of the organization's catalog apps when a feed is configured. The
 * sweep never fails member setup: its failures are logged, and the next daily pass retries.
 */
export const withCatalogAppUpdates = (
  executor: Executor,
  feed: CatalogAppFeed | undefined,
  initialize: OrganizationDefaults["Service"],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return OrganizationDefaults.of((organization, user) =>
      Effect.gen(function* () {
        yield* initialize(organization, user);
        if (user !== undefined && feed !== undefined)
          yield* catalogAppUpdates(executor, feed, organization).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.catch((error) =>
              Effect.logWarning("Catalog app updates stopped", { failure: failureKind(error) }),
            ),
          );
      }),
    );
  });

/**
 * Queue member setup for every organization holding a copy of the feed's apps, run as a member
 * who can manage apps, unless member setup is already queued there. A job still running may have
 * been cut short, so it does not count; overlapping sweeps are safe. Hosts run this daily.
 */
export const queueCatalogAppUpdates = (feedUrl: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const apps = new URL("apps/", feedUrl).href;
    yield* sql`insert into hosted_provisioning (kind, organization_id, user_id)
      select distinct on (organization.id) 'member', organization.id, member."userId"
      from organization
      join member on member."organizationId" = organization.id and member.role in ('owner', 'admin')
      join "user" on "user".id = member."userId"
      where exists (select 1 from executor_apps app
          where app.owner = 'organization:' || organization.id
            and left(app.copied_from::jsonb ->> 'reference', length(${apps})) = ${apps})
        and not exists (select 1 from hosted_provisioning job
          where job.kind = 'member' and job.organization_id = organization.id
            and job.status = 'queued')
      order by organization.id, "user"."emailVerified" desc, member.role = 'owner' desc, member."createdAt"`;
  }).pipe(Effect.mapError(() => new StorageError()));
