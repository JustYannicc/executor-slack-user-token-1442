/**
 * The shapes the v1 move (`notes/v1-import.md`) decides items with. The server-side `V1Import`
 * Workflow runs it (`v1-import-run.ts`); no request a user sends starts or drives it.
 */
import { ApiError } from "@executor-js/utils/api-error";
import { Context, type Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";

/** A WorkOS organization id in Executor v1. */
export const V1OrganizationId = Schema.String.check(
  Schema.isPattern(/^org_[A-Za-z0-9]{1,64}$/u),
).pipe(Schema.brand("V1OrganizationId"));
export type V1OrganizationId = typeof V1OrganizationId.Type;

/** The v1 records an import moves, besides its identity (users, organization and memberships). */
export const V1ItemKind = Schema.Literals([
  "integration",
  "connection",
  "tool_policy",
  "toolkit",
  "artifact",
]);
export type V1ItemKind = typeof V1ItemKind.Type;
/** A v1 row's `row_id`, unique across v1 tenants. */
export const V1ItemId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(255),
  Schema.isPattern(/^[A-Za-z0-9_.:~-]+$/u),
);
export const V1ItemKey = Schema.Struct({ kind: V1ItemKind, id: V1ItemId });
export type V1ItemKey = typeof V1ItemKey.Type;

/**
 * What importing an item will do. `skipped` items have nothing to import, such as a policy v1
 * never applied; they are not failures and do not hold back the workspace. A `will_import` note
 * says what to know beforehand, such as an artifact that will need repair.
 */
export const V1ItemPlan = Schema.Union([
  Schema.Struct({ status: Schema.Literal("will_import"), note: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ status: Schema.Literal("unsupported"), reason: Schema.String }),
  Schema.Struct({ status: Schema.Literal("skipped"), reason: Schema.String }),
]);
export type V1ItemPlan = typeof V1ItemPlan.Type;
/**
 * What one item request did. `v2Id` names the app, account or MCP connection it created (for a
 * connection, the account it linked to its app);
 * `note` says what the user should know about it, such as a v1 tool name it dropped.
 * `needsRepair` marks an app imported as source without a version, which does not run until it
 * is fixed; its note says what to fix.
 */
export const V1ItemResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("imported"),
    v2Id: Schema.String,
    note: Schema.optionalKey(Schema.String),
    needsRepair: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.Struct({ status: Schema.Literal("failed"), reason: Schema.String }),
  Schema.Struct({ status: Schema.Literal("skipped"), reason: Schema.String }),
]);
export type V1ItemResult = typeof V1ItemResult.Type;

export const V1ImportItem = Schema.Struct({
  ...V1ItemKey.fields,
  /** What the user recognizes: the integration, connection, toolkit or artifact name, or the pattern. */
  label: Schema.String,
  /** The integration a connection, policy or artifact belongs to, by label. */
  context: Schema.NullOr(Schema.String),
  /** The host of the integration's address, for its logo. Never a path or query, which can hold keys. */
  host: Schema.NullOr(Schema.String),
  /** Items that move before this one. */
  dependsOn: Schema.Array(V1ItemKey),
  plan: V1ItemPlan,
  /** The last attempt, once an import has started. */
  result: Schema.NullOr(V1ItemResult),
});
export type V1ImportItem = typeof V1ImportItem.Type;

export const V1ImportUnavailable = ApiError.define({
  tag: "V1ImportUnavailable",
  status: 503,
  message: "Importing from Executor v1 is unavailable. Try again later.",
});
export type V1ImportUnavailable = typeof V1ImportUnavailable.Type;

/** The product database, shared with the executor's writes. */
export class V1ImportDatabase extends Context.Service<
  V1ImportDatabase,
  Effect.Effect<SqlClient.SqlClient, V1ImportUnavailable>
>()("cloud/V1ImportDatabase") {}
