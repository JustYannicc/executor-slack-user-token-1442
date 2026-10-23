/**
 * The v1 moved flag (`org_moved_to_v2` in v1's database; `notes/v1-import.md`, "Cutover per
 * organization"). v2 writes it and v1 only reads it:
 *
 * - `moving`: v1 freezes the organization (cutover step 2). Dashboard and connection writes, OAuth
 *   callbacks and OAuth token refresh fail with a "moving to v2" message, so no refresh token
 *   rotates after the import copies it; MCP calls keep working on the frozen state. An import
 *   writes it before it reads anything it copies.
 * - `moved`, with the v2 organization's id and slug: cutover (step 5). v1 forwards the
 *   organization's MCP requests to v2 and redirects its dashboard there. An import writes it only
 *   after verification passes.
 * - `rolled_back`: v2 gave the organization back, and v1 serves it as before. A rollback writes it.
 *
 * Writes go through `v1_import_writer`, a v1 database role that may only insert and update this
 * table (and read the columns an upsert compares), never read or change anything else in v1.
 */
import { PgClient } from "@effect/sql-pg";
import { Data, Effect, type Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { V1ImportUnavailable } from "../../contracts/v1-import.ts";

/** What v1 should do with an organization. */
export type V1MovedState = Data.TaggedEnum<{
  Moving: {};
  Moved: { readonly v2Organization: string; readonly v2Slug: string };
  RolledBack: {};
}>;
export const V1MovedState = Data.taggedEnum<V1MovedState>();

/** The flag's writer. A write is idempotent: writing the same state again changes nothing. */
export interface V1MovedFlag {
  readonly set: (
    organization: string,
    state: V1MovedState,
  ) => Effect.Effect<void, V1ImportUnavailable>;
}

const stored = (state: V1MovedState) =>
  V1MovedState.$match(state, {
    Moving: () => ({ state: "moving", v2Organization: null, v2Slug: null }),
    Moved: ({ v2Organization, v2Slug }) => ({ state: "moved", v2Organization, v2Slug }),
    RolledBack: () => ({ state: "rolled_back", v2Organization: null, v2Slug: null }),
  });

/**
 * The flag in v1's database, written as `v1_import_writer` (`database` is that role's URL). Each
 * write opens one connection and closes it.
 */
export const v1MovedFlagPostgres = (database: Redacted.Redacted<string>): V1MovedFlag => ({
  set: (organization, state) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const row = stored(state);
      yield* sql`
        insert into org_moved_to_v2 (org_id, state, v2_org_id, v2_org_slug, updated_at)
        values (${organization}, ${row.state}, ${row.v2Organization}, ${row.v2Slug}, now())
        on conflict (org_id) do update set
          state = excluded.state, v2_org_id = excluded.v2_org_id,
          v2_org_slug = excluded.v2_org_slug, updated_at = now()
      `;
    }).pipe(
      Effect.provide(
        PgClient.layer({
          url: database,
          maxConnections: 1,
          prepare: false,
          connectTimeout: "5 seconds",
        }),
      ),
      Effect.mapError(() => new V1ImportUnavailable()),
      Effect.withSpan("v1_import.moved_flag", {
        attributes: { "executor.v1_import.flag": state._tag },
      }),
    ),
});
