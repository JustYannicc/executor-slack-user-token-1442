/**
 * The CLI's background service: one Executor per data directory on a fixed port, started or
 * joined by local commands, managed with `executor service`, and stopped only when asked. Every
 * scenario runs the real CLI against its own HOME, data directory and port; see
 * `support/background-service.ts`.
 */
import { expect, layer } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createServer } from "node:http";
import {
  Clock,
  Context,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Ref,
  Schema,
} from "effect";
import {
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { scenarios } from "../test-plan.ts";
import { Api, SessionClients } from "../support/api.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { freePort } from "../support/ports.ts";
import {
  backgroundServiceCli,
  crashServer,
  eventually,
  stoppingServer,
} from "../support/background-service.ts";
import { suspendProcess } from "../support/desktop.ts";

const starting = "Starting background Executor...";
const keysSaved = "keys saved to ";
const Apps = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String })),
);
/** An apps command's failure as it prints it on stdout for programs. */
const AppsFailure = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ code: Schema.String, message: Schema.String }) }),
);
const escaped = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Serve `routes` on a loopback port, by default a free one, for the current scope; its URL. */
const serving = <E, R>(routes: Layer.Layer<never, E, R>, port = 0) =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port })),
      ),
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
    if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
    return `http://127.0.0.1:${server.address.port}`;
  });

/** A JSON record whose fields this test keeps as they are when it rewrites one of them. */
const RecordJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

const LockOwner = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Number,
    started: Schema.optional(Schema.String),
    boot: Schema.optional(Schema.String),
    pipe: Schema.optional(Schema.String),
    host: Schema.String,
    port: Schema.Number,
  }),
);

/** On Windows, what names a lock's owner: the pipe it listens on while it holds the lock. */
const lockPipe = /^\\\\\.\\pipe\\executor-lock-[\w-]+$/u;

/**
 * A data directory's `.server.lock`: when its holder last refreshed it, and the owner a server
 * records in it, `{ pid, started, boot, host, port }` on Linux and macOS and
 * `{ pid, pipe, host, port }` on Windows, if readable.
 */
const lockOf = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(directory, ".server.lock");
    const ownerFile = path.join(file, "owner.json");
    const owner = fs
      .readFileString(ownerFile)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(LockOwner)), Effect.option);
    return {
      file,
      ownerFile,
      refreshed: fs
        .stat(file)
        .pipe(Effect.map(({ mtime }) => Option.getOrUndefined(mtime)?.getTime() ?? 0)),
      owner,
      /** The owner's process and port. */
      holder: owner.pipe(Effect.map(Option.map(({ pid, port }) => ({ pid, port })))),
    };
  });

/** Requests to another local origin, such as the background server's, with their own cookies. */
const apiAt = (origin: string) =>
  Effect.gen(function* () {
    const target = yield* Target;
    const services = yield* Layer.build(
      Api.layer.pipe(
        Layer.provide(SessionClients.layer),
        Layer.provide(
          Layer.succeed(Target, Target.of({ ...target, metadata: { ...target.metadata, origin } })),
        ),
      ),
    );
    return Context.get(services, Api);
  });

