import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient, HttpClientRequest } from "effect/http";
import { acquisitionAppSource } from "./acquisition-product.ts";
import { appsManifest } from "./apps-release.ts";
import { lockedNpmRegistry } from "./npm-registry.ts";
import { Target } from "./platform.ts";

const Ready = Schema.Struct({ port: Schema.Number, owner: Schema.String, app: Schema.String });
const Checks = Schema.Struct({ count: Schema.Number });
const program = `import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { nativeRepositories, systemGit } from "@executor-js/app-source/node";
import {
  createExecutor, makeExecutorStorage, executorHandlers, requestRejections, ExecutorApi, OwnerId, StorageError,
  type Executor, type ExecutorOptions, type ResourceLifecycle,
} from "@executor-js/sdk/core";
import { accountAcquisitionDriver } from "@executor-js/sdk";
import { filesystemBlobStore, workerdApps } from "@executor-js/sdk/node";
import { memoryRegistry } from "@executor-js/sdk/testing";
import { InteractiveStart, InteractiveStatus, HostOperationFailed } from "apps/contracts";
import { Console, Deferred, Effect, Layer, Path, Redacted, Ref, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "fumadb-effect/pglite";
import { createServer } from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Runtime from "@effect/platform-node/NodeRuntime";
import { FetchHttpClient, HttpServerRequest, HttpServerResponse } from "effect/http";

const input = INPUT;
const backendOrigin = input.backendOrigin;
Runtime.runMain(Effect.scoped(Effect.gen(function* () {

  const path = yield* Path.Path;
  const directory = input.directory;
  const database = yield* Layer.build(pgliteLayer());
  const sql = yield* SqlClient.SqlClient.pipe(Effect.provideContext(database));
  const storage = yield* makeExecutorStorage({ provider: "postgresql" }).pipe(Effect.provideContext(database));
  yield* storage.migrate;
  // An adapter failure after external cleanup must roll back the purge, retaining its receipt.
  yield* sql\`create table purge_fault (blocked boolean not null)\`;
  yield* sql\`insert into purge_fault values (false)\`;
  yield* sql\`create function refuse_purge() returns trigger language plpgsql as $$
    begin
      if exists(select 1 from purge_fault where blocked) then
        raise exception 'Synthetic purge storage failure';
      end if;
      return old;
    end $$\`;
  yield* sql\`create trigger refuse_purge before delete on executor_apps for each row execute function refuse_purge()\`;
  const secret = Redacted.make("a".repeat(64));
  const blobs = filesystemBlobStore({ directory: path.join(directory, "blobs") });
  const ready = yield* Deferred.make<Executor>();
  const host = yield* workerdApps({
    directory: path.join(directory, "workerd"), blobs, executor: Deferred.await(ready),
    npmRegistry: input.npmRegistry, encryptionKey: secret, allowPrivateAppFetch: true,
  });
  const retireChecks = yield* Ref.make(0);
  const hooks: ResourceLifecycle = {
    userLinks: () => Effect.succeed([]), appLinks: () => Effect.succeed([]),
    sourceActorLost: () => Effect.void,
    appResolving: (_app, accounts) => Effect.succeed(new Set(accounts.map((a) => a.id))),
    removalResolving: (_app, accounts) => Effect.succeed(new Set(accounts.map((a) => a.id))),
    accountsResolving: (accounts) => Effect.succeed(new Set(accounts.map((a) => a.id))),
    connectionCompleting: () => Effect.void, appCreated: () => Effect.void,
    appRemoving: () => Effect.void, appAccountConnected: () => Effect.void,
    accountCreated: () => Effect.void, accountRemoving: () => Effect.void,
    accountRetiring: () => Ref.update(retireChecks, (n) => n + 1).pipe(Effect.andThen(Effect.fail(new StorageError()))),
  };
  const options: ExecutorOptions = {
    database: storage, secret, blobs, git: nativeRepositories(path.join(directory, "repositories"), systemGit),
    runtime: host.runtime, workflows: host.workflows, registry: memoryRegistry(), hooks,
  };
  const initial = yield* createExecutor(options).pipe(Effect.provide(NodeCrypto.layer));
  yield* Deferred.succeed(ready, initial);
  const owner = OwnerId.make("purge-owner-first");
  const files = input.files;
  const { app } = yield* initial.apps.deploy({ owner, name: "Owner purge manager", files });
  const provider = app.requirements.accounts.identity!.provider;
  const call = async <A, I>(context: import("@executor-js/sdk/core").AccountAcquisitionContext,
    step: string, schema: Schema.Codec<A, I>, data: object = {}) => {
    const response = await context.fetch(\`\${backendOrigin}/connect\`, {
      method: "POST", signal: context.signal,
      headers: { authorization: "Bearer synthetic-backend-key", "content-type": "application/json" },
      body: JSON.stringify({ step, method: context.method, caller: context.owner, operation: context.operation, ...data }),
    });
    if (!response.ok) throw new HostOperationFailed({});
    return Schema.decodeUnknownSync(schema)(await response.json());
  };
  const driver = accountAcquisitionDriver({
    id: "synthetic-purge-driver", revision: "purge-r1",
    start: (ctx) => call(ctx, "start", InteractiveStart),
    status: (ctx, input) => call(ctx, "status", InteractiveStatus, input),
    submit: (ctx, input) => call(ctx, "submit", InteractiveStatus, input),
    cancel: async (ctx, input) => { await call(ctx, "cancel", Schema.Null, input); },
    remove: async (ctx) => { await call(ctx, "remove", Schema.Null, { ref: Redacted.value(ctx.reference) }); },
  });
  const executor = yield* createExecutor({ ...options,
    acquisition: { registrations: [{ provider, method: "paste", current: true, driver, fetch: globalThis.fetch }] },
  }).pipe(Effect.provide(NodeCrypto.layer));
  const routes = Layer.mergeAll(
    HttpApiBuilder.layer(ExecutorApi).pipe(Layer.provide(executorHandlers(executor)), Layer.provide(requestRejections)),
    HttpRouter.add("POST", "/_fixture/purge-fault", Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const blocked = yield* request.json.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Boolean)));
      yield* sql\`update purge_fault set blocked = \${blocked}\`;
      return yield* HttpServerResponse.json(null);
    }).pipe(Effect.orDie)),
    HttpRouter.add("GET", "/_fixture/retire-checks", Effect.gen(function* () {
      return yield* HttpServerResponse.json({ count: yield* Ref.get(retireChecks) });
    })),
  );
  const services = yield* Layer.build(HttpRouter.serve(routes, {
    disableLogger: true, disableListenLog: true,
  }).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))));
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("SDK fixture must listen on TCP");
  yield* Console.log(JSON.stringify({ port: server.address.port, owner, app: app.id }));
  return yield* Effect.never;
})).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))));
`;

