/**
 * Which v1 organizations a deployment may import, writing v2 (`notes/v1-import.md`, "Where it
 * runs"). Dry runs are never limited by it: they write nothing but their report.
 *
 * - `Refused`: no import writes here, and `reason` says which setting stops it.
 * - `Any`: emulated Cloud's v1, whose organizations are all synthetic.
 * - `Listed`: v1's real data on production. Only the organizations on the allow-list
 *   (`CLOUD_V1_IMPORT_ALLOWED_ORGS`) move, each named explicitly, never by paging through v1.
 *
 * Every import freezes its organization in v1 first and cuts it over at the end, so a deployment
 * that writes always holds the moved flag's writer (`flag`).
 */
import { Data } from "effect";
import type { V1OrganizationId } from "../../contracts/v1-import.ts";
import type { V1MovedFlag } from "./moved-flag.ts";

export type V1ImportWrites = Data.TaggedEnum<{
  Refused: { readonly reason: string };
  Any: { readonly flag: V1MovedFlag };
  Listed: { readonly organizations: ReadonlySet<V1OrganizationId>; readonly flag: V1MovedFlag };
}>;
export const V1ImportWrites = Data.taggedEnum<V1ImportWrites>();

/** Why a real v1 import that does not name its organizations is refused. */
export const v1ImportMustName =
  "An import over v1's real data names its organizations with `organizations`; it never pages through v1 with `after` or `limit`.";

/** Why an organization missing from the allow-list is refused. */
export const v1ImportNotAllowed = (organizations: readonly string[]) =>
  `CLOUD_V1_IMPORT_ALLOWED_ORGS does not list ${organizations.join(", ")}, so it is not imported.`;

/**
 * Why a request to import is refused here, or undefined when it may run. `organizations` is what
 * the request names, undefined when it pages through v1 instead.
 */
export const importRefusal = (
  writes: V1ImportWrites,
  organizations: readonly V1OrganizationId[] | undefined,
): string | undefined =>
  V1ImportWrites.$match(writes, {
    Refused: ({ reason }) => reason,
    Any: () => undefined,
    Listed: ({ organizations: allowed }) => {
      if (organizations === undefined || organizations.length === 0) return v1ImportMustName;
      const missing = organizations.filter((organization) => !allowed.has(organization));
      return missing.length === 0 ? undefined : v1ImportNotAllowed(missing);
    },
  });

/** The moved flag's writer, where imports write. */
export const movedFlag = (writes: V1ImportWrites): V1MovedFlag | undefined =>
  V1ImportWrites.$match(writes, {
    Refused: () => undefined,
    Any: ({ flag }) => flag,
    Listed: ({ flag }) => flag,
  });
