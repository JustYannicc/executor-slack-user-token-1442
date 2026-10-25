/** Scoped loopback listeners for isolated ports and real bind-conflict fixtures. */
import { connect, createServer, type Socket } from "node:net";
import { Effect } from "effect";
import { driver } from "./platform.ts";

/**
 * Hold a loopback port until the owning scope closes; zero asks the OS to choose. `onConnection`
 * handles each connection; the scope closes once every connection has ended.
 */
export const holdPort = (port: number, onConnection?: (socket: Socket) => void) =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => createServer(onConnection)),
      (server) =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    return yield* driver(
      "allocate isolated port",
      () =>
        new Promise<number>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") reject(new Error("No test port"));
            else resolve(address.port);
          });
        }),
    );
  });

/** Ask the OS for an available port and release it before returning. */
export const freePort = Effect.scoped(holdPort(0));

/**
 * A loopback port that refuses connections until the owning scope closes. A port released by
 * `freePort` can be handed to another worker's server before the scenario connects to it, and
 * then something answers. Here an open loopback connection keeps the port as its local end, so
 * the OS gives it to no other socket, while nothing listens on it.
 */
export const refusingPort = Effect.gen(function* () {
  const peer = yield* holdPort(0);
  const socket = yield* Effect.acquireRelease(
    driver(
      "reserve refusing port",
      () =>
        new Promise<Socket>((resolve, reject) => {
          const socket = connect({ host: "127.0.0.1", port: peer });
          socket.once("error", reject);
          socket.once("connect", () => resolve(socket));
        }),
    ),
    (socket) => Effect.sync(() => socket.destroy()),
  );
  const port = socket.localPort;
  if (port === undefined) return yield* Effect.die("The reserved socket has no local port");
  return port;
});

/** Whether a loopback connection to `port` is refused, the only sign that nothing listens there. */
export const connectionRefused = (port: number) =>
  Effect.callback<boolean>((resume) => {
    const socket = connect({ host: "127.0.0.1", port });
    const settle = (refused: boolean) => {
      socket.destroy();
      resume(Effect.succeed(refused));
    };
    socket.once("connect", () => settle(false));
    socket.once("error", (error) => settle("code" in error && error.code === "ECONNREFUSED"));
    return Effect.sync(() => socket.destroy());
  });
