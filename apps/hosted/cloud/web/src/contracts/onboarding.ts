import { organizationsAtom } from "@executor-js/hosted-web/contracts/organization";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import { hydrated } from "@executor-js/ui/contracts/http";
import { acknowledge } from "@executor-js/ui/contracts/mutations";
import { Effect, Option, Schema } from "effect";
import { Atom, AsyncResult } from "effect/reactivity";
import {
  OnboardingReady,
  OnboardingEntry,
  type CreateTeam,
  type SetupSequence,
} from "../../../src/contracts/onboarding.ts";
import { CloudClient } from "./billing.ts";

/** Initial setup metadata comes from the private sign-in document, not a second browser request. */
export const entryTeamAtom = Atom.family((userId: string) =>
  Atom.make<Option.Option<typeof OnboardingEntry.Type>>(Option.none()).pipe(
    Atom.serializable({
      key: `cloud:entry-team:${userId}`,
      schema: Schema.Option(OnboardingEntry),
    }),
    Atom.keepAlive,
  ),
);

/** Explicit refresh discards document data and reads current membership, invitations and suggestions. */
export const prepareTeamAtom = Atom.family((userId: string) => {
  const query = CloudClient.runtime.atom((get) =>
    Effect.gen(function* () {
      const client = yield* CloudClient;
      const entry = yield* client.onboarding.prepare({});
      if (Schema.is(OnboardingReady)(entry))
        acknowledge(get, organizationsAtom, () => entry.organizations);
      return entry;
    }),
  );
  return Atom.readable(
    (get) => {
      const entry = get(entryTeamAtom(userId));
      return Option.isSome(entry) ? AsyncResult.success(entry.value) : get(query);
    },
    (refresh) => {
      refresh(entryTeamAtom(userId));
      refresh(query);
    },
  ).pipe(Atom.withLabel("ui.onboarding.prepare"));
});

/** Only confirmation creates a team; publish its identity before the router changes pages. */
export const createTeamAtom = Atom.family((userId: string) =>
  CloudClient.runtime
    .fn((details: CreateTeam, get) =>
      Effect.gen(function* () {
        const client = yield* CloudClient;
        const result = yield* client.onboarding.create({ payload: details });
        if (Schema.is(OnboardingReady)(result))
          acknowledge(get, organizationsAtom, () => result.organizations);
        // The new team's setup opens on the order the confirmation carried, without reading it.
        const [team] = result.status === "ready" ? result.organizations : [];
        if (result.status === "ready" && result.setup !== undefined && team !== undefined)
          for (const reference of [team.id, team.slug])
            get.set(createdSetupAtom(reference), Option.some(result.setup));
        get.set(entryTeamAtom(userId), Option.some(result));
        return result;
      }),
    )
    .pipe(Atom.withLabel("ui.onboarding.create")),
);

/** The setup order a team's confirmation returned, by the team's ID and by its slug. */
const createdSetupAtom = Atom.family((_organization: string) =>
  Atom.make<Option.Option<SetupSequence>>(Option.none()).pipe(Atom.keepAlive),
);

/**
 * The team's setup order. A team just created in this browser has the order its confirmation
 * returned; otherwise it is read with the setup document so its first step renders in the right
 * order. Its first read for an enrolled team records the experiment exposure on the server.
 */
export const setupSequenceAtom = Atom.family((organization: OrganizationReference) => {
  const query = CloudClient.query("setup", "sequence", hydrated({ params: { organization } }));
  return Atom.readable(
    (get) => {
      const created = get(createdSetupAtom(organization));
      return Option.isSome(created) ? AsyncResult.success(created.value) : get(query);
    },
    (refresh) => refresh(query),
  ).pipe(Atom.withLabel("ui.onboarding.setup"));
});
