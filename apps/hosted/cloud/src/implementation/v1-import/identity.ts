/**
 * The v2 identity a v1 organization moves into (`notes/v1-import.md`, Identity): a Better Auth user
 * per imported member, merged by email only when both sides verified it (decision 13), the
 * organization, and a membership per member. Each write records its import map row in the same
 * transaction, so a rerun finds it and never creates a second copy.
 */
import { organizationHandle, organizationSlugMaxLength } from "@executor-js/hosted-server";
import { Effect, Redacted, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { V1ImportUnavailable } from "../../contracts/v1-import.ts";
import { ItemFailed } from "./items.ts";
import type { PlannedMember } from "./members.ts";
import { sourceHash, type ImportStore } from "./store.ts";

const Users = Schema.Array(Schema.Struct({ id: Schema.String, emailVerified: Schema.Boolean }));
const Ids = Schema.Array(Schema.Struct({ id: Schema.String }));
const Slugs = Schema.Array(Schema.Struct({ slug: Schema.String }));

/** What becomes of a member's v1 user in v2. */
export type UserMatch =
  /** A v2 user who verified the same email: the member keeps that account. */
  | { readonly kind: "merge"; readonly user: string }
  /** No v2 user has the email: the import creates one. */
  | { readonly kind: "create" }
  /**
   * A v2 user has the email but has not verified it. v2 emails are unique, so the member can be
   * neither merged nor created beside them; the org does not convert until this is resolved.
   */
  | { readonly kind: "conflict" };

const unavailable = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError(() => new V1ImportUnavailable()));

/**
 * The v2 user an email belongs to. Better Auth stores every email lowercased (its internal
 * adapter lowercases on create and update), as the import does, so the lowercased email is
 * compared as stored and the unique index on `email` finds it.
 */
export const matchUser = (sql: SqlClient.SqlClient, email: string) =>
  sql`select id, "emailVerified" from "user" where email = ${email.toLowerCase()}`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Users)),
    Effect.map((found): UserMatch => {
      const user = found[0];
      if (user === undefined) return { kind: "create" };
      return user.emailVerified ? { kind: "merge", user: user.id } : { kind: "conflict" };
    }),
    unavailable,
  );

/** A suffix derived from the v1 organization's id with the deployment's key, as hex. */
const slugSuffix = (key: Redacted.Redacted<string>, organization: string, attempt: number) =>
  Effect.promise(async () => {
    const hmac = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(Redacted.value(key)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signed = await crypto.subtle.sign(
      "HMAC",
      hmac,
      new TextEncoder().encode(JSON.stringify(["v1-import-slug", organization, attempt])),
    );
    return Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  });

/** The start of a suffixed slug: short enough for `-` and a 6-character suffix. */
const suffixBase = (slug: string) =>
  organizationHandle(slug, organizationSlugMaxLength - 7) || "team";

/**
 * The v2 slug a v1 slug starts from: the v1 slug when it satisfies v2's rule, up to its full
 * length, and otherwise its handle, short enough for a suffix.
 */
export const slugBase = (slug: string) =>
  organizationHandle(slug) === slug ? slug : suffixBase(slug);

/**
 * The v2 slugs an organization tries, in order: the v1 slug when it satisfies v2's rule, then the
 * same with a suffix derived from the v1 organization's id. Derived, not random, so a dry run
 * reports the slug an import would take; keyed with a deployment secret, so nobody can tell the
 * suffix from the public code and take it first. `reserved` leaves out the unsuffixed slug, which
 * another v1 organization holds exactly and takes when it moves.
 */
export const slugCandidates = (
  key: Redacted.Redacted<string>,
  organization: string,
  slug: string,
  reserved: boolean,
) =>
  Effect.gen(function* () {
    const candidates = reserved ? [] : [slugBase(slug)];
    const base = suffixBase(slug);
    for (let attempt = 1; attempt < 5; attempt++)
      candidates.push(`${base}-${(yield* slugSuffix(key, organization, attempt)).slice(0, 6)}`);
    return candidates;
  });

/** The v2 slug a v1 slug becomes: the first candidate no v2 organization has. */
export const plannedSlug = (
  sql: SqlClient.SqlClient,
  candidates: readonly string[],
  slug: string,
) =>
  Effect.gen(function* () {
    const taken = new Set(
      (yield* sql`select slug from organization where ${sql.in("slug", candidates)}`.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Slugs)),
        unavailable,
      )).map((row) => row.slug),
    );
    const free = candidates.find((candidate) => !taken.has(candidate));
    return free === undefined
      ? { slug: null, changed: true }
      : { slug: free, changed: free !== slug };
  });

const conflict = () =>
  new ItemFailed({
    reason:
      "A v2 account has this member's email but has not verified it, so the member can be neither merged nor added.",
  });

/**
 * The member's v2 user: the one an earlier run recorded, a verified v2 user of the same email, or
 * a new one with a verified email and no password, who signs in with a social provider, an email
 * code or SSO. A new user is not queued for the welcome email: the row the user trigger queues is
 * removed in the same transaction, before any delivery can see it.
 */
