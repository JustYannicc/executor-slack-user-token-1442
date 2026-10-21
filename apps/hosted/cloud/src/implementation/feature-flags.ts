/** PostHog owns allocation. The host only asks it which variant a person gets. */
import { Context, Effect, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

const Flags = Schema.Struct({
  flags: Schema.Record(Schema.String, Schema.Unknown),
  errorsWhileComputingFlags: Schema.Boolean,
  quotaLimited: Schema.optional(Schema.Array(Schema.String)),
});
const Flag = Schema.Struct({ enabled: Schema.Boolean, variant: Schema.optional(Schema.String) });

/**
 * Evaluate one flag for one person with the public project token, through PostHog's documented
 * `/flags?v=2` endpoint; no management credential enters the Worker. A missing, disabled, errored
 * or quota-limited flag, a failed request and a one-second timeout all answer `undefined`, which
 * the caller serves as an untracked control.
 */
export const evaluateFlag = (
  settings: { readonly token: string; readonly host: string },
  key: string,
  distinctId: string,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(`${settings.host}/flags?v=2`).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          api_key: settings.token,
          distinct_id: distinctId,
          flag_keys_to_evaluate: [key],
        }),
      ),
    );
    if (response.status !== 200) return yield* Effect.fail("Flag evaluation unavailable");
    const result = yield* response.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Flags)));
    if (result.errorsWhileComputingFlags || result.quotaLimited?.includes("feature_flags"))
      return yield* Effect.fail("Flag evaluation incomplete");
    const value = result.flags[key];
    if (value === undefined) return undefined;
    const flag = yield* Schema.decodeUnknownEffect(Flag)(value);
    return flag.enabled ? flag.variant : undefined;
  }).pipe(
    Effect.timeout("1 second"),
    Effect.catch(() =>
      Effect.logWarning("Feature flag unavailable; serving untracked control").pipe(
        Effect.as(undefined),
      ),
    ),
    Effect.provide(FetchHttpClient.layer),
    Effect.scoped,
  );

/**
 * The request's flag evaluator. Cloud's analytics wrapper installs one when PostHog is
 * configured; without it, as in local development and self-host, every flag is unavailable.
 */
export const FeatureFlags = Context.Reference<{
  readonly evaluate: (key: string, distinctId: string) => Effect.Effect<string | undefined>;
}>("cloud/FeatureFlags", {
  defaultValue: () => ({ evaluate: () => Effect.succeed(undefined) }),
});
