/** Catalog app updates' per-app records in organization metadata, and the guarded write of one. */
import { pinnedOnly } from "@executor-js/app-management/data-steps";
import {
  StorageError,
  StorageHost,
  VersionId,
  sourceFilesEqual,
  type App,
  type AppId,
  type Executor,
  type OwnerId,
  type SourceFiles,
} from "@executor-js/sdk/core";
import { Effect, Schema } from "effect";
import { Hex } from "effect/encoding";
import { SqlClient } from "effect/sql";
import { CatalogAppUpdate } from "../contracts/apps.ts";
import { type OrganizationId, organizationOwner } from "../contracts/organization.ts";

const metadataKey = "catalogApps";
export const Saved = Schema.Struct({
  /** The catalog's own version: the installed copy, or one an update deployed. */
  version: Schema.optionalKey(VersionId),
  /** A workspace commit seen without unsaved edits, or the one an update committed. */
  workspace: Schema.optionalKey(Schema.String),
  /** SHA-256 of the catalog source `version` holds, as the feed serves it. */
  applied: Schema.optionalKey(Schema.String),
  /** A catalog source held back for a manager, decided against the `active` version. */
  offer: Schema.optionalKey(
    Schema.Struct({
      ...CatalogAppUpdate.fields,
      source: Schema.String,
      active: VersionId,
      /** SHA-256 of the app's links the offer was decided against. */
      links: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type Saved = typeof Saved.Type;
const Records = Schema.Struct({ apps: Schema.Record(Schema.String, Saved) });
/** What one app's sweep or update writes, and the active version it was decided against. */
export interface CatalogOutcome {
  readonly record: Saved;
  readonly active: VersionId;
  readonly deployed: boolean;
}

/** The records of every app of the organization, or undefined for a missing organization. */
export const savedRecords = (organization: OrganizationId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`select coalesce(metadata::jsonb -> ${metadataKey}, '{}'::jsonb) as apps
      from organization where id = ${organization}`;
    if (rows.length !== 1) return undefined;
    return (yield* Schema.decodeUnknownEffect(Records)(rows[0])).apps;
  });
/** Whether two records hold the same values, whatever order their keys were read in. */
const recordKeys = [
  ...Object.keys(Saved.fields),
  ...Object.keys(CatalogAppUpdate.fields),
  "source",
  "active",
  "links",
];
export const sameRecord = (left: Saved, right: Saved | undefined) =>
  right !== undefined && JSON.stringify(left, recordKeys) === JSON.stringify(right, recordKeys);
export const recordOf = (records: Readonly<Record<string, Saved>> | undefined, app: AppId) =>
  records !== undefined && Object.hasOwn(records, app) ? records[app] : undefined;

/**
 * SHA-256 of catalog source as the feed serves it. Retained versions store binary public files
 * by reference, so comparing files alone would never match a catalog source that has any.
 */
export const sourceDigest = (files: SourceFiles) => digestOf(files);
/** SHA-256 of a JSON value, as hex. */
export const digestOf = (value: unknown) =>
  Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
    catch: () => new StorageError(),
  }).pipe(Effect.map((digest) => Hex.encode(new Uint8Array(digest))));

/** The active source and whether the workspace holds unsaved edits; undefined while it moves. */
export const activeSource = (
  executor: { readonly apps: Executor["apps"] },
  owner: OwnerId,
  app: App,
  recorded: Saved | undefined,
) =>
  Effect.gen(function* () {
    const source = yield* executor.apps.source({ owner, app: app.id });
    if (app.activeVersion === null || source.id !== app.activeVersion) return undefined;
    const workspace = yield* executor.apps.workspace({ owner, app: app.id });
    const commit = workspace.revision.commit;
    // Deploying files never edits Git, so the commit last seen clean stays clean after them.
    const clean = pinnedOnly(workspace.files, source.files) || commit === recorded?.workspace;
    return {
      active: app.activeVersion,
      files: source.files,
      workspace: workspace.files,
      commit,
      clean,
    };
  });

const Links = Schema.Array(
  Schema.Struct({
    requirement: Schema.String,
    scope: Schema.String,
    subject: Schema.NullOr(Schema.String),
    account: Schema.String,
    provider: Schema.String,
  }),
);
/** Every account linked to the app, in both scopes, with its provider. */
export const appLinks = (app: AppId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql`select l.requirement, l.subject, l.account, a.provider,
        case when l.subject is null then 'app' else 'user' end as scope
      from hosted_app_account_links l join executor_accounts a on a.id = l.account
      where l.app = ${app}`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Links)));
  }).pipe(Effect.mapError(() => new StorageError()));

