/** Test stages mint their signing and encryption secrets once; Alchemy state keeps them stable. */
import { Random } from "alchemy";
import { Config, Effect, Option, Redacted, Schema } from "effect";
import { testStage } from "./stage.ts";
import { v1McpForwardSecretName } from "./v1-import-settings.ts";

const SigningSecret = Schema.Redacted(Schema.String.check(Schema.isMinLength(32)));
/** AES-GCM credentials need exactly 32 raw bytes, hex encoded. */
const EncryptionKey = Schema.Redacted(
  Schema.String.check(
    Schema.makeFilter((value) => /^[0-9a-f]{64}$/i.test(value), {
      message: "EXECUTOR_ENCRYPTION_KEY must be 32 hex-encoded bytes",
    }),
  ),
);

export interface CloudSecrets {
  /** Better Auth signing secret. Read it inside an invocation, never at initialization. */
  readonly authSecret: Effect.Effect<Redacted.Redacted<string>>;
  /** Key for stored provider credentials. */
  readonly encryptionKey: Effect.Effect<Redacted.Redacted<string>>;
}

/**
 * Only the credential key. Workers that store credentials but never sign sessions bind this
 * instead of `cloudSecrets`, so they do not receive the auth secret.
 */
export const cloudEncryptionKey = Effect.gen(function* () {
  if (Option.isNone(yield* testStage)) {
    const encryptionKey = yield* Config.Redacted("EXECUTOR_ENCRYPTION_KEY").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(EncryptionKey)),
    );
    return Effect.succeed(encryptionKey);
  }
  return yield* (yield* Random("EncryptionKey", { bytes: 32 })).text;
});

/**
 * Configured stages read both secrets from their environment at deploy time.
 * Test stages own `Random` resources instead; Alchemy binds each value into the Worker
 * and the accessor reads it back at runtime, so nothing is copied into a vault.
 */
export const cloudSecrets = Effect.gen(function* () {
  const encryptionKey = yield* cloudEncryptionKey;
  if (Option.isNone(yield* testStage)) {
    const authSecret = yield* Config.Redacted("BETTER_AUTH_SECRET").pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(SigningSecret)),
    );
    return { authSecret: Effect.succeed(authSecret), encryptionKey } satisfies CloudSecrets;
  }
  const authSecret = yield* Random("AuthSecret");
  return { authSecret: yield* authSecret.text, encryptionKey } satisfies CloudSecrets;
});

/**
 * The secret v1 signs the MCP requests it forwards with (`v1-mcp-forward.ts`), shared with v1's
 * `V2_MCP_FORWARD_SECRET`. A deployment without it accepts no forwarded request. GitHub Actions
 * passes an unset secret as an empty string, so empty means unset.
 */
export const v1McpForwardSecret = Effect.gen(function* () {
  const secret = (yield* Config.Redacted(v1McpForwardSecretName).pipe(Config.option)).pipe(
    Option.filter((value) => Redacted.value(value) !== ""),
  );
  if (
    Option.isSome(secret) &&
    Option.isNone(Schema.decodeUnknownOption(SigningSecret)(secret.value))
  )
    return yield* Effect.die(new Error(`${v1McpForwardSecretName} must be at least 32 characters`));
  return secret;
});
