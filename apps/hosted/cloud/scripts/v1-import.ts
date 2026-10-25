/**
 * Operator command for the v1 move (`notes/v1-import.md`). It calls a deployment's
 * `/api/internal/v1-import/*` routes with `V1_IMPORT_OPERATOR_TOKEN`, which only operators hold.
 *
 *   start      Start a run over every live v1 organization after --after (default: from the
 *              first), or over the organizations given with --org, keeping at most
 *              --max-in-flight organizations running across every run (default 2): each request
 *              starts only as many as have room, and the command waits --pause seconds while
 *              the deployment is full. It prints the cursor after each batch; to resume a walk
 *              that stopped, pass the last one printed as --after. The bound holds v1's
 *              database, WorkOS and the compiler to a few organizations at a time, beside the v1
 *              sign-in check that reads the same database. Before raising it, watch the
 *              `build.memory_retry` span attribute on `runtime.cloud.compiler.request` spans: it
 *              marks builds that ran out of the shared compiler's memory and were retried alone.
 *              Raise the bound only while it stays rare. Dry runs write only their reports.
 *              `--mode import` freezes each organization in v1, moves it and cuts it over. It
 *              needs the deployment's CLOUD_V1_IMPORT_WRITES=on and the organizations named with
 *              --org; the deployment imports only those with a row in its
 *              private_v1_import_allowed table and refuses the rest with the reason. This
 *              command never writes that table: rows are added by direct SQL.
 *   aggregate  Combine a run's reports, a page per request, into
 *              v1-import/runs/<run>/aggregate.json and print it. Repeat it until `complete` is
 *              true.
 *   report     Print one organization's report and its instances' states, and a summary of an
 *              import's verification and cutover on stderr.
 *   rollback   Give the organization named with --org back to v1: v1 serves it again and its
 *              import map is cleared. Delete its v2 organization first; the deployment refuses
 *              while it exists or while its import instance runs. --run is not used.
 *
 * Reports hold customer data: keep the output private, out of PRs, issues and logs.
 */
