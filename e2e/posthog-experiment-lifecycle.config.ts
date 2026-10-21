import { defineConfig } from "vitest/config";

/** Deploys the Cloud PostHog experiment resource with alchemy against a local stand-in for PostHog. */
export default defineConfig({
  test: { include: ["e2e/tests/posthog-experiment-lifecycle.spec.ts"], testTimeout: 180_000 },
});
