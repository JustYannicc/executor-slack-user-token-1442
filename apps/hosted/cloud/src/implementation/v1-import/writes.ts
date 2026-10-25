/**
 * Which v1 organizations a deployment may import, writing v2 (`notes/v1-import.md`, "Where it
 * runs"). Dry runs are never limited by it: they write nothing but their report.
 *
 * - `Refused`: no import writes here, and `reason` says which setting stops it.
 * - `Listed`: an import names each organization, never pages through v1, and only those with a
 *   row in `private_v1_import_allowed` move. Production and emulated Cloud both check the table;
 *   with no rows, nothing is imported.
 *
 * The table is a guard apart from the operator token: holding the token is not enough to allow an
 * organization. No route, operator command or app path writes it. Rows are added only by direct
 * SQL from someone with access to the database; this code only reads it.
 *
 * Every import freezes its organization in v1 first and cuts it over at the end, so a deployment
 * that writes always holds the moved flag's writer (`flag`).
 */
import { Data, Effect, Schema } from "effect";
import { V1ImportDatabase, V1ImportUnavailable } from "../../contracts/v1-import.ts";
import type { V1MovedFlag } from "./moved-flag.ts";

export type V1ImportWrites = Data.TaggedEnum<{
  Refused: { readonly reason: string };
  Listed: { readonly flag: V1MovedFlag };
}>;
export const V1ImportWrites = Data.taggedEnum<V1ImportWrites>();

/** The table of v1 organizations an import may write; see this module's comment. */
export const v1ImportAllowedTable = "private_v1_import_allowed";

/** Why an import that does not name its organizations is refused. */
export const v1ImportMustName =
  "An import names its organizations with `organizations`; it never pages through v1 with `after` or `limit`.";

/** Why an organization without a row in the allow table is refused. */
export const v1ImportNotAllowed = (organizations: readonly string[]) =>
  `${v1ImportAllowedTable} has no row for ${organizations.join(", ")}, so it is not imported.`;

/**
 * Why a request to import is refused, given which of its organizations have a row in the allow
 * table, or undefined when it may run. `organizations` is what the request names, undefined when
 * it pages through v1 instead.
 */
export const refusalGiven = (
  writes: V1ImportWrites,
  organizations: readonly string[] | undefined,
  allowed: ReadonlySet<string>,
): string | undefined =>
  V1ImportWrites.$match(writes, {
    Refused: ({ reason }) => reason,
    Listed: () => {
      if (organizations === undefined || organizations.length === 0) return v1ImportMustName;
      const missing = organizations.filter((organization) => !allowed.has(organization));
      return missing.length === 0 ? undefined : v1ImportNotAllowed(missing);
    },
  });

const AllowedRows = Schema.Array(Schema.Struct({ v1_org_id: Schema.String }));

/** Which of these organizations have a row in the allow table. Only reads it. */
const allowedOf = (organizations: readonly string[]) =>
  Effect.gen(function* () {
    const sql = yield* Effect.flatten(V1ImportDatabase);
    const rows = yield* sql`
      select v1_org_id from private_v1_import_allowed
      where ${sql.in("v1_org_id", organizations)}
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(AllowedRows)),
      Effect.mapError(() => new V1ImportUnavailable()),
    );
    return new Set(rows.map((row) => row.v1_org_id));
  });

/**
 * Why a request to import is refused here, or undefined when it may run, reading the allow table
 * for the organizations it names (`refusalGiven`).
 */
export const importRefusal = (
  writes: V1ImportWrites,
  organizations: readonly string[] | undefined,
): Effect.Effect<string | undefined, V1ImportUnavailable, V1ImportDatabase> =>
  writes._tag === "Listed" && organizations !== undefined && organizations.length > 0
    ? allowedOf(organizations).pipe(
        Effect.map((allowed) => refusalGiven(writes, organizations, allowed)),
      )
    : Effect.succeed(refusalGiven(writes, organizations, new Set()));

/** Why imports never write here, or undefined where they may. */
export const writesRefused = (writes: V1ImportWrites): string | undefined =>
  V1ImportWrites.$match(writes, {
    Refused: ({ reason }) => reason,
    Listed: () => undefined,
  });

/** The moved flag's writer, where imports write. */
export const movedFlag = (writes: V1ImportWrites): V1MovedFlag | undefined =>
  V1ImportWrites.$match(writes, {
    Refused: () => undefined,
    Listed: ({ flag }) => flag,
  });
