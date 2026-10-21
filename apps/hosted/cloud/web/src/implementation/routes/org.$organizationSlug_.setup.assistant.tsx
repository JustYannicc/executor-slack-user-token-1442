import { createFileRoute } from "@tanstack/react-router";
import { parseAgentSetupSearch } from "@executor-js/hosted-web/contracts/navigation";
import { inventoryAtom } from "@executor-js/hosted-web/contracts/organization";
import { AgentSetupPage } from "@executor-js/hosted-web/pages/agent-setup";

/** The assistant handoff, available on reload; its first prompt names the connected accounts. */
export const Route = createFileRoute("/org/$organizationSlug_/setup/assistant")({
  codeSplitGroupings: [],
  validateSearch: parseAgentSetupSearch,
  staticData: { organizationReads: (organization) => [inventoryAtom(organization)] },
  component: AgentSetupPage,
});