import { parseArgs } from "node:util";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { Config, Console, Effect, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import {
  V1ImportAggregatePage,
  V1ImportStarted,
  V1OrgReport,
} from "../src/contracts/v1-import-run.ts";

const usage =
  "Usage: node apps/hosted/cloud/scripts/v1-import.ts <start|aggregate|report|rollback> --origin <https://...> [--run <id>] [--mode dry-run|import] [--org <v1 org id>]... [--after <cursor>] [--max-in-flight <1-100>] [--pause <seconds>]";

const Refused = Schema.Struct({ error: Schema.String });

/** The report route's answer: the report once written, and both instances' states. */
const OrgReport = Schema.Struct({
  report: Schema.NullOr(V1OrgReport),
  instances: Schema.Struct({ dryRun: Schema.String, import: Schema.String }),
});

const program = Effect.gen(function* () {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      origin: { type: "string" },
      run: { type: "string" },
      mode: { type: "string", default: "dry-run" },
      org: { type: "string", multiple: true },
      after: { type: "string", default: "" },
      "max-in-flight": { type: "string", default: "2" },
      pause: { type: "string", default: "15" },
    },
  });
  const [command] = positionals;
  if (values.origin === undefined || (values.run === undefined && command !== "rollback"))
    return yield* Effect.die(usage);
  if (values.mode !== "dry-run" && values.mode !== "import") return yield* Effect.die(usage);
  const token = yield* Config.Redacted("V1_IMPORT_OPERATOR_TOKEN");
  const http = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl(values.origin ?? ""),
        HttpClientRequest.bearerToken(Redacted.value(token)),
      ),
    ),
    // A refused request names why (`{ error }`), such as an organization without a row in the allow table.
    HttpClient.transformResponse(
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? Effect.succeed(response)
          : response.json.pipe(
              Effect.map(Schema.decodeUnknownOption(Refused)),
              Effect.orElseSucceed(() => Option.none<typeof Refused.Type>()),
              Effect.flatMap((refused) =>
                Effect.die(
                  `${response.request.method} ${response.request.url} answered ${response.status}${Option.isSome(refused) ? `: ${refused.value.error}` : ""}`,
                ),
              ),
            ),
      ),
    ),
  );
  const run = values.run ?? "";
  const mode = values.mode;
  switch (command) {
    case "start": {
      const maxInFlight = Number(values["max-in-flight"]);
      const pause = Number(values.pause);
      if (!Number.isInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 100 || !(pause >= 0))
        return yield* Effect.die(usage);
      // An import moves the organizations it names, never a page of v1.
      if (mode === "import" && values.org === undefined)
        return yield* Effect.die("--mode import needs the organizations to move, each with --org.");
      const send = (body: object) =>
        HttpClientRequest.post("/api/internal/v1-import/start").pipe(
          HttpClientRequest.bodyJsonUnsafe({ mode, runId: run, maxInFlight, ...body }),
          http.execute,
          Effect.flatMap((response) => response.json),
          Effect.flatMap(Schema.decodeUnknownEffect(V1ImportStarted)),
        );
      const reported = new Set<string>();
      const progress = (started: typeof V1ImportStarted.Type, total: number) =>
        Effect.gen(function* () {
          yield* Console.log(`Started ${total} organizations; ${started.inFlight} running.`);
          for (const passed of started.skipped)
            yield* Console.log(`Skipped ${passed.organization}: ${passed.reason}.`);
          for (const stopped of started.errored)
            if (!reported.has(stopped.organization)) {
              reported.add(stopped.organization);
              yield* Console.log(
                `Instance ${stopped.instance} ${stopped.status} without a report; restart or inspect it.`,
              );
            }
        });
      let total = 0;
      if (values.org !== undefined) {
        let remaining: readonly string[] = values.org;
        while (remaining.length > 0) {
          const started = yield* send({ organizations: remaining });
          total += started.started.length;
          yield* progress(started, total);
          remaining = started.deferred;
          if (remaining.length > 0) yield* Effect.sleep(`${pause} seconds`);
        }
        return;
      }
      let after = values.after;
      while (true) {
        const started = yield* send({ after, limit: maxInFlight });
        total += started.started.length;
        yield* progress(started, total);
        if (started.next === null) break;
        if (started.next !== after) yield* Console.log(`Cursor: ${started.next}`);
        // The run is full: wait for organizations to finish before starting more.
        if (started.started.length === 0) yield* Effect.sleep(`${pause} seconds`);
        after = started.next;
      }
      return;
    }
    case "aggregate": {
      const path = `/api/internal/v1-import/runs/${encodeURIComponent(run)}/aggregate`;
      let cursor: string | undefined;
      while (true) {
        const page = yield* HttpClientRequest.post(path).pipe(
          HttpClientRequest.setUrlParams(cursor === undefined ? {} : { cursor }),
          http.execute,
          Effect.flatMap((response) => response.json),
          Effect.flatMap(Schema.decodeUnknownEffect(V1ImportAggregatePage)),
        );
        if (page.cursor === null) {
          yield* Console.log(JSON.stringify(page.aggregate, null, 2));
          return;
        }
        yield* Console.error(`Combined ${page.organizations} organizations so far.`);
        cursor = page.cursor;
      }
    }
    case "report": {
      const [organization] = values.org ?? [];
      if (organization === undefined) return yield* Effect.die(usage);
      const found = yield* HttpClientRequest.get(
        `/api/internal/v1-import/runs/${encodeURIComponent(run)}/orgs/${encodeURIComponent(organization)}`,
      ).pipe(
        http.execute,
        Effect.flatMap((response) => response.json),
        Effect.flatMap(Schema.decodeUnknownEffect(OrgReport)),
      );
      yield* Console.log(JSON.stringify(found, null, 2));
      const report = found.report;
      if (report === null) {
        yield* Console.error(
          `No report yet; dry-run instance ${found.instances.dryRun}, import instance ${found.instances.import}.`,
        );
        return;
      }
      yield* Console.error(
        `${report.mode} ${report.status}${report.reason === null ? "" : `: ${report.reason}`}`,
      );
      if (report.verification !== undefined) {
        const { items, members, accounts, apps, passed } = report.verification;
        yield* Console.error(
          `Verification ${passed ? "passed" : "failed"}: ${items.withResult}/${items.planned} items with a result, ${items.failed} failed; ${members.inV2}/${members.planned} members; ${accounts.checked - accounts.unreadable}/${accounts.checked} accounts decrypt; ${apps.checked - apps.withoutVersion}/${apps.checked} apps active.`,
        );
      }
      if (report.mode === "import")
        yield* Console.error(
          report.cutover === true
            ? `Cut over to v2 organization ${report.v2Organization?.slug ?? "?"}.`
            : "Not cut over: the organization stays frozen in v1, or was given back.",
        );
      return;
    }
    case "rollback": {
      const [organization] = values.org ?? [];
      if (organization === undefined) return yield* Effect.die(usage);
      const result = yield* HttpClientRequest.post(
        `/api/internal/v1-import/orgs/${encodeURIComponent(organization)}/rollback`,
      ).pipe(
        http.execute,
        Effect.flatMap((response) => response.json),
      );
      yield* Console.log(JSON.stringify(result, null, 2));
      return;
    }
    default:
      return yield* Effect.die(usage);
  }
}).pipe(Effect.provide(FetchHttpClient.layer));

NodeRuntime.runMain(program);