layer(TestLive, { excludeTestServices: true })("Local background service", (it) => {
  it.effect(
    scenarios.localServiceSharedStart.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cli = yield* backgroundServiceCli();

          // Both commands race to start a server; the fixed port and the data directory's lock
          // leave one, and both print its URL.
          const [first, second] = yield* Effect.all(
            [cli.run(["service", "start"]), cli.run(["service", "start"])],
            { concurrency: 2 },
          );
          expect(first.code, first.stderr).toBe(0);
          expect(second.code, second.stderr).toBe(0);
          expect(first.stdout.trim()).toBe(cli.url);
          expect(second.stdout.trim()).toBe(cli.url);

          const registration = yield* cli.registered;
          expect(registration.url).toBe(cli.url);
          expect(yield* cli.info(cli.url)).toEqual({
            status: 200,
            body: {
              id: registration.id,
              version: registration.version,
              pid: registration.pid,
              status: "ready",
            },
          });
          // The registration carries the server's password, so only its owner may read it.
          if (process.platform !== "win32")
            expect((yield* fs.stat(cli.registrationFile)).mode & 0o777).toBe(0o600);

          // No contender that lost the race took over afterwards: a later start finds the same one.
          const third = yield* cli.run(["service", "start"]);
          expect(third.code, third.stderr).toBe(0);
          expect(third.stdout.trim()).toBe(cli.url);
          expect(third.stderr).not.toContain(starting);
          const after = yield* cli.registered;
          expect([after.id, after.pid]).toEqual([registration.id, registration.pid]);
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceJoin.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const cli = yield* backgroundServiceCli();
          const started = yield* cli.run(["service", "start"]);
          expect(started.code, started.stderr).toBe(0);
          // The background server's own stderr has no reader, so the start names the key file.
          expect(started.stderr).toContain(
            `EXECUTOR_KEY_STORAGE=file; ${keysSaved}${path.join(cli.data, "keys.json")}`,
          );
          const before = yield* cli.registered;

          // `executor` uses the running server: it prints where it runs and the link, opens the
          // link and exits, leaving the same server running.
          const joined = yield* cli.run([]);
          expect(joined.code, joined.stderr).toBe(0);
          expect(joined.stderr).not.toContain(starting);
          expect(joined.stderr).not.toContain(keysSaved);
          const lines = joined.stdout.trim().split("\n");
          expect(lines.slice(0, 3)).toEqual([
            `Executor: ${cli.url}`,
            `MCP: ${cli.url}/mcp`,
            "Connect (one use, expires in 5 minutes):",
          ]);
          // A fifth line would say the browser could not be opened.
          expect(lines).toHaveLength(4);
          const link = lines[3] ?? "";
          expect(link).toMatch(new RegExp(`^${escaped(cli.url)}/#pair=[a-f0-9]{64}$`, "u"));
          expect(yield* cli.opened).toEqual([link]);
          const after = yield* cli.registered;
          expect([after.id, after.pid]).toEqual([before.id, before.pid]);

          // The opened link pairs a browser with that server, once.
          const api = yield* apiAt(cli.url);
          const browser = yield* api.session();
          const token = new URL(link).hash.slice("#pair=".length);
          const exchanged = yield* api.request(browser, "POST", "/auth/exchange", { token });
          expect(exchanged).toEqual({ status: 200, body: { authenticated: true } });
          const session = yield* api.request(browser, "GET", "/auth/session");
          expect(session).toEqual({ status: 200, body: { authenticated: true } });
          const replay = yield* api.request(yield* api.session(), "POST", "/auth/exchange", {
            token,
          });
          expect(replay.status).toBe(401);
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceVersion.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const cli = yield* backgroundServiceCli();
          // The other releases are the checkout's CLI, which reports EXECUTOR_BUILD_VERSION. The
          // CLI under test reports its own release version when it is a release executable.
          const [older, other] = ["2.0.0-e2e.1", "2.0.0-e2e.3"];
          const current = { EXECUTOR_BUILD_VERSION: "2.0.0-e2e.2" };
          const printed = yield* cli.run(["--version"], current);
          expect(printed.code, printed.stderr).toBe(0);
          const newer = printed.stdout.trim().replace(/^executor v/u, "");
          expect([older, other]).not.toContain(newer);
          const started = yield* cli.run(
            ["service", "start"],
            { EXECUTOR_BUILD_VERSION: older },
            { source: true },
          );
          expect(started.code, started.stderr).toBe(0);
          const first = yield* cli.registered;
          expect(first.version).toBe(older);

          // The interactive command replaces a server of another version with its own.
          const replaced = yield* cli.run([], current);
          expect(replaced.code, replaced.stderr).toBe(0);
          expect(replaced.stderr).toContain(
            `Restarting background Executor (running ${older}, this is ${newer})...`,
          );
          expect(replaced.stdout).toContain(`Executor: ${cli.url}\n`);
          const second = yield* cli.registered;
          expect(second.version).toBe(newer);
          expect(second.pid).not.toBe(first.pid);
          expect(yield* cli.alive(first.pid)).toBe(false);
          expect(yield* cli.info(cli.url)).toEqual({
            status: 200,
            body: { id: second.id, version: newer, pid: second.pid, status: "ready" },
          });

          // Other commands use whichever version runs.
          const kept = yield* cli.run(
            ["service", "start"],
            { EXECUTOR_BUILD_VERSION: other },
            { source: true },
          );
          expect(kept.code, kept.stderr).toBe(0);
          expect(kept.stdout.trim()).toBe(cli.url);
          expect(kept.stderr).not.toContain("background Executor");
          const third = yield* cli.registered;
          expect([third.id, third.pid, third.version]).toEqual([second.id, second.pid, newer]);
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceStandalone.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cli = yield* backgroundServiceCli();
          const standalone = yield* cli.start(["--standalone"], (line) =>
            line.startsWith("Executor: "),
          );
          const origin = standalone.line.slice("Executor: ".length);
          expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
          expect(origin).not.toBe(cli.url);
          const port = Number(new URL(origin).port);

          // The private server answers, while nothing registers or listens on the service port.
          expect((yield* cli.info(origin)).body.status).toBe("ready");
          expect(yield* fs.exists(cli.registrationFile)).toBe(false);
          expect(yield* cli.refused(cli.port)).toBe(true);

          // A background server cannot start meanwhile, and since the private server is not
          // registered, the message does not offer `executor service stop`, which cannot stop it.
          const blocked = yield* cli.run(["service", "start"]);
          expect(blocked.code).toBe(1);
          expect(blocked.stderr).toContain(
            `The background Executor could not start.\nAnother Executor is using the data directory ${cli.data}, and it is not the background Executor, so \`executor service stop\` cannot stop it.`,
          );
          expect(yield* fs.exists(cli.registrationFile)).toBe(false);

          // Interrupting the command, as Ctrl-C does, stops its server. The private server leads a
          // process group of its own, so on POSIX only the command gets SIGINT, and it exits as an
          // interrupted program does. Windows has no SIGINT for another process, and ending the
          // command's process tree would end the private server directly, so only the command is
          // ended there: the private server then stops because its standard input closed.
          if (process.platform === "win32")
            yield* Effect.try(() => process.kill(standalone.child.pid, "SIGTERM"));
          else yield* standalone.child.kill({ killSignal: "SIGINT" });
          const interrupted = yield* standalone.child.exitCode.pipe(Effect.timeout("30 seconds"));
          if (process.platform !== "win32") expect(Number(interrupted)).toBe(130);
          expect(yield* eventually(cli.refused(port), (refused) => refused, "15 seconds")).toBe(
            true,
          );
          expect(yield* fs.exists(cli.registrationFile)).toBe(false);

          // When the private server stops on its own, the command says so and fails instead of
          // waiting with a dead link.
          const crashed = yield* cli.start(["--standalone"], (line) =>
            line.startsWith("Executor: "),
          );
          const own = new URL(crashed.line.slice("Executor: ".length));
          yield* crashServer((yield* cli.info(own.origin)).body.pid);
          const code = yield* crashed.child.exitCode.pipe(Effect.timeout("30 seconds"));
          expect(Number(code)).toBe(1);
          expect(yield* crashed.output).toContain(
            "This command's private Executor server stopped (",
          );

          // While the background server holds the data directory, the private server says so,
          // and the command does not claim the background server failed.
          const started = yield* cli.run(["service", "start"]);
          expect(started.code, started.stderr).toBe(0);
          const held = yield* cli.run(["--standalone"]);
          expect(held.code).toBe(1);
          expect(held.stderr).toContain(
            `This command's private Executor server could not start.\nThe background Executor already serves the data directory ${cli.data} at ${cli.url}.`,
          );
          expect(held.stderr).not.toContain("background Executor could not start");
          expect(held.stderr).not.toContain("executorService");
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServicePortInUse.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          // Another program answers HTTP on the configured port, and not as Executor.
          const services = yield* Layer.build(
            HttpRouter.serve(
              HttpRouter.add(
                "*",
                "/*",
                HttpServerResponse.text("<h1>Not Executor</h1>", {
                  status: 404,
                  contentType: "text/html",
                }),
              ),
              { disableLogger: true, disableListenLog: true },
            ).pipe(
              Layer.provideMerge(
                NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }),
              ),
            ),
          );
          const foreign = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
          if (!("port" in foreign.address)) return yield* Effect.die("Fixture must listen on TCP");
          const cli = yield* backgroundServiceCli({ port: foreign.address.port });

          // EXECUTOR_PORT chose the port, so changing the saved port would not help.
          const refused = yield* cli.run(["service", "start"]);
          expect(refused.code).toBe(1);
          expect(refused.stderr).toContain("The background Executor could not start.");
          expect(refused.stderr).toContain(
            `Port ${cli.port} is already in use by another program. EXECUTOR_PORT is set to ${cli.port} and wins over the \`port\` setting: set EXECUTOR_PORT to another port, or unset it, then try again.`,
          );
          expect(yield* fs.exists(cli.registrationFile)).toBe(false);

          // The saved port chose it, so the message names the setting.
          const saved = { EXECUTOR_PORT: undefined };
          const set = yield* cli.run(["service", "set", "port", String(cli.port)], saved);
          expect(set.code, set.stderr).toBe(0);
          const setting = yield* cli.run(["service", "start"], saved);
          expect(setting.code).toBe(1);
          expect(setting.stderr).toContain(
            `Port ${cli.port} is already in use by another program. Choose another port with \`executor service set port <port>\`, then run \`executor\` again.`,
          );

          // An apps command reports the same failure in its own contract, with JSON on stdout.
          const apps = yield* cli.run(["apps", "list"]);
          expect(apps.code).toBe(1);
          expect(apps.stderr).toContain("Code: LocalServerUnavailable");
          const failure = yield* Schema.decodeUnknownEffect(AppsFailure)(apps.stdout);
          expect(failure.error.code).toBe("LocalServerUnavailable");
          expect(failure.error.message).toContain(`Port ${cli.port} is already in use`);
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceLifecycle.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cli = yield* backgroundServiceCli();
          // A client's own credential, without an encryption key, is only what it would send; the
          // server it starts still uses the data directory's keys.
          const started = yield* cli.run(["service", "start"], {
            EXECUTOR_API_KEY: "a".repeat(64),
          });
          expect(started.code, started.stderr).toBe(0);
          expect(started.stdout.trim()).toBe(cli.url);
          const first = yield* cli.registered;

          const status = yield* cli.run(["service", "status"]);
          expect(status.code, status.stderr).toBe(0);
          expect(status.stdout.trim()).toBe(
            `${cli.url} (version ${first.version}, process ${first.pid})`,
          );

          // Restart stops the server and starts another in its place.
          const restarted = yield* cli.run(["service", "restart"]);
          expect(restarted.code, restarted.stderr).toBe(0);
          expect(restarted.stdout.trim()).toBe(cli.url);
          const second = yield* cli.registered;
          expect(second.pid).not.toBe(first.pid);
          expect(yield* cli.alive(first.pid)).toBe(false);
          expect((yield* cli.info(cli.url)).body).toEqual({
            id: second.id,
            version: second.version,
            pid: second.pid,
            status: "ready",
          });

          // Stop ends the process, frees its port and removes its registration.
          const stopped = yield* cli.run(["service", "stop"]);
          expect(stopped.code, stopped.stderr).toBe(0);
          expect(yield* fs.exists(cli.registrationFile)).toBe(false);
          expect(yield* cli.alive(second.pid)).toBe(false);
          expect(yield* cli.refused(cli.port)).toBe(true);
          const after = yield* cli.run(["service", "status"]);
          expect(after.code, after.stderr).toBe(0);
          expect(after.stdout.trim()).toBe("stopped");
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceRegistration.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem,
            evidence = yield* Evidence;
          const cli = yield* backgroundServiceCli();
          const started = yield* cli.run(["service", "start"]);
          expect(started.code, started.stderr).toBe(0);
          const registration = yield* cli.registered;

          // A server no client can find any more stops on its own, and nothing serves its port.
          const removedAt = yield* Clock.currentTimeMillis;
          yield* fs.remove(cli.registrationFile);
          const exited = yield* eventually(
            cli.alive(registration.pid),
            (alive) => !alive,
            "10 seconds",
          ).pipe(Effect.option);
          const stoppedAt = yield* Clock.currentTimeMillis;
          const answering = yield* cli.info(cli.url).pipe(Effect.option);
          yield* evidence.json("watchdog.json", {
            stoppedAfterMs: stoppedAt - removedAt,
            exited: Option.isSome(exited),
            answering: Option.getOrUndefined(answering),
          });
          expect(
            Option.isSome(exited),
            "the unregistered server was still running after 10 s",
          ).toBe(true);
          expect(
            Option.getOrUndefined(answering),
            "another server answered on the port after the unregistered one stopped",
          ).toBeUndefined();
          expect(yield* cli.refused(cli.port)).toBe(true);
          const status = yield* cli.run(["service", "status"]);
          expect(status.stdout.trim()).toBe("stopped");
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServicePortSetting.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cli = yield* backgroundServiceCli();
          // The saved port applies only without EXECUTOR_PORT, which wins over it.
          const saved = { EXECUTOR_PORT: undefined };
          const next = yield* freePort.pipe(
            Effect.repeat({ until: (port) => port !== cli.port, times: 5 }),
          );
          expect(next).not.toBe(cli.port);

          const set = yield* cli.run(["service", "set", "port", String(cli.port)], saved);
          expect(set.code, set.stderr).toBe(0);
          const started = yield* cli.run(["service", "start"], saved);
          expect(started.code, started.stderr).toBe(0);
          expect(started.stdout.trim()).toBe(cli.url);
          const first = yield* cli.registered;

          // Changing the port stops the running server, so the next start uses the new one.
          const changed = yield* cli.run(["service", "set", "port", String(next)], saved);
          expect(changed.code, changed.stderr).toBe(0);
          expect(yield* fs.exists(cli.registrationFile)).toBe(false);
          expect(yield* cli.alive(first.pid)).toBe(false);
          expect(yield* cli.refused(cli.port)).toBe(true);
          const read = yield* cli.run(["service", "get", "port"], saved);
          expect(read.code, read.stderr).toBe(0);
          expect(read.stdout.trim()).toBe(String(next));

          const restarted = yield* cli.run(["service", "start"], saved);
          expect(restarted.code, restarted.stderr).toBe(0);
          const url = `http://127.0.0.1:${next}`;
          expect(restarted.stdout.trim()).toBe(url);
          const second = yield* cli.registered;
          expect(second.url).toBe(url);
          expect((yield* cli.info(url)).body).toEqual({
            id: second.id,
            version: second.version,
            pid: second.pid,
            status: "ready",
          });
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceDirectoryLock.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const cli = yield* backgroundServiceCli();
          const foreground = yield* cli.start(["serve"], (line) => line === `Executor: ${cli.url}`);
          const other = yield* freePort;

          // A second server for the same data directory on another port stops before storage, and
          // names the registered server that holds it.
          const second = yield* cli.run(["serve"], { EXECUTOR_PORT: String(other) });
          expect(second.code).toBe(1);
          expect(second.stderr).toContain(
            `The background Executor already serves the data directory ${cli.data} at ${cli.url}. Stop it with \`executor service stop\`, or set EXECUTOR_DATA_DIR to another folder.`,
          );

          // On the registered server's own port, it is that server that holds the directory.
          const same = yield* cli.run(["serve"]);
          expect(same.code).toBe(1);
          expect(same.stderr).toContain(
            `The background Executor already serves the data directory ${cli.data} at ${cli.url}. Stop it with \`executor service stop\``,
          );
          expect(same.stderr).not.toContain("in use by another program");

          // The first one keeps serving the directory, registered as the one the CLI shares.
          const registration = yield* cli.registered;
          expect(registration.pid).toBe(foreground.child.pid);
          expect((yield* cli.info(cli.url)).body).toEqual({
            id: registration.id,
            version: registration.version,
            pid: registration.pid,
            status: "ready",
          });
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceStopping.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const cli = yield* backgroundServiceCli();
          const started = yield* cli.run(["service", "start"]);
          expect(started.code, started.stderr).toBe(0);
          const server = yield* cli.registered;

          // The server is asked to stop and takes seconds to exit, answering meanwhile that it is
          // stopping; a stand-in answers in its place for those seconds.
          yield* crashServer(server.pid);
          yield* eventually(cli.refused(cli.port), (refused) => refused, "15 seconds");
          const scope = yield* Effect.scope;
          const restarted = yield* Effect.scoped(
            Effect.gen(function* () {
              const stopping = yield* stoppingServer(server);
              const status = yield* cli.run(["service", "status"]);
              expect(status.code, status.stderr).toBe(0);
              expect(status.stdout.trim()).toBe(
                `stopping ${cli.url} (version ${server.version}, process ${server.pid})`,
              );

              // A start waits for it to exit, asking it again and again, and neither joins it nor
              // asks it to stop.
              const seen = yield* stopping.answered;
              const start = yield* Effect.forkIn(cli.run(["service", "start"]), scope);
              yield* eventually(
                stopping.answered,
                (answered) => answered >= seen + 20,
                "30 seconds",
              );
              expect(start.pollUnsafe()).toBeUndefined();
              expect(
                (yield* stopping.requests).filter((request) => request !== "GET /api/service"),
              ).toEqual([]);
              return start;
            }),
          );

          // Once it has gone, the start starts a server in its place.
          const result = yield* Fiber.join(restarted);
          expect(result.code, result.stderr).toBe(0);
          expect(result.stdout.trim()).toBe(cli.url);
          const next = yield* cli.registered;
          expect(next.pid).not.toBe(server.pid);
          expect((yield* cli.info(cli.url)).body).toEqual({
            id: next.id,
            version: next.version,
            pid: next.pid,
            status: "ready",
          });
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceSuspendedLock.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const evidence = yield* Evidence;
          const cli = yield* backgroundServiceCli();
          const started = yield* cli.run(["service", "start"]);
          expect(started.code, started.stderr).toBe(0);
          const server = yield* cli.registered;
          const lock = yield* lockOf(cli.data);
          expect(yield* lock.holder).toEqual(Option.some({ pid: server.pid, port: cli.port }));

          // The server stops running without exiting, as after Ctrl+Z, `kill -STOP` or a paused
          // debugger, so it stops refreshing its lock too.
          const suspendedAt = yield* Effect.scoped(
            Effect.gen(function* () {
              const held = yield* suspendProcess(server.pid);
              const last = yield* lock.refreshed;
              // A minute later its lock is twice as stale as one without an owner may get.
              const waited = yield* eventually(
                Clock.currentTimeMillis,
                (now) => now - last > 61_000,
                "90 seconds",
              ).pipe(Effect.map((now) => now - last));
              expect(yield* lock.refreshed).toBe(last);

              // A private server and a foreground one on another port each listen, find the
              // directory held by a process that still runs and still has its port open, and stop
              // before storage, naming the registered server.
              const standalone = Option.getOrUndefined(
                yield* cli.run(["--standalone"]).pipe(Effect.timeoutOption("60 seconds")),
              );
              expect(standalone?.code, "`executor --standalone` still ran after 60 s").toBe(1);
              expect(standalone?.stderr).toContain(
                `This command's private Executor server could not start.\nThe background Executor already serves the data directory ${cli.data} at ${cli.url}.`,
              );
              const other = yield* freePort;
              const foreground = Option.getOrUndefined(
                yield* cli
                  .run(["serve"], { EXECUTOR_PORT: String(other) })
                  .pipe(Effect.timeoutOption("60 seconds")),
              );
              expect(foreground?.code, "`executor serve` still ran after 60 s").toBe(1);
              expect(foreground?.stderr).toContain(
                `The background Executor already serves the data directory ${cli.data} at ${cli.url}. Stop it with \`executor service stop\``,
              );
              expect(yield* lock.holder).toEqual(Option.some({ pid: server.pid, port: cli.port }));
              expect(yield* lock.refreshed).toBe(last);

              // `executor service status` says why no command could use it.
              const status = yield* cli.run(["service", "status"]);
              expect(status.code, status.stderr).toBe(0);
              expect(status.stdout.trim()).toBe(
                `not responding ${cli.url} (version ${server.version}, process ${server.pid})`,
              );
              yield* evidence.json("suspended.json", {
                lockAgeAtRefusalsMs: (yield* Clock.currentTimeMillis) - last,
                waitedMs: waited,
              });
              yield* held.resume;
              return last;
            }),
          );

          // Resumed, the same process serves and keeps its lock: it refreshes it again, which a
          // server whose lock was taken would not.
          yield* eventually(lock.refreshed, (time) => time > suspendedAt, "20 seconds");
          expect((yield* cli.info(cli.url)).body).toEqual({
            id: server.id,
            version: server.version,
            pid: server.pid,
            status: "ready",
          });
          const after = yield* cli.registered;
          expect([after.id, after.pid]).toEqual([server.id, server.pid]);
          expect(yield* lock.holder).toEqual(Option.some({ pid: server.pid, port: cli.port }));
          const resumed = yield* cli.run(["service", "status"]);
          expect(resumed.stdout.trim()).toBe(
            `${cli.url} (version ${server.version}, process ${server.pid})`,
          );
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceCrashedLock.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem,
            evidence = yield* Evidence;
          const cli = yield* backgroundServiceCli();
          const lock = yield* lockOf(cli.data);
          const started = yield* cli.run(["service", "start"]);
          expect(started.code, started.stderr).toBe(0);
          const first = yield* cli.registered;

          // The server is killed, as by SIGKILL or a crash, so its lock and registration stay.
          yield* crashServer(first.pid);
          yield* eventually(cli.alive(first.pid), (alive) => !alive, "15 seconds");
          expect(yield* lock.holder).toEqual(Option.some({ pid: first.pid, port: cli.port }));
          expect((yield* cli.registered).id).toBe(first.id);

          // The next start takes the lock over as soon as it tries, long before the 30 seconds
          // after which a lock without an owner counts as abandoned.
          const begun = yield* Clock.currentTimeMillis;
          const takenOver = yield* eventually(
            lock.owner,
            (owner) => Option.isSome(owner) && owner.value.pid !== first.pid,
            "60 seconds",
          ).pipe(
            Effect.andThen(Clock.currentTimeMillis),
            Effect.map((now) => now - begun),
            Effect.forkScoped({ startImmediately: true }),
          );
          const restarted = yield* cli.run(["service", "start"]);
          expect(restarted.code, restarted.stderr).toBe(0);
          const second = yield* cli.registered;
          expect(second.pid).not.toBe(first.pid);
          const tookMs = yield* Fiber.join(takenOver);
          expect(yield* lock.holder).toEqual(Option.some({ pid: second.pid, port: cli.port }));
          expect(tookMs).toBeLessThan(20_000);

          // A killed server's lock as the OS would leave it once it gave the server's process ID to
          // another running program: this test's own process, which started at another time. The
          // lock is made to look just refreshed, as a running owner's would, so it would stay held
          // for 30 seconds if anything but the owner's start time, or on Windows its pipe, decided.
          const reusedBy = (server: number) =>
            Effect.gen(function* () {
              yield* crashServer(server);
              yield* eventually(cli.alive(server), (alive) => !alive, "15 seconds");
              const recorded = yield* lock.owner;
              if (Option.isNone(recorded))
                return yield* Effect.die("The killed server left no owner");
              // The server recorded when it started and on which boot, which tell it apart, or on
              // Windows the pipe it listened on, which Windows removed when it was killed.
              expect(recorded.value).toMatchObject(
                process.platform === "win32"
                  ? { pid: server, pipe: expect.stringMatching(lockPipe) }
                  : { pid: server, started: expect.any(String), boot: expect.any(String) },
              );
              yield* fs.writeFileString(
                lock.ownerFile,
                JSON.stringify({ ...recorded.value, pid: process.pid }),
              );
              // A number is a time in seconds, as for Node's utimes.
              const now = (yield* Clock.currentTimeMillis) / 1_000;
              yield* fs.utimes(lock.file, now, now);
              expect(Math.abs(now * 1_000 - (yield* lock.refreshed))).toBeLessThan(2_000);
            });
          /** Start a foreground server on a free port: how long it took to take the lock. */
          const takeOver = Effect.gen(function* () {
            const port = yield* freePort;
            const begun = yield* Clock.currentTimeMillis;
            const taken = yield* eventually(
              lock.owner,
              (owner) => Option.isSome(owner) && owner.value.pid !== process.pid,
              "60 seconds",
            ).pipe(
              Effect.andThen(Clock.currentTimeMillis),
              Effect.map((now) => now - begun),
              Effect.forkScoped({ startImmediately: true }),
            );
            const server = yield* cli.start(
              ["serve"],
              (line) => line === `Executor: http://127.0.0.1:${port}`,
              { EXECUTOR_PORT: String(port) },
            );
            const ms = yield* Fiber.join(taken);
            expect(yield* lock.holder).toEqual(Option.some({ pid: server.child.pid, port }));
            return { server, port, ms };
          });

          // Killed again, its process ID now names this test's process, and its port is closed. A
          // server on another port takes the lock over at once.
          yield* reusedBy(second.pid);
          const third = yield* takeOver;
          expect(third.ms).toBeLessThan(20_000);

          // Killed once more, and both its process ID and its port are now another program's: the
          // port accepts connections and answers, as no Executor does. The lock is still
          // abandoned, and the next server takes it over at once.
          yield* reusedBy(third.server.child.pid);
          yield* eventually(cli.refused(third.port), (refused) => refused, "15 seconds");
          yield* serving(
            HttpRouter.add("*", "/*", Effect.succeed(HttpServerResponse.empty({ status: 404 }))),
            third.port,
          );
          const fourth = yield* takeOver;
          expect(fourth.ms).toBeLessThan(20_000);
          yield* evidence.json("takeovers.json", {
            tookMs,
            reusedPidMs: third.ms,
            reusedPidAndPortMs: fourth.ms,
          });
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceReusedPid.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem,
            processes = yield* ChildProcessSpawner.ChildProcessSpawner,
            evidence = yield* Evidence;
          const cli = yield* backgroundServiceCli();
          const started = yield* cli.run(["service", "start"]);
          expect(started.code, started.stderr).toBe(0);
          const server = yield* cli.registered;
          const registration = yield* fs
            .readFileString(cli.registrationFile)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(RecordJson)));
          // On Linux and macOS the registration records when the server started and on which
          // boot. On Windows it names only the pid, and the data directory's lock names the same
          // pid with the pipe the server listens on.
          if (process.platform === "win32") {
            expect(registration).toMatchObject({ pid: server.pid, group: true });
            expect(registration).not.toHaveProperty("started");
            expect(Option.getOrUndefined(yield* (yield* lockOf(cli.data)).owner)).toMatchObject({
              pid: server.pid,
              pipe: expect.stringMatching(lockPipe),
            });
          } else {
            expect(registration).toMatchObject({
              pid: server.pid,
              group: true,
              started: expect.any(String),
              boot: expect.any(String),
            });
          }

          // The server is killed, and the OS gives its process ID to another program that leads
          // its own process group, as a background server does. Another program takes its port,
          // accepting connections and never answering, as a hung server would.
          yield* crashServer(server.pid);
          yield* eventually(cli.alive(server.pid), (alive) => !alive, "15 seconds");
          yield* eventually(cli.refused(cli.port), (refused) => refused, "15 seconds");
          const unrelated = yield* processes.spawn(
            ChildProcess.make(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
              stdout: "ignore",
              stderr: "ignore",
            }),
          );
          yield* serving(HttpRouter.add("*", "/*", Effect.never), cli.port);
          const reuse = fs.writeFileString(
            cli.registrationFile,
            JSON.stringify({ ...registration, pid: unrelated.pid }),
          );

          // `executor service stop` gets no answer, finds that the process with that ID started
          // after the server did, or on Windows that the lock names another process, and removes
          // the registration without signalling it.
          yield* reuse;
          const stopped = yield* cli.run(["service", "stop"]);
          expect(stopped.code, stopped.stderr).toBe(0);
          expect(yield* fs.exists(cli.registrationFile)).toBe(false);
          const status = yield* cli.run(["service", "status"]);
          expect(status.stdout.trim()).toBe("stopped");
          expect(yield* cli.alive(unrelated.pid)).toBe(true);

          // A start counts the registration as hung after three unanswered requests and removes
          // it the same way. Its server then finds the port taken by another program.
          yield* reuse;
          const restarted = yield* cli.run(["service", "start"]);
          expect(restarted.code).toBe(1);
          expect(restarted.stderr).toContain(
            `Port ${cli.port} is already in use by another program.`,
          );
          expect(yield* fs.exists(cli.registrationFile)).toBe(false);
          yield* Effect.sleep("1 second");
          expect(yield* cli.alive(unrelated.pid)).toBe(true);
          expect(yield* unrelated.isRunning).toBe(true);
          yield* evidence.json("reused-pid.json", {
            server: server.pid,
            unrelated: unrelated.pid,
            stopCode: stopped.code,
            startCode: restarted.code,
          });
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceKeyStorageInvalid.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cli = yield* backgroundServiceCli();
          const refusal =
            'EXECUTOR_KEY_STORAGE must be "file" (keep keys in keys.json) or "os" (OS credential store only), or unset. Nothing was changed.';

          // Each way to start a server refuses the value before it creates the data directory.
          for (const args of [["service", "start"], [], ["--standalone"], ["serve"]]) {
            const refused = yield* cli.run(args, { EXECUTOR_KEY_STORAGE: "keyring" });
            expect(refused.code, refused.stdout).toBe(1);
            expect(refused.stderr).toContain(refusal);
            expect(refused.stdout).not.toContain("#pair=");
            expect(yield* fs.exists(cli.data)).toBe(false);
          }
          expect(yield* cli.refused(cli.port)).toBe(true);

          // Saved as a setting, which servers a client starts run with, the setting wins over the
          // environment's valid value, and nothing but the setting is written.
          const saved = yield* cli.run([
            "service",
            "set",
            "env",
            "EXECUTOR_KEY_STORAGE",
            "keyring",
          ]);
          expect(saved.code, saved.stderr).toBe(0);
          for (const args of [["service", "start"], []]) {
            const refused = yield* cli.run(args);
            expect(refused.code, refused.stdout).toBe(1);
            expect(refused.stderr).toContain(
              `The background Executor could not start.\n${refusal}`,
            );
            expect(yield* fs.readDirectory(cli.data)).toEqual(["service.json"]);
          }
          expect(yield* fs.exists(cli.registrationFile)).toBe(false);

          // Once the setting is removed, the same command starts the server.
          const unset = yield* cli.run(["service", "unset", "env", "EXECUTOR_KEY_STORAGE"]);
          expect(unset.code, unset.stderr).toBe(0);
          const started = yield* cli.run(["service", "start"]);
          expect(started.code, started.stderr).toBe(0);
          expect(started.stdout.trim()).toBe(cli.url);
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceAppsCli.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cli = yield* backgroundServiceCli();
          // No --host or EXECUTOR_HOST: the command starts the background server and uses its
          // registered password, with no API key supplied.
          const listed = yield* cli.run(["apps", "list"]);
          expect(listed.code, listed.stderr).toBe(0);
          expect(listed.stderr).toContain(starting);
          const apps = yield* Schema.decodeUnknownEffect(Apps)(listed.stdout);
          expect(apps.map((app) => app.slug)).toContain("executor");
          const registration = yield* cli.registered;
          expect(registration.url).toBe(cli.url);
          expect((yield* cli.info(cli.url)).body.pid).toBe(registration.pid);

          // The next command reuses it.
          const again = yield* cli.run(["apps", "list"]);
          expect(again.code, again.stderr).toBe(0);
          expect(again.stderr).not.toContain(starting);
          expect(yield* Schema.decodeUnknownEffect(Apps)(again.stdout)).toEqual(apps);
          const after = yield* cli.registered;
          expect([after.id, after.pid]).toEqual([registration.id, registration.pid]);

          // With the service disabled, the command runs a private server for its duration.
          const disabled = yield* cli.run(["service", "set", "disabled", "true"]);
          expect(disabled.code, disabled.stderr).toBe(0);
          expect(yield* cli.alive(registration.pid)).toBe(false);
          const own = yield* cli.run(["apps", "list"]);
          expect(own.code, own.stderr).toBe(0);
          expect(own.stderr).not.toContain(starting);
          expect(yield* Schema.decodeUnknownEffect(Apps)(own.stdout)).toEqual(apps);
          expect(yield* fs.exists(cli.registrationFile)).toBe(false);
          expect(yield* cli.refused(cli.port)).toBe(true);
        }),
      ),
    { timeout: 300_000 },
  );

  it.effect(
    scenarios.localServiceEarlierServer.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cli = yield* backgroundServiceCli();
          // server.json as an Executor from before the background service wrote it. The process it
          // names runs: this test's own. That Executor took no lock, so only the record shows it.
          const recordOf = (url: string) =>
            JSON.stringify({
              pid: process.pid,
              version: "2.0.0-beta.15",
              url,
              command: "executor serve",
            });
          yield* fs.makeDirectory(cli.data, { recursive: true });

          // That Executor still answers at its URL, as its session route does for any loopback
          // request.
          const earlier = yield* Effect.scoped(
            Effect.gen(function* () {
              const url = yield* serving(
                HttpRouter.add(
                  "GET",
                  "/auth/session",
                  HttpServerResponse.jsonUnsafe({ authenticated: false }),
                ),
              );
              const record = recordOf(url);
              yield* fs.writeFileString(cli.registrationFile, record);
              for (const args of [["service", "start"], ["serve"]]) {
                const refused = yield* cli.run(args);
                expect(refused.code).toBe(1);
                expect(refused.stderr).toContain(
                  `An Executor from before the background service (process ${process.pid}) is using the data directory ${cli.data} at ${url}.`,
                );
                expect(refused.stderr).not.toContain(starting);
              }
              // Nothing listened or replaced the record.
              expect(yield* cli.refused(cli.port)).toBe(true);
              expect(yield* fs.readFileString(cli.registrationFile)).toBe(record);
              return url;
            }),
          );

          // Once nothing answers there, the record was left by a killed Executor whose process ID
          // another program now has. It is ignored, and a server starts in its place.
          const started = yield* cli.run(["service", "start"]);
          expect(started.code, started.stderr).toBe(0);
          expect(started.stdout.trim()).toBe(cli.url);
          expect(started.stderr).toContain(
            `Ignoring ${cli.registrationFile}: it names process ${process.pid}, but no Executor answers at ${earlier}.`,
          );
          expect((yield* cli.registered).url).toBe(cli.url);
        }),
      ),
    { timeout: 300_000 },
  );
  it.effect(
    scenarios.localServiceImpostor.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const http = yield* HttpClient.HttpClient,
            evidence = yield* Evidence;
          const cli = yield* backgroundServiceCli();
          const started = yield* cli.run(["service", "start"]);
          expect(started.code, started.stderr).toBe(0);
          const registration = yield* cli.registered;
          const password = Redacted.value(registration.password);
          // What the server proved to one client that challenged it, as anyone on the machine can
          // ask for and record: a proof only for that challenge.
          const replayedChallenge = "e2e-recorded-challenge-0123456789";
          const recorded = yield* http
            .get(`${cli.url}/api/service?challenge=${replayedChallenge}`)
            .pipe(Effect.flatMap((response) => response.json));
          expect(recorded).toMatchObject({
            id: registration.id,
            pid: registration.pid,
            status: "ready",
            proof: expect.stringMatching(/^[\w-]{43}$/u),
          });

          // The server dies without removing its registration, as after SIGKILL or a power loss.
          yield* crashServer(registration.pid);
          expect(yield* eventually(cli.refused(cli.port), (refused) => refused, "15 seconds")).toBe(
            true,
          );
          expect((yield* cli.registered).id).toBe(registration.id);

          // Another process takes the registered port and replays that answer, proof included.
          yield* Effect.scoped(
            Effect.gen(function* () {
              const requests = yield* Ref.make<
                ReadonlyArray<{
                  readonly url: string;
                  readonly headers: Readonly<Record<string, string>>;
                  readonly body: string;
                }>
              >([]);
              yield* serving(
                HttpRouter.add(
                  "*",
                  "/*",
                  Effect.gen(function* () {
                    const request = yield* HttpServerRequest.HttpServerRequest;
                    const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
                    yield* Ref.update(requests, (seen) => [
                      ...seen,
                      { url: request.url, headers: { ...request.headers }, body },
                    ]);
                    return request.url.startsWith("/api/service")
                      ? HttpServerResponse.jsonUnsafe(recorded)
                      : HttpServerResponse.empty({ status: 404 });
                  }),
                ),
                cli.port,
              );

              // Its proof is for another challenge, so it is not the server.
              const status = yield* cli.run(["service", "status"]);
              expect(status.code, status.stderr).toBe(0);
              expect(status.stdout.trim()).toBe("stopped");

              // `executor` neither pairs with it nor sends it the password. It cannot take the
              // port either, so it says another Executor holds it.
              const joined = yield* cli.run([]);
              expect(joined.code).toBe(1);
              expect(joined.stderr).toContain(
                `Port ${cli.port} is already in use by another Executor server, for another data directory.`,
              );
              expect(joined.stdout).not.toContain("#pair=");
              expect(yield* cli.opened).toEqual([]);
              const seen = yield* Ref.get(requests);
              yield* evidence.json("impostor-requests.json", {
                requests: seen.length,
                first: seen.slice(0, 3).map(({ url }) => url),
              });
              // Each client challenged it afresh, and asked it nothing else.
              const challenges = seen.map(
                ({ url }) => new URL(url, "http://127.0.0.1").searchParams.get("challenge") ?? "",
              );
              expect(challenges.length).toBeGreaterThan(0);
              expect(seen.filter(({ url }) => !url.startsWith("/api/service?"))).toEqual([]);
              expect(challenges.filter((challenge) => challenge === replayedChallenge)).toEqual([]);
              // The password is nowhere in what it received: not in a URL, a header or a body.
              expect(
                seen.filter(
                  ({ url, headers, body }) =>
                    decodeURIComponent(url).includes(password) ||
                    Object.values(headers).some((value) => value.includes(password)) ||
                    body.includes(password),
                ),
              ).toEqual([]);
            }),
          );
        }),
      ),
    { timeout: 300_000 },
  );
});
