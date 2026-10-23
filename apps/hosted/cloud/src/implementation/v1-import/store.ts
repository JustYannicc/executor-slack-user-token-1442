/**
 * The import map (`private_v1_import_map`) and the v2 organizations an import writes into. Each
 * row records one v1 item's v2 resource, or why it failed; `(v1_kind, v1_id)` is unique.
 */
import { OrganizationId } from "@executor-js/hosted-server";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { V1ImportUnavailable } from "../../contracts/v1-import.ts";

/**
 * Map kinds: the item kinds, plus `organization`, `user` and `membership` (the v2 identity),
 * `fixed_credentials`, the account an integration's app holds its fixed credentials in (by the
 * integration), and `profile`, which records a connection's link to its app beside its account.
 * `profile` keeps the name from when connections became profiles, so earlier rows still read; see
 * `mapLookup`. A toolkit has a row per member copy, keyed by the toolkit and the member
 * (`toolkitCopyKey`).
 */
export type MapKind =
  | "organization"
  | "user"
  | "membership"
  | "integration"
  | "fixed_credentials"
  | "connection"
  | "profile"
  | "tool_policy"
  | "toolkit"
  | "artifact";

export const MapRow = Schema.Struct({
  v1_kind: Schema.String,
  v1_id: Schema.String,
  v2_kind: Schema.NullOr(Schema.String),
  v2_id: Schema.NullOr(Schema.String),
  status: Schema.Literals(["imported", "failed", "skipped"]),
  /** Why it failed or was skipped; for an imported item, its note. */
  reason: Schema.NullOr(Schema.String),
  source_hash: Schema.String,
});
export type MapRow = typeof MapRow.Type;

export type MapResult =
  | {
      readonly status: "imported";
      readonly v2Kind: string;
      readonly v2Id: string;
      readonly note?: string | undefined;
    }
  | { readonly status: "failed" | "skipped"; readonly reason: string };

const Target = Schema.Struct({
  id: OrganizationId,
  name: Schema.String,
  slug: Schema.NonEmptyString,
});
const Owned = Schema.Array(Target);

/** SHA-256 of the v1 rows an item was imported from, to skip it while they stay unchanged. */
export const sourceHash = (value: unknown) =>
  Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
  ).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

const unavailable = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(() => new V1ImportUnavailable()));

export const makeImportStore = (sql: SqlClient.SqlClient) => {
  const rows = (organization: string) =>
    sql`
      select v1_kind, v1_id, v2_kind, v2_id, status, reason, source_hash
      from private_v1_import_map where v1_org_id = ${organization}
    `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(MapRow))), unavailable);
  const find = (kind: MapKind, id: string) =>
    sql`
      select v1_kind, v1_id, v2_kind, v2_id, status, reason, source_hash
      from private_v1_import_map where v1_kind = ${kind} and v1_id = ${id}
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(MapRow))),
      Effect.map((found) => found[0]),
      unavailable,
    );
  /** Record an attempt. A v1 item keeps one row; a later attempt replaces its result. */
  const record = (input: {
    readonly organization: string;
    readonly kind: MapKind;
    readonly id: string;
    readonly result: MapResult;
    readonly hash: string;
  }) => {
    const imported = input.result.status === "imported" ? input.result : undefined;
    const reason =
      input.result.status === "imported" ? (input.result.note ?? null) : input.result.reason;
    return sql`
      insert into private_v1_import_map
        (v1_org_id, v1_kind, v1_id, v2_kind, v2_id, status, reason, source_hash, updated_at)
      values (${input.organization}, ${input.kind}, ${input.id}, ${imported?.v2Kind ?? null},
        ${imported?.v2Id ?? null}, ${input.result.status}, ${reason}, ${input.hash}, now())
      on conflict (v1_kind, v1_id) do update set
        v2_kind = excluded.v2_kind, v2_id = excluded.v2_id, status = excluded.status,
        reason = excluded.reason, source_hash = excluded.source_hash, updated_at = now()
      where private_v1_import_map.v1_org_id = excluded.v1_org_id
    `.pipe(Effect.asVoid, unavailable);
  };
  const target = (id: string) =>
    sql`select id, name, slug from organization where id = ${id}`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Owned)),
      Effect.map((found) => found[0]),
      unavailable,
    );
  /**
   * A new organization owned by the user, named after the v1 organization, at the first of
   * `candidates` no organization has, or none when every one is taken. Creating it queues the usual team, billing and default-app
   * jobs. The user's first organization also completes onboarding.
   */
  const createOrganization = (userId: string, name: string, candidates: readonly string[]) =>
    Effect.gen(function* () {
      for (const candidate of candidates) {
        const id = yield* Effect.sync(() => crypto.randomUUID());
        const memberId = yield* Effect.sync(() => crypto.randomUUID());
        // The unique slug arbitrates concurrent names; a collision writes nothing.
        const created = yield* sql`with created as (
          insert into organization (id, name, slug, logo, "createdAt")
            values (${id}, ${name}, ${candidate}, null, now())
            on conflict (slug) do nothing returning id, name, slug
        ), owner as (
          insert into member (id, "organizationId", "userId", role, "createdAt")
            select ${memberId}, created.id, ${userId}, 'owner', now() from created
            returning "organizationId"
        ), setup as (
          insert into cloud_organization_setup (user_id, organization_id, domain, applied)
            select ${userId}, owner."organizationId", null, true from owner
            on conflict (user_id) do nothing
        ) select created.id, created.name, created.slug from created join owner
          on owner."organizationId" = created.id
        `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Owned)));
        if (created[0] !== undefined) return created[0];
      }
      return undefined;
    }).pipe(unavailable);
  return { rows, find, record, target, createOrganization };
};
export type ImportStore = ReturnType<typeof makeImportStore>;
