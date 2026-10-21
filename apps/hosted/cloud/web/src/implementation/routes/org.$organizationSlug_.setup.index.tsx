import { createFileRoute } from "@tanstack/react-router";
import { SetupStart } from "../components/team-setup.tsx";

/** Team creation opens here; the team's setup sequence names its first step. */
export const Route = createFileRoute("/org/$organizationSlug_/setup/")({
  codeSplitGroupings: [],
  component: SetupStart,
});
