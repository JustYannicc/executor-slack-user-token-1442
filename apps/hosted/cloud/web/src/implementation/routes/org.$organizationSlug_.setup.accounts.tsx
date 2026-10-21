import { createFileRoute } from "@tanstack/react-router";
import { parseAccountsSetupSearch } from "@executor-js/hosted-web/contracts/navigation";
import { inventoryAtom } from "@executor-js/hosted-web/contracts/organization";
import { AccountsSetupPage } from "@executor-js/hosted-web/pages/accounts-setup";

/** Connect accounts for the new team's apps; its URL carries the assistant if it came first. */
export const Route = createFileRoute("/org/$organizationSlug_/setup/accounts")({
  codeSplitGroupings: [],
  validateSearch: parseAccountsSetupSearch,
  staticData: { organizationReads: (organization) => [inventoryAtom(organization)] },
  component: AccountsSetupPage,
});
