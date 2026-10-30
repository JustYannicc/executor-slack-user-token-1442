/** Cadence and retry rules are observed through real OAuth, health and scheduled HTTP traffic. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { reportingCase } from "../support/personal-data-reporting.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Reporting cadence", (it) => {
  it.effect(scenarios.personalDataReconnectCadence.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* reportingCase;
        expect((yield* fixture.run).reportingRequests).toHaveLength(1);
        expect(yield* fixture.connect(fixture.account)).toBe(fixture.account);
        expect((yield* fixture.run).reportingRequests).toHaveLength(1);
      }),
    ),
  );
  it.effect(scenarios.personalDataOldestIdentity.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* reportingCase;
        const checked = yield* fixture.api.request(
          fixture.owner,
          "POST",
          `${fixture.accountPath}/health`,
        );
        expect(checked.status, JSON.stringify(checked.body)).toBe(200);
        const health = yield* body(Schema.Struct({ infoCheckedAt: Schema.String }), checked);
        const metrics = yield* fixture.run;
        expect(metrics.reportingRequests).toHaveLength(1);
        const updatedAt = metrics.reportingRequests[0]?.accounts[0]?.updatedAt;
        expect(updatedAt).toBeDefined();
        expect(Date.parse(updatedAt ?? "")).toBeLessThanOrEqual(Date.parse(health.infoCheckedAt));
      }),
    ),
  );
  it.effect(scenarios.personalDataRetryCadence.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* reportingCase;
        yield* fixture.issuer.configure({ reportingFailure: { status: 429, retryAfter: "0" } });
        expect((yield* fixture.run).reportingRequests).toHaveLength(1);
        yield* fixture.issuer.configure({ reportingFailure: { status: 429, retryAfter: "3600" } });
        expect((yield* fixture.run).reportingRequests).toHaveLength(2);
        expect((yield* fixture.run).reportingRequests).toHaveLength(2);
      }),
    ),
  );
});