/** Run the complete public SDK HTTP host in its own process with real PostgreSQL, Git and workerd adapters. */
export const acquisitionSdk = (backendOrigin: string) =>
  Effect.gen(function* () {
    const target = yield* Target;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const client = yield* HttpClient.HttpClient;
    const files = [
      { path: "index.ts", content: acquisitionAppSource(backendOrigin) },
      appsManifest,
    ] as const;
    const registry = yield* lockedNpmRegistry;
    const entry = path.join(target.directory, "owner-purge-sdk.ts");
    const input = {
      directory: path.join(target.directory, "owner-purge-sdk"),
      backendOrigin,
      npmRegistry: registry.url,
      files,
    };
    const source = program.replace("INPUT", JSON.stringify(input) + " as const");
    const packages = path.join(target.directory, "node_modules");
    yield* fs.makeDirectory(packages, { recursive: true });
    yield* fs.makeDirectory(path.join(packages, "@executor-js"), { recursive: true });
    yield* fs.symlink(path.resolve("packages/apps"), path.join(packages, "apps"));
    yield* fs.symlink(
      path.resolve("packages/app-source"),
      path.join(packages, "@executor-js/app-source"),
    );
    yield* fs.symlink(
      path.resolve("packages/sdk/node_modules/fumadb-effect"),
      path.join(packages, "fumadb-effect"),
    );
    yield* fs.writeFileString(entry, source);
    const config = path.join(target.directory, "owner-purge-sdk-tsconfig.json");
    yield* fs.writeFileString(
      config,
      JSON.stringify({
        extends: path.resolve("tsconfig.json"),
        compilerOptions: { typeRoots: [path.resolve("node_modules/@types")] },
        files: [entry],
        include: [],
        exclude: [],
      }),
    );
    const checked = yield* processes.exitCode(
      ChildProcess.make(path.resolve("node_modules/.bin/tsc-rs"), ["--noEmit", "-p", config], {
        stdout: "inherit",
        stderr: "inherit",
      }),
    );
    if (checked !== 0) return yield* Effect.die("Public SDK host entry failed its typecheck");
    const child = yield* processes.spawn(
      ChildProcess.make("node", [entry], { stdout: "pipe", stderr: "inherit" }),
    );
    const line = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.startsWith('{"port":')),
      Stream.runHead,
    );
    if (Option.isNone(line)) return yield* Effect.die("Public SDK host exited before listening");
    const ready = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Ready))(line.value);
    const origin = `http://127.0.0.1:${ready.port}`;
    const request = (method: "GET" | "POST" | "DELETE", route: string, data?: unknown) =>
      Effect.gen(function* () {
        const base = HttpClientRequest.make(method)(origin + route);
        const configured =
          data === undefined ? base : yield* HttpClientRequest.bodyJson(data)(base);
        const response = yield* client.execute(configured);
        const text = yield* response.text;
        const body = text.length
          ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text)
          : null;
        return { status: response.status, body };
      });
    return {
      owner: ready.owner,
      app: ready.app,
      files,
      request,
      retireChecks: request("GET", "/_fixture/retire-checks").pipe(
        Effect.flatMap((r) => Schema.decodeUnknownEffect(Checks)(r.body)),
        Effect.map((r) => r.count),
      ),
      blockPurge: (blocked: boolean) =>
        request("POST", "/_fixture/purge-fault", blocked).pipe(
          Effect.flatMap((r) =>
            r.status === 200
              ? Effect.void
              : Effect.die("Could not control the synthetic storage fault"),
          ),
        ),
    };
  });