export const importUser = (
  sql: SqlClient.SqlClient,
  store: ImportStore,
  organization: string,
  member: PlannedMember,
  profile: { readonly email: string; readonly name: string },
) =>
  Effect.gen(function* () {
    const recorded = yield* store.find("user", member.user);
    if (recorded?.status === "imported" && recorded.v2_id !== null) return recorded.v2_id;
    const hash = yield* sourceHash(profile.email);
    const match = yield* matchUser(sql, profile.email);
    if (match.kind === "conflict") return yield* conflict();
    if (match.kind === "merge") {
      yield* store.record({
        organization,
        kind: "user",
        id: member.user,
        result: { status: "imported", v2Kind: "merged_user", v2Id: match.user },
        hash,
      });
      return match.user;
    }
    const id = yield* Effect.sync(() => crypto.randomUUID());
    const created = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const inserted = yield* sql`
            insert into "user" (id, name, email, "emailVerified", image, "createdAt", "updatedAt")
            values (${id}, ${profile.name}, ${profile.email}, true, null, now(), now())
            on conflict do nothing returning id
          `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Ids)));
          if (inserted[0] === undefined) return false;
          yield* sql`delete from cloud_welcome_email where user_id = ${id}`;
          yield* store.record({
            organization,
            kind: "user",
            id: member.user,
            result: { status: "imported", v2Kind: "user", v2Id: id },
            hash,
          });
          return true;
        }),
      )
      .pipe(unavailable);
    if (created) return id;
    // Someone signed up with the email meanwhile: decide again from their account.
    const again = yield* matchUser(sql, profile.email);
    if (again.kind !== "merge") return yield* conflict();
    yield* store.record({
      organization,
      kind: "user",
      id: member.user,
      result: { status: "imported", v2Kind: "merged_user", v2Id: again.user },
      hash,
    });
    return again.user;
  });

/**
 * The member's membership of the imported organization. The owner's comes with the organization.
 * Inserted directly, as an imported membership bypasses the Free plan's member limit.
 */
export const importMembership = (
  sql: SqlClient.SqlClient,
  store: ImportStore,
  input: {
    readonly organization: string;
    readonly target: string;
    readonly member: PlannedMember;
    readonly user: string;
  },
) =>
  Effect.gen(function* () {
    const recorded = yield* store.find("membership", input.member.membership);
    if (recorded?.status === "imported" && recorded.v2_id !== null) return recorded.v2_id;
    const id = yield* Effect.sync(() => crypto.randomUUID());
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* sql`
            select id from member where "organizationId" = ${input.target} and "userId" = ${input.user}
          `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Ids)));
          const member =
            existing[0]?.id ??
            (yield* sql`
              insert into member (id, "organizationId", "userId", role, "createdAt")
              values (${id}, ${input.target}, ${input.user}, ${input.member.role}, now())
              returning id
            `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Ids))))[0]?.id;
          if (member === undefined) return yield* new V1ImportUnavailable();
          yield* store.record({
            organization: input.organization,
            kind: "membership",
            id: input.member.membership,
            result: {
              status: "imported",
              v2Kind: existing[0] === undefined ? "member" : "existing_member",
              v2Id: member,
            },
            hash: yield* sourceHash(input.member.role),
          });
          return member;
        }),
      )
      .pipe(unavailable);
  });

/**
 * The organization the v1 organization moves into: the one an earlier run recorded, or a new one
 * owned by `owner`, named after the v1 organization, at the first of its slug candidates that is
 * free (`candidates`). The map row commits with it.
 */
export const importOrganization = (
  sql: SqlClient.SqlClient,
  store: ImportStore,
  input: {
    readonly organization: string;
    readonly owner: string;
    readonly name: string;
    readonly slug: string;
    /** The slugs to try, in order (`slugCandidates`). */
    readonly candidates: readonly string[];
  },
) =>
  Effect.gen(function* () {
    const recorded = yield* store.find("organization", input.organization);
    if (recorded?.status === "imported" && recorded.v2_id !== null) {
      const target = yield* store.target(recorded.v2_id);
      if (target !== undefined) return target;
      return yield* new ItemFailed({ reason: "Its imported organization was removed in v2." });
    }
    const candidates = input.candidates;
    const hash = yield* sourceHash({ name: input.name, slug: input.slug });
    const created = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const target = yield* store.createOrganization(input.owner, input.name, candidates);
          if (target === undefined) return undefined;
          yield* store.record({
            organization: input.organization,
            kind: "organization",
            id: input.organization,
            result: { status: "imported", v2Kind: "organization", v2Id: target.id },
            hash,
          });
          return target;
        }),
      )
      .pipe(unavailable);
    if (created === undefined)
      return yield* new ItemFailed({ reason: "Every v2 address for the organization is taken." });
    return created;
  });
