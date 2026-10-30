import { matchesSingleLabelSite, rebaseSiteUrl } from "@executor-js/utils/account-site";
import { parseDestination, type UrlPolicy } from "@executor-js/utils/url-policy";
import type { FirstPartyOAuthClient } from "../contracts/oauth.ts";
import type { ProviderAuthMethod } from "../contracts/provider.ts";
import type { ProviderSite } from "apps/contracts";

const siteEndpoints = [
  "authorizationUrl",
  "tokenUrl",
  "revocationUrl",
  "issuer",
  "discover",
  "authorizationServerMetadataUrl",
] as const;

/** Rebase only OAuth URLs whose origin matches the app's declared site template. */
export const oauthMethodAtSite = <Method extends ProviderAuthMethod>(
  method: Method,
  rule: ProviderSite | undefined,
  site: string | undefined,
): Method => {
  if (method.type !== "oauth2" || rule === undefined || site === undefined) return method;
  const rebased = { ...method };
  for (const [key, value] of Object.entries(method)) {
    if (!siteEndpoints.some((endpoint) => endpoint === key) || typeof value !== "string") continue;
    const next = rebaseSiteUrl(value, rule.origin, site);
    if (next !== undefined) Object.assign(rebased, { [key]: next });
  }
  return rebased;
};

/** Rebind a configured first-party OAuth client only to its declared tenant-site rule. */
export const firstPartyClientAtSite = (
  configured: FirstPartyOAuthClient,
  site: string | undefined,
  policy: UrlPolicy,
): FirstPartyOAuthClient | undefined => {
  if (configured.issuerSite === undefined) return configured;
  if (site === undefined) return undefined;
  const template = parseDestination(configured.server.authorizationUrl, policy);
  const selected = URL.parse(site);
  const selectedOrigin = selected === null ? undefined : parseDestination(selected.origin, policy);
  if (
    template === undefined ||
    selected === null ||
    selectedOrigin === undefined ||
    selected.origin !== site ||
    template.protocol !== selectedOrigin.protocol ||
    template.port !== selectedOrigin.port ||
    !matchesSingleLabelSite(template.origin, configured.issuerSite.subdomainOf) ||
    !matchesSingleLabelSite(selectedOrigin.origin, configured.issuerSite.subdomainOf)
  )
    return undefined;

  const server = { ...configured.server };
  for (const key of ["authorizationUrl", "tokenUrl", "revocationUrl", "issuer"] as const) {
    const endpoint = configured.server[key];
    if (endpoint === undefined) continue;
    const rebased = rebaseSiteUrl(endpoint, template.origin, selectedOrigin.origin);
    if (rebased !== undefined) Object.assign(server, { [key]: rebased });
  }

  const templateHost = template.host.toLowerCase();
  const selectedHost = selectedOrigin.host.toLowerCase();
  return {
    ...configured,
    server,
    placement: {
      ...configured.placement,
      hosts: configured.placement.hosts.flatMap((host) => {
        const lower = host.toLowerCase();
        if (lower === templateHost) return [selectedHost];
        return lower.startsWith("*.") ? [] : [host];
      }),
    },
  };
};
