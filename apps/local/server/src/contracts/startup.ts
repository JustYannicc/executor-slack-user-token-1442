/** Startup failures are safe to display; transport payloads and keys stay out of diagnostics. */
import { Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { hostedExecutorOrigin } from "@executor-js/sdk/core";
import { serverFlag, standaloneFlag } from "./service.ts";

/** System codes permitted in persistent startup diagnostics. */
export const StartupCode = Schema.Literals([
  "EADDRINUSE",
  "EACCES",
  "EPERM",
  "ENOENT",
  "ENOSPC",
  "ENOTDIR",
  "EISDIR",
  "EEXIST",
  "EMFILE",
  "ECONNREFUSED",
  "ETIMEDOUT",
]);

/** One explicit startup stage failed without exposing its raw input. */
export class StartupFailed extends Schema.TaggedError<StartupFailed>()("StartupFailed", {
  stage: Schema.Literals([
    "authentication",
    "storage",
    "runtime",
    "sdk",
    "data-steps",
    "composition",
    "listen",
    "browser",
    "dev-server",
  ]),
  code: Schema.optional(StartupCode),
}) {
  get message() {
    return `Local startup failed at ${this.stage}${this.code === undefined ? "" : ` (${this.code})`}`;
  }
}
/**
 * CLI declarations parse before handlers acquire configuration or server resources. The default
 * command uses the background server unless `--standalone` or `--server` chooses another.
 */
export const executorCommand = Command.make("executor", {
  standalone: standaloneFlag,
  server: serverFlag,
}).pipe(Command.withDescription("Start or join the background Executor and open its dashboard"));

/**
 * Run a server in this process without opening a browser. `--service` is the background server a
 * client starts; `--stdio` is a client's private server, which prints `{"url"}` and stops when its
 * stdin closes.
 */
export const serveCommand = Command.make("serve", {
  service: Flag.Boolean("service").pipe(
    Flag.withDescription("Run as the background server for this data directory"),
    Flag.withDefault(false),
    Flag.withHidden,
  ),
  stdio: Flag.Boolean("stdio").pipe(
    Flag.withDescription("Run as a private server until standard input closes"),
    Flag.withDefault(false),
    Flag.withHidden,
  ),
}).pipe(Command.withDescription("Start without opening a browser"));

/** Pair with the running server without opening local storage. */
export const pairCommand = Command.make("pair").pipe(
  Command.withDescription("Print a new connection link for the running server"),
);

/** The desktop app pairs its own server; the CLI may not know its data directory or port. */
export const desktopPairing =
  "If Executor desktop is running, use its File > Open in browser menu item instead.";

/**
 * Pairing found no running server, a registered one still starting, stopping or not responding
 * after 30 seconds, a server that refused the credential, or something that is not a working
 * Executor server, including one whose link the CLI may not open. Pairing only reads keys, so
 * every message says what to correct and that nothing was changed. `keys` says which credential
 * was sent: the API key saved in `directory`, EXECUTOR_API_KEY, or the password the background
 * server registered. `server` is the host the request went to; none when no server was found.
 */
export class PairFailed extends Schema.TaggedError<PairFailed>()("PairFailed", {
  reason: Schema.Literals([
    "no-server",
    "starting",
    "stopping",
    "unresponsive",
    "key-rejected",
    "storage-unavailable",
    "unexpected-response",
  ]),
  server: Schema.optional(Schema.String),
  directory: Schema.String,
  keys: Schema.Literals(["saved", "supplied", "registered"]),
}) {
  get message() {
    const server = this.server ?? "the registered address";
    switch (this.reason) {
      case "no-server":
        return `No background Executor is running for ${this.directory}. Start it with \`executor\` or \`executor service start\`. ${desktopPairing} Nothing was changed.`;
      case "starting":
        return `The background Executor on ${server} is still starting. Try again shortly, or run \`executor service status\` to check it. Nothing was changed.`;
      case "stopping":
        return `The background Executor on ${server} is still stopping. Run \`executor service restart\` to stop it and start it again. Nothing was changed.`;
      case "unresponsive":
        return `The background Executor on ${server} is not responding. Run \`executor service restart\` to stop it and start it again. Nothing was changed.`;
      case "key-rejected":
        return {
          supplied: `The Executor server on ${server} did not accept the supplied EXECUTOR_API_KEY. Supply the key that server started with. Nothing was changed.`,
          saved: `The Executor server on ${server} did not accept the API key saved in ${this.directory}. It may use another data directory: set EXECUTOR_DATA_DIR to the folder it uses. ${desktopPairing} If you ran \`executor rotate-key\`, restart the server to use the new key. Nothing was changed.`,
          registered: `The background Executor on ${server} did not accept the password it registered in ${this.directory}. Run \`executor service restart\`, then try again. Nothing was changed.`,
        }[this.keys];
      case "storage-unavailable":
        return `The Executor server on ${server} could not save a connection link because its access storage is unavailable. Try again, and restart the server if this continues. Nothing was changed.`;
      case "unexpected-response":
        return `Something is listening on ${server}, but it did not answer as an Executor server. Run \`executor service status\` to see where the background Executor listens. Nothing was changed.`;
    }
  }
}

/** Replace the saved local API key. A running server uses the new key after it restarts. */
export const rotateKeyCommand = Command.make("rotate-key").pipe(
  Command.withDescription(
    "Replace the saved local API key. Run `executor service restart` to use it, then update clients that used the old key",
  ),
);

/**
 * Install a newer release the way this copy was installed: a standalone install downloads and
 * switches to it, and an npm-family install runs its package manager.
 */
export const upgradeCommand = Command.make("upgrade", {
  version: Argument.String("version").pipe(
    Argument.withDescription("Release to install, such as 2.0.0-beta.16. Default: the newest"),
    Argument.optional,
  ),
  method: Flag.Literals("method", ["npm", "pnpm", "bun", "yarn"]).pipe(
    Flag.withDescription("Package manager to install with, instead of the detected one"),
    Flag.optional,
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withAlias("y"),
    Flag.withDescription("Do not ask for confirmation; required to downgrade without a terminal"),
    Flag.withDefault(false),
  ),
  rollback: Flag.Boolean("rollback").pipe(
    Flag.withDescription(
      "Switch a standalone install back to the version it ran before its last upgrade",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Install the newest Executor release on this installation's channel, or the given version. A standalone install keeps the previous version for --rollback",
  ),
);

/**
 * `executor upgrade` stopped. Every message says what to do next, and whether anything changed:
 * only `install-failed` and `verify-failed` follow a package manager run, and a standalone
 * install switches versions only after the new one has passed its checks. `service-running`: the
 * background server did not stop, so the package manager did not run over its files. A failure
 * after the background server stopped starts it again first.
 */
export class UpgradeFailed extends Schema.TaggedError<UpgradeFailed>()("UpgradeFailed", {
  reason: Schema.Literals([
    "development-build",
    "invalid-version",
    "registry-unavailable",
    "unknown-release",
    "node-too-old",
    "unknown-install",
    "downgrade-unconfirmed",
    "cancelled",
    "install-failed",
    "verify-failed",
    "download-failed",
    "checksum-mismatch",
    "no-previous-version",
    "not-standalone",
    "service-running",
  ]),
  message: Schema.String,
}) {}

/** Executor 1 commands that Executor 2 does not have. */
export const LegacyCommandName = Schema.Literals([
  "web",
  "open",
  "daemon",
  "install",
  "mcp",
  "call",
  "tools",
  "resume",
  "server",
  "login",
  "docs",
]);
export type LegacyCommandName = typeof LegacyCommandName.Type;
/**
 * Executor 1's `executor service` subcommands that Executor 2's `executor service` does not have.
 * Both have `status` and `restart`.
 */
export const LegacyServiceCommandName = Schema.Literals(["install", "uninstall"]);
/** The words after `executor` that run an Executor 1 command. */
const LegacyInvocation = Schema.Union([
  LegacyCommandName,
  Schema.TemplateLiteral(["service ", LegacyServiceCommandName]),
]);
type LegacyInvocation = typeof LegacyInvocation.Type;

const installsNothing =
  "Executor 2 installs nothing with your operating system. `executor` or `executor service start` starts the background Executor, which runs until `executor service stop`.";
const mcpOverHttp =
  "Start the server with `executor` or `executor service start`, then point your client at its /mcp endpoint, http://127.0.0.1:4312/mcp by default.";
const toolsOverMcp = `Executor 2 runs tools through MCP. ${mcpOverHttp}`;
const serverTarget = ["base-url", "server", "scope"];

/**
 * What to run instead of each Executor 1 command, and the flags Executor 1 accepted on it and its
 * subcommands: `switches` take no value, `values` take one. Declaring them lets an invocation such
 * as `executor web --foreground` reach the replacement instead of an unknown-flag error.
 */
const legacy: Readonly<
  Record<
    LegacyInvocation,
    {
      readonly replacement: string;
      readonly switches: ReadonlyArray<string>;
      readonly values: ReadonlyArray<string>;
    }
  >
> = {
  web: {
    replacement:
      "In Executor 2, run `executor` to start the local server and open its dashboard. If the server is already running, run `executor pair` and open the link it prints.",
    switches: ["foreground"],
    values: ["port", "hostname", "allowed-host", "auth-token", "scope"],
  },
  open: {
    replacement:
      "In Executor 2, run `executor pair` while the server is running, then open the connection link it prints.",
    switches: [],
    values: [],
  },
  daemon: {
    replacement:
      "In Executor 2, run `executor service start` to start the background server without opening a browser. It keeps running until `executor service stop`.",
    switches: ["foreground"],
    values: ["port", "hostname", "allowed-host", "auth-token", "base-url", "scope"],
  },
  install: { replacement: installsNothing, switches: ["boot"], values: ["port"] },
  "service install": { replacement: installsNothing, switches: ["boot"], values: ["port"] },
  "service uninstall": {
    replacement:
      "Executor 2 installs nothing with your operating system, so there is nothing to remove. `executor service stop` stops the background Executor.",
    switches: [],
    values: [],
  },
  mcp: {
    replacement: `Executor 2 serves MCP over HTTP from the running server. ${mcpOverHttp}`,
    switches: ["no-artifacts", "search-tools"],
    values: ["scope", "elicitation-mode", "mode"],
  },
  call: { replacement: toolsOverMcp, switches: [], values: serverTarget },
  tools: {
    replacement: toolsOverMcp,
    switches: [],
    values: ["namespace", "limit", "query", ...serverTarget],
  },
  resume: {
    replacement: toolsOverMcp,
    switches: [],
    values: ["execution-id", "action", "content", ...serverTarget],
  },
  server: {
    replacement:
      "Executor 2 has no server profiles. App commands take `--host`, agents connect to a server's /mcp endpoint, and `executor rotate-key` replaces `executor server rotate-token`.",
    switches: ["default"],
    values: ["display-name", "kind", "header-env"],
  },
  login: {
    replacement: `In Executor 2, run \`executor apps login --host ${hostedExecutorOrigin}\` to sign in to hosted Executor for app commands.`,
    switches: ["no-browser"],
    values: ["name", ...serverTarget],
  },
  docs: {
    replacement: "The documentation is at https://executor.sh/docs.",
    switches: [],
    values: [],
  },
};

/** An Executor 1 command was run; the message names the Executor 2 replacement. */
export class LegacyCommand extends Schema.TaggedError<LegacyCommand>()("LegacyCommand", {
  command: LegacyInvocation,
}) {
  get message() {
    return `\`executor ${this.command}\` is an Executor 1 command. ${legacy[this.command].replacement}`;
  }
}

/**
 * Executor 1's commands, accepted by exact name with any words and Executor 1 flags after them,
 * such as `daemon run --port 4788`. Unlisted, with hidden flags, so help and typo suggestions
 * show only Executor 2 commands and a legacy command's help shows only its replacement.
 */
const legacyCommand = <const Name extends string>(name: Name, invocation: LegacyInvocation) =>
  Command.make(name, {
    words: Argument.String("words").pipe(Argument.variadic()),
    flags: [
      ...legacy[invocation].switches.map((flag) =>
        Flag.Boolean(flag).pipe(Flag.optional, Flag.withHidden),
      ),
      ...legacy[invocation].values.map((flag) =>
        Flag.String(flag).pipe(Flag.atLeast(0), Flag.withHidden),
      ),
    ],
  }).pipe(Command.withDescription(legacy[invocation].replacement), Command.unlisted);

export const legacyCommands = LegacyCommandName.literals.map((name) => legacyCommand(name, name));
/** Under `executor service`, such as `service install --port 4788`. */
export const legacyServiceCommands = LegacyServiceCommandName.literals.map((name) =>
  legacyCommand(name, `service ${name}`),
);
