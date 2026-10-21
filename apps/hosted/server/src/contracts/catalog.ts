/** Shared catalog capability; installation remains an authorized app operation. */
import type { Catalog } from "@executor-js/catalog/contracts";
import { Context } from "effect";

/** Catalog lookup supplied by the host; tests can supply an offline source. */
export class HostedCatalog extends Context.Service<HostedCatalog, Catalog>()(
  "executor/hosted/Catalog",
) {}

/**
 * The package of this installation's own API as a catalog app. Every organization gets a copy by
 * default, and assistants reach it through Executor's MCP server.
 */
export const executorCatalogPackage = "executor";
