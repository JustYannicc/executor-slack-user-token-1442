import type { ReactNode } from "react";
import { useAtomMount } from "@effect/atom-react";
import { inventoryAtom } from "../../contracts/organization.ts";
import { OrganizationContent, useOrganizationRoute } from "../components/organization.tsx";
import { SetupPage } from "../components/setup-page.tsx";
import { NameAccountDialog } from "./name-account-dialog.tsx";

/**
 * Onboarding steps that belong to one organization, outside the dashboard shell. The product's
 * route places this inside its organization boundary. Newly connected accounts are named over the
 * step, as they are over dashboard pages. The accounts step lists the inventory and the first
 * prompt names its accounts, so the read stays open from one to the other.
 */
export function OrganizationSetup({ children }: { readonly children: ReactNode }) {
  useAtomMount(inventoryAtom(useOrganizationRoute().organization));
  return (
    <OrganizationContent pending={<SetupPage />}>
      {children}
      <NameAccountDialog />
    </OrganizationContent>
  );
}
