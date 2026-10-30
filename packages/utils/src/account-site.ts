import { Option, Schema } from "effect";
import {
  HttpOrigin,
  isPrivateHostname,
  parseDestination,
  type UrlPolicy,
} from "./url-policy.ts";

const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

const suffixHost = (value: string): string | undefined => {
  const parsed = URL.parse(`https://${value}`);
  return parsed !== null && parsed.hostname === value.toLowerCase() && parsed.port === ""
    ? parsed.hostname
    : undefined;
};

/** An app's rule for selecting and rebasing one account's exact service origin. */
export const ProviderSite = Schema.Struct({
  label: Schema.NonEmptyString,
  origin: HttpOrigin,
  /** Use this origin for new accounts and legacy accounts without a saved site. */
  defaultOrigin: Schema.optionalKey(Schema.Boolean),
  /** Permit one tenant label below this DNS suffix, using the template's scheme and port. */
  subdomainOf: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
}).check(
  Schema.makeFilter(
    (site) =>
      site.subdomainOf === undefined || matchesSingleLabelSite(site.origin, site.subdomainOf),
    { message: "The site template must be one label below subdomainOf." },
  ),
);
export type ProviderSite = typeof ProviderSite.Type;

/** A canonical origin suitable for saved account and connection metadata. */
export const SiteOrigin = HttpOrigin;
export type SiteOrigin = typeof SiteOrigin.Type;

/** Match exactly one DNS label below a suffix, comparing URL-normalized hostnames. */
export const matchesSingleLabelSite = (origin: string, suffix: string): boolean => {
  const parsed = URL.parse(origin);
  const domain = suffixHost(suffix);
  if (parsed === null || domain === undefined) return false;
  const suffixWithDot = `.${domain}`;
  if (!parsed.hostname.endsWith(suffixWithDot)) return false;
  const label = parsed.hostname.slice(0, -suffixWithDot.length);
  return dnsLabel.test(label);
};

/** Whether a saved site fits the declaration of the app currently selecting the account. */
export const siteFitsRule = (
  rule: ProviderSite | undefined,
  origin: string | null | undefined,
): boolean => {
  if (rule === undefined) return origin == null;
  if (origin == null) return rule.defaultOrigin === true;
  const selected = URL.parse(origin);
  const template = URL.parse(rule.origin);
  if (selected === null || template === null || selected.origin !== origin) return false;
  if (rule.subdomainOf === undefined) return origin === rule.origin;
  return (
    selected.protocol === template.protocol &&
    selected.port === template.port &&
    matchesSingleLabelSite(origin, rule.subdomainOf)
  );
};

/** Resolve the form's site value under the host's ordinary destination policy. */
export const resolveSiteOrigin = (
  definition: ProviderSite,
  input: string,
  policy: UrlPolicy,
): SiteOrigin | undefined => {
  const template = URL.parse(definition.origin);
  if (template === null || parseDestination(template.origin, policy) === undefined)
    return undefined;

  let candidate: URL | null;
  if (definition.subdomainOf !== undefined && dnsLabel.test(input.toLowerCase())) {
    const suffix = suffixHost(definition.subdomainOf);
    if (suffix === undefined) return undefined;
    candidate = URL.parse(
      `${template.protocol}//${input.toLowerCase()}.${suffix}${template.port ? `:${template.port}` : ""}`,
    );
  } else {
    candidate = URL.parse(input);
  }
  if (
    candidate === null ||
    candidate.username !== "" ||
    candidate.password !== "" ||
    candidate.pathname !== "/" ||
    candidate.search !== "" ||
    candidate.hash !== "" ||
    !["http:", "https:"].includes(candidate.protocol) ||
    (definition.subdomainOf !== undefined &&
      (!matchesSingleLabelSite(candidate.origin, definition.subdomainOf) ||
        candidate.protocol !== template.protocol ||
        candidate.port !== template.port))
  )
    return undefined;

  // Site inputs need an exact operator opt-in, including loopback development origins.
  if (
    isPrivateHostname(candidate.hostname) &&
    !policy.allowedHttpOrigins.some((origin) => origin === candidate.origin)
  )
    return undefined;
  const destination = parseDestination(candidate.origin, policy);
  if (destination === undefined) return undefined;
  return Option.getOrUndefined(Schema.decodeUnknownOption(SiteOrigin)(destination.origin));
};

/** Rebase only a URL whose origin exactly matches the provider's declared template. */
export const rebaseSiteUrl = (
  value: string | undefined,
  templateOrigin: string,
  siteOrigin: string | undefined,
): string | undefined => {
  if (value === undefined || siteOrigin === undefined) return value;
  const endpoint = URL.parse(value);
  const template = URL.parse(templateOrigin);
  const site = URL.parse(siteOrigin);
  if (
    endpoint === null ||
    template === null ||
    site === null ||
    endpoint.origin !== template.origin
  )
    return value;
  endpoint.protocol = site.protocol;
  endpoint.host = site.host;
  return endpoint.href;
};

/** Site-bound secrets can reach only the selected origin's host and port. */
export const siteCredentialHosts = (
  hosts: readonly string[] | undefined,
  rule: ProviderSite | undefined,
  siteOrigin: string | undefined,
): readonly string[] | undefined => {
  if (rule === undefined || siteOrigin === undefined) return hosts;
  if (!siteFitsRule(rule, siteOrigin)) return [];
  const template = URL.parse(rule.origin);
  const site = URL.parse(siteOrigin);
  if (template === null || site === null) return [];
  const selectedHost = site.host.toLowerCase();
  const bound = (hosts ?? [])
    .filter((host) => !host.startsWith("*."))
    .map((host) =>
      host.toLowerCase() === template.host.toLowerCase() ? selectedHost : host.toLowerCase(),
    );
  bound.push(selectedHost);
  return [...new Set(bound)].sort();
};