/**
 * Deploy catalog source over the `active` version it was decided against, then commit it to the
 * workspace's main from the clean revision `commit`, so the workspace shows what runs. A person's
 * deploy or activation since then fails the deploy, and the result is undefined. A workspace that
 * moved meanwhile keeps its edit and the outcome records no clean revision, so the next sweep
 * leaves the app alone.
 */
export const deployCatalogSource = (
  executor: { readonly apps: Executor["apps"] },
  input: {
    readonly owner: OwnerId;
    readonly app: AppId;
    readonly files: SourceFiles;
    readonly digest: string;
    readonly active: VersionId;
    readonly commit: string;
    readonly workspace: SourceFiles;
  },
) =>
  Effect.gen(function* () {
    const { owner, app, files } = input;
    const deployed = yield* executor.apps
      .deploy({ owner, app, files, expectedVersion: input.active })
      .pipe(Effect.catchTag("AppVersionChanged", () => Effect.succeed(undefined)));
    if (deployed === undefined || deployed.app.activeVersion !== deployed.version.id)
      return undefined;
    const workspace = sourceFilesEqual(input.workspace, files)
      ? input.commit
      : yield* executor.apps
          .commit({
            owner,
            app,
            expected: input.commit,
            files,
            message: "Update to the catalog's current source",
          })
          .pipe(
            Effect.map((saved): string | undefined => saved.revision.commit),
            // The deploy already activated, so a failed commit never fails the update.
            Effect.catch((error) =>
              error._tag === "SourceError" && error.reason === "conflict"
                ? Effect.succeed(undefined)
                : // Deploying never edits Git, so the revision read is still the clean one.
                  Effect.logWarning("Catalog app update could not commit its source", {
                    failure: error._tag,
                  }).pipe(Effect.as(input.commit)),
            ),
          );
    return {
      record: {
        version: deployed.version.id,
        applied: input.digest,
        ...(workspace === undefined ? {} : { workspace }),
      },
      active: deployed.version.id,
      deployed: true,
    } satisfies CatalogOutcome;
  });

/**
 * Write an outcome under the app's lock, only while its record is still the one it was decided
 * from and the app's active version is the one it expects. Overlapping sweeps, retries and
 * manager updates cannot record a stale read. Returns whether it wrote.
 */
export const saveCatalogRecord = (
  executor: Executor,
  organization: OrganizationId,
  app: AppId,
  read: Saved | undefined,
  outcome: CatalogOutcome,
) =>
  executor[StorageHost].transaction(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`select pg_advisory_xact_lock(hashtextextended(${`catalog-apps:${app}`}, 0))`;
      const [row] = yield* sql<{ same: boolean }>`select
        (metadata::jsonb -> ${metadataKey} -> ${app}) is not distinct from
          ${read === undefined ? null : JSON.stringify(read)}::jsonb as same
        from organization where id = ${organization} for no key update`;
      if (row?.same !== true) return false;
      const locked = yield* executor.apps.get({ owner: organizationOwner(organization), app });
      if (locked.activeVersion !== outcome.active) return false;
      yield* sql`update organization set metadata = jsonb_set(coalesce(metadata::jsonb, '{}'::jsonb),
        array[${metadataKey}], coalesce(metadata::jsonb -> ${metadataKey}, '{}'::jsonb)
          || jsonb_build_object(${app}::text, ${JSON.stringify(outcome.record)}::jsonb))::text
        where id = ${organization}`;
      return true;
    }),
  );
