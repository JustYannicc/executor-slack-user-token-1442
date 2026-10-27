/**
 * The hosted management API's request span names the organization it serves by its opaque ID, so
 * one organization's failures can be told apart from another's. A route names its organization by
 * slug or ID, and any signed-in caller can send one, so the span names it only once it is the
 * caller's own: a signed-in session's once its membership there holds, a bearer's once its check
 * authorized it. A request refused for an organization the caller never joined (only Cloud lets a
 * user hold several) or one it left names none, so it cannot count against that organization.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schedule, Schema } from "effect";
import { randomBytes, randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Organization } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";

const Key = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });
const SessionIdentity = Schema.Struct({ user: Schema.Struct({ email: Schema.String }) });
const organizationId = "executor.organization.id";
const route = "/api/organizations/:organization/access";

layer(HostedLive, { excludeTestServices: true })("Organization request spans", (it) => {
  it.effect(scenarios.organizationRequestSpans.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence,
          telemetry = yield* Telemetry,
          target = yield* Target;
        const organization = actors.organization;
        /**
         * `GET /access` of the organization `reference` names, as `actor`'s session or with
         * `key`, and the status and organization its delivered request span records.
         */
        const access = (
          label: string,
          actor: Session,
          reference: string,
          key?: Redacted.Redacted<string>,
        ) =>
          Effect.gen(function* () {
            const traceId = randomBytes(16).toString("hex");
            const response = yield* api.request(
              actor,
              "GET",
              `/api/organizations/${reference}/access`,
              undefined,
              {
                traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01`,
                ...(key === undefined ? {} : { authorization: `Bearer ${Redacted.value(key)}` }),
              },
            );
            const spans = yield* telemetry.query(traceId).pipe(
              Effect.map((result) =>
                result.data
                  .map(({ span }) => span)
                  .filter(
                    (span) =>
                      span.operationName.startsWith("http.server ") &&
                      span.tags["http.route"] === route,
                  ),
              ),
              Effect.flatMap((spans) =>
                spans.length > 0
                  ? Effect.succeed(spans)
                  : Effect.fail(new Error("The request's span has not reached the collector")),
              ),
              Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 40 }),
            );
            yield* evidence.json(`${label}.json`, spans);
            return {
              status: response.status,
              spans: spans.map((span) => [
                span.tags["http.response.status_code"],
                span.tags[organizationId],
              ]),
            };
          });
        const created = yield* api.request(actors.member, "POST", "/api/auth/api-key/create", {
          name: "Organization request spans",
        });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const key = yield* body(Key, created);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.member, "POST", "/api/auth/api-key/delete", { keyId: key.id })
            .pipe(Effect.ignore),
        );

        yield* evidence.step(
          "A member's request names their organization by its ID",
          Effect.gen(function* () {
            expect(
              yield* access("member", actors.member, organization.slug),
              "The route names the organization by slug; the span names its ID",
            ).toEqual({ status: 200, spans: [["200", organization.id]] });
            expect(
              yield* access("member-key", actors.member, organization.slug, key.key),
              "So does a request with the member's API key",
            ).toEqual({ status: 200, spans: [["200", organization.id]] });
          }),
        );

        if (target.metadata.target === "cloud")
          yield* evidence.step(
            "A request for an organization the caller never joined names none",
            Effect.gen(function* () {
              const response = yield* api.request(
                actors.owner,
                "POST",
                "/api/auth/organization/create",
                {
                  name: "Organization request spans, another",
                  slug: `organization-request-spans-${randomUUID().slice(0, 8)}`,
                  keepCurrentActiveOrganization: true,
                },
              );
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              const other = yield* body(Organization, response);
              yield* Effect.addFinalizer(() =>
                api
                  .request(actors.owner, "DELETE", `/api/organizations/${other.id}`)
                  .pipe(Effect.ignore),
              );
              expect(
                yield* access("owner-other", actors.owner, other.slug),
                "Its own member's request names it",
              ).toEqual({ status: 200, spans: [["200", other.id]] });
              expect(
                yield* access("member-other", actors.member, other.slug),
                "A signed-in session refused for it names no organization",
              ).toEqual({ status: 403, spans: [["403", undefined]] });
              expect(
                yield* access("member-key-other", actors.member, other.slug, key.key),
                "Nor does an API key refused for it",
              ).toEqual({ status: 403, spans: [["403", undefined]] });
            }),
          );

        // On both products the member then leaves the organization. Its session and its key
        // outlive the membership.
        yield* evidence.step(
          "A request for an organization the caller left names none",
          Effect.gen(function* () {
            const { user } = yield* body(
              SessionIdentity,
              yield* api.request(actors.member, "GET", "/api/auth/get-session"),
            );
            const removed = yield* api.request(
              actors.owner,
              "POST",
              "/api/auth/organization/remove-member",
              { organizationId: organization.id, memberIdOrEmail: user.email },
            );
            expect(removed.status, JSON.stringify(removed.body)).toBe(200);
            expect(
              yield* access("member-left", actors.member, organization.slug),
              "A signed-in session refused for it names no organization",
            ).toEqual({ status: 403, spans: [["403", undefined]] });
            expect(
              yield* access("member-key-left", actors.member, organization.slug, key.key),
              "Nor does an API key refused for it",
            ).toEqual({ status: 403, spans: [["403", undefined]] });
          }),
        );
      }),
    ),
  );
});
