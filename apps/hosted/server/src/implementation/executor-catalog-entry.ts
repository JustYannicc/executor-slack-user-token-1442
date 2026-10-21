/** The catalog entry is cheap metadata; the app source loads on demand. */
import { CatalogEntry } from "@executor-js/catalog/contracts";
import type { AppCopyOrigin } from "@executor-js/sdk/core";
import { executorCatalogPackage } from "../contracts/catalog.ts";

/** This installation's public API, available as a built-in app. */
export const executorCatalogEntry = (origin: string) =>
  CatalogEntry.make({
    id: `${origin}/openapi.json`,
    package: executorCatalogPackage,
    name: "Executor",
    description: "Manage apps and connected accounts in Executor.",
    auth: [
      { method: "oauth", kind: "oauth2" },
      { method: "apiKey", kind: "secrets", label: "Executor API key" },
    ],
    icons: [{ src: "/favicon.png", mimeType: "image/png" }],
  });

/**
 * Every Executor app this installation creates, from the catalog or as an organization's default,
 * records this origin, so Add app recognizes it as installed.
 */
export const executorCopyOrigin = (origin: string): AppCopyOrigin => ({
  reference: executorCatalogEntry(origin).id,
  name: executorCatalogEntry(origin).package,
  commit: null,
});
