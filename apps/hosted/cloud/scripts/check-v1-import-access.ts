/**
 * The v1 import reads v1's real data on production (`CLOUD_V1_IMPORT=on`) and, for an operator's
 * dry run, from local Cloud dev (`CLOUD_V1_IMPORT_SOURCE=live`). Neither may write v2 until v1's
 * freeze exists. This check evaluates `v1ImportAccess` for every combination of stage, origin,
 * emulators and the three switches, with the stage given as Alchemy's `Stage` service and as
 * `ALCHEMY_STAGE`. It fails when:
 *
 * - a real v1 source (production or live) is not marked `realV1`, which refuses imports that write;
 * - the live source runs anywhere but a loopback origin outside production and test stages, or
 *   with writes allowed;
 * - production's source runs on any other stage;
 * - the emulated Cloud the E2E runner uses stops allowing imports that write;
 * - an import runs without naming its organizations, or for one without a row in the allow table
 *   (`private_v1_import_allowed`), given the rows read from it.
 */
import { Stage } from "alchemy/Stage";
import { ConfigProvider, Effect, Exit } from "effect";
import type { V1MovedFlag } from "../src/implementation/v1-import/moved-flag.ts";
import { V1ImportWrites, refusalGiven } from "../src/implementation/v1-import/writes.ts";
import { productionStage } from "../src/infrastructure/stage.ts";
import { v1ImportAccess } from "../src/infrastructure/v1-import-settings.ts";

const stages = [productionStage, "dev", "dev-checkout", "staging", "test-e2e-check", "test-pr-1"];
const loopbackOrigins = ["http://localhost:4411", "http://127.0.0.1:4411", "http://[::1]:4411"];
const origins = [...loopbackOrigins, "https://executor.sh", "https://cloud.example.com"];
const switches = [undefined, "off", "on"] as const;
const sources = [undefined, "emulated", "live"] as const;

interface Case {
  readonly stage: string;
  readonly stageSource: "Stage service" | "ALCHEMY_STAGE";
  readonly origin: string;
  readonly emulated: boolean;
  readonly enabled: (typeof switches)[number];
  readonly writes: (typeof switches)[number];
  readonly source: (typeof sources)[number];
}

const describe = (c: Case) =>
  `stage ${c.stage} (${c.stageSource}), BETTER_AUTH_URL=${c.origin}, ` +
  `emulators ${c.emulated ? "on" : "off"}, CLOUD_V1_IMPORT=${c.enabled ?? "<unset>"}, ` +
  `CLOUD_V1_IMPORT_WRITES=${c.writes ?? "<unset>"}, CLOUD_V1_IMPORT_SOURCE=${c.source ?? "<unset>"}`;

const evaluate = (c: Case) => {
  const env: Record<string, string> = {
    BETTER_AUTH_URL: c.origin,
    ...(c.stageSource === "ALCHEMY_STAGE" ? { ALCHEMY_STAGE: c.stage } : {}),
    ...(c.enabled === undefined ? {} : { CLOUD_V1_IMPORT: c.enabled }),
    ...(c.writes === undefined ? {} : { CLOUD_V1_IMPORT_WRITES: c.writes }),
    ...(c.source === undefined ? {} : { CLOUD_V1_IMPORT_SOURCE: c.source }),
  };
  const access = v1ImportAccess(c.emulated).pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
  );
  return Effect.runSyncExit(
    c.stageSource === "Stage service" ? access.pipe(Effect.provideService(Stage, c.stage)) : access,
  );
};

const cases = stages.flatMap((stage) =>
  (["Stage service", "ALCHEMY_STAGE"] as const).flatMap((stageSource) =>
    origins.flatMap((origin) =>
      [false, true].flatMap((emulated) =>
        switches.flatMap((enabled) =>
          switches.flatMap((writes) =>
            sources.map((source): Case => ({
              stage,
              stageSource,
              origin,
              emulated,
              enabled,
              writes,
              source,
            })),
          ),
        ),
      ),
    ),
  ),
);

const failures: string[] = [];
let live = 0;
for (const c of cases) {
  const exit = evaluate(c);
  if (Exit.isFailure(exit)) continue;
  const access = exit.value;
  const fail = (rule: string) => failures.push(`${describe(c)}: ${rule}`);
  if ((access.source === "production" || access.source === "live") && !access.realV1)
    fail("a real v1 source does not refuse imports that write");
  if (access.source === "production" && c.stage !== productionStage)
    fail("production's v1 source runs on another stage");
  if (access.source === "live") {
    live++;
    if (c.stage === productionStage || c.stage.startsWith("test-"))
      fail("the live source runs on a deployed stage");
    if (!loopbackOrigins.includes(c.origin)) fail("the live source runs on a public origin");
    if (access.writes) fail("the live source allows imports that write");
  }
  if (c.source === "live" && access.source !== "live") fail("the live source was ignored");
}

// The live source must still be reachable where it is meant to run.
if (live === 0) failures.push("No combination allows the live source on local Cloud dev.");
// The E2E runner's managed Cloud: emulated, loopback, no switches, imports that write allowed.
const e2e = evaluate({
  stage: "dev",
  stageSource: "ALCHEMY_STAGE",
  origin: "http://127.0.0.1:4411",
  emulated: true,
  enabled: undefined,
  writes: undefined,
  source: undefined,
});
if (!Exit.isSuccess(e2e) || e2e.value.source !== "emulated" || !e2e.value.writes)
  failures.push("Emulated Cloud no longer allows imports that write.");

// Which organizations an import may write, given the allow table's rows. The flag is never
// written here.
const flag: V1MovedFlag = { set: () => Effect.void };
const [listedOrg, otherOrg] = ["org_listed1", "org_other1"];
const listed = V1ImportWrites.Listed({ flag });
const rows = new Set([listedOrg]);
const writeRules: ReadonlyArray<readonly [string, string | undefined, boolean]> = [
  ["an import that pages through v1", refusalGiven(listed, undefined, rows), false],
  ["an import that names no organization", refusalGiven(listed, [], rows), false],
  ["an import of an organization with a row", refusalGiven(listed, [listedOrg], rows), true],
  ["an import of an organization without a row", refusalGiven(listed, [otherOrg], rows), false],
  [
    "an import that adds an organization without a row",
    refusalGiven(listed, [listedOrg, otherOrg], rows),
    false,
  ],
  ["an import with an empty allow table", refusalGiven(listed, [listedOrg], new Set()), false],
  [
    "a deployment that refuses imports",
    refusalGiven(V1ImportWrites.Refused({ reason: "off" }), [listedOrg], rows),
    false,
  ],
];
for (const [rule, refusal, allowed] of writeRules)
  if ((refusal === undefined) !== allowed)
    failures.push(`${rule} is ${refusal === undefined ? "allowed" : "refused"}`);

if (failures.length > 0) {
  console.error(`v1 import access rules failed in ${failures.length} combinations:`);
  for (const failure of failures.slice(0, 20)) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(
  `v1 import access: ${cases.length} combinations checked, ${live} run the live source; ${writeRules.length} write rules checked.`,
);
