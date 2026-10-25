/**
 * Local test hook: a session object refuses the writes to its record of issued requests
 * (`mcp-interaction-store.ts`) that one request makes, as a storage call can throw, so a scenario
 * can prove what a later resume says when a request's end was never recorded. Only an
 * `alchemy dev` build bundles this module, in place of `mcp-interaction-faults.ts`
 * (`localTestModules` in `worker-build.ts`); `scripts/worker-sizes.ts` fails if a deployed build
 * contains it.
 *
 * A request that carries `x-executor-test-fault: interaction-writes` has every record write it
 * makes throw while it runs; reads and other requests' writes are untouched.
 */
import { Effect } from "effect";
import type { InteractionFaults, Kv } from "./mcp-interaction-faults.ts";

const header = "x-executor-test-fault";
const refusal = "Interaction record write refused by a test fault";

/** Text only this hook contains, which the deployed builds' check looks for. */
export const interactionFaultMarkers = [header, refusal];

/** The object's storage, refusing writes while a request that asks for it runs. */
export const interactionFaults = (kv: Kv): InteractionFaults => {
  let refusing = 0;
  return {
    kv: {
      get: (key) => kv.get(key),
      list: (options) => kv.list(options),
      put: (key, value) => {
        if (refusing > 0) throw new Error(refusal);
        kv.put(key, value);
      },
      delete: (key) => kv.delete(key),
    },
    during: (request, work) =>
      request.headers[header] === "interaction-writes"
        ? Effect.suspend(() => {
            refusing += 1;
            return work;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                refusing -= 1;
              }),
            ),
          )
        : work,
  };
};
