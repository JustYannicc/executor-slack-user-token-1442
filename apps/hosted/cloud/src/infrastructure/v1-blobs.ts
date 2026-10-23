/**
 * v1's plugin blobs for the import: OpenAPI specs v1 kept only in R2. Production binds v1's bucket
 * by name as `V1_BLOBS` and only ever reads it. The bucket is v1's resource, so this stack never
 * declares it: removing the binding leaves the bucket and its objects as they are. A local live dry
 * run (`CLOUD_V1_IMPORT_SOURCE=live`) has no binding to v1's account and reads objects through
 * Cloudflare's API instead, with GET only.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Option, type Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { V1ImportUnavailable } from "../contracts/v1-import.ts";
import type { V1Blobs } from "../implementation/v1-import/source.ts";
import { v1BlobBucket } from "./v1-import-settings.ts";

/** The one call the import makes on the binding. */
interface ReadOnlyBucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}
const NativeBucket = Schema.declare(
  (value): value is ReadOnlyBucket =>
    typeof value === "object" &&
    value !== null &&
    "get" in value &&
    typeof value.get === "function",
);

/** Bind v1's bucket during Worker initialization; read objects as v1 named them. */
export const v1R2Blobs = Effect.gen(function* () {
  if (!globalThis.__ALCHEMY_RUNTIME__) {
    const worker = yield* Cloudflare.Worker;
    yield* worker.bind("V1Blobs", {
      bindings: [{ type: "r2_bucket", name: "V1_BLOBS", bucketName: v1BlobBucket }],
    });
  }
  const environment = yield* Cloudflare.WorkerEnvironment;
  return {
    missing: "v1's stored specification is missing.",
    get: (key) =>
      Effect.gen(function* () {
        const bucket = yield* Schema.decodeUnknownEffect(NativeBucket)(environment.V1_BLOBS);
        const object = yield* Effect.tryPromise(() => bucket.get(key.object));
        if (object === null) return Option.none();
        return Option.some(new Uint8Array(yield* Effect.tryPromise(() => object.arrayBuffer())));
      }).pipe(
        Effect.tapError(() => Effect.logWarning("v1 import read failed: blob")),
        Effect.mapError(() => new V1ImportUnavailable()),
      ),
  } satisfies V1Blobs;
});

/** Read v1's bucket through Cloudflare's R2 object API: one GET per object, nothing else. */
export const v1ApiBlobs = (account: string, token: Redacted.Redacted<string>) =>
  ({
    missing: "v1's stored specification is missing.",
    get: (key) =>
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient;
        const response = yield* http.execute(
          HttpClientRequest.get(
            `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/r2/buckets/${v1BlobBucket}/objects/${encodeURIComponent(key.object)}`,
          ).pipe(HttpClientRequest.bearerToken(token)),
        );
        if (response.status === 404) return Option.none();
        if (response.status !== 200) return yield* new V1ImportUnavailable();
        return Option.some(new Uint8Array(yield* response.arrayBuffer));
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.tapError(() => Effect.logWarning("v1 import read failed: blob")),
        Effect.mapError(() => new V1ImportUnavailable()),
      ),
  }) satisfies V1Blobs;
