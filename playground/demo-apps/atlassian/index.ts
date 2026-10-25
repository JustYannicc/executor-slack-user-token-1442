import {
  array,
  bearer,
  boolean,
  decodeJson,
  defineApp,
  defineProvider,
  json,
  number,
  object,
  oauth2,
  query,
  router,
  string,
  type QueryContext,
} from "apps";
import { never } from "apps/operations/approval";

const apiOrigin = "https://api.atlassian.com";
const accessibleResourcesUrl = `${apiOrigin}/oauth/token/accessible-resources`;
const scopes = [
  "offline_access",
  "read:jira-work",
  "read:confluence-content.all",
  "search:confluence",
];

const atlassian = defineProvider({
  name: "Atlassian",
  hosts: ["api.atlassian.com"],
  auth: {
    oauth: oauth2({
      authorizationUrl: "https://auth.atlassian.com/authorize",
      tokenUrl: "https://auth.atlassian.com/oauth/token",
      tokenEndpointAuthMethod: "client_secret_post",
      tokenRequestFormat: "json",
      authorizationParams: { audience: "api.atlassian.com", prompt: "consent" },
      scopes,
      request: ({ access_token }) => bearer(access_token),
    }),
  },
  async health({ account, fetch, signal }) {
    const response = await fetch(accessibleResourcesUrl, {
      signal,
      headers: { ...account.headers(), accept: "application/json" },
    });
    const sites = await decodeJson(response, array(object({ id: string(), name: string() })));
    if (sites.length === 0) throw new Error("No Atlassian sites are accessible to this account.");
  },
});

const requirements = { user: { accounts: { atlassian } } };
type Context = QueryContext<typeof requirements>;

const apiFetch = (
  context: Context,
  url: string,
  options: { readonly method?: "GET" | "POST"; readonly body?: unknown } = {},
) => {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return context.fetch(url, {
    ...(options.method === undefined ? {} : { method: options.method }),
    ...(body === undefined ? {} : { body }),
    signal: context.signal,
    headers: {
      ...context.user.accounts.atlassian.headers(),
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
  });
};

const boundedNumber = (value: number | undefined, fallback: number, maximum: number) =>
  Math.max(1, Math.min(maximum, Math.trunc(value ?? fallback)));

const Sites = array(
  object({
    id: string(),
    name: string(),
    url: string(),
    scopes: array(string()).optional(),
  }),
);

const listSites = query(
  {
    description: "List Atlassian Cloud sites accessible to the connected account.",
    approval: never(),
    input: object({}),
  },
  async (context: Context) => {
    const response = await apiFetch(context, accessibleResourcesUrl);
    return decodeJson(response, Sites);
  },
);

const ConfluenceSearch = object({
  results: array(
    object({
      id: string(),
      title: string(),
      type: string().optional(),
      status: string().optional(),
      excerpt: string().optional(),
      space: object({ key: string().optional(), name: string().optional() }).optional(),
      _links: object({ webui: string().optional() }).optional(),
    }),
  ),
  size: number().optional(),
});

const searchConfluence = query(
  {
    description: "Search Confluence pages with a CQL query on one accessible site.",
    approval: never(),
    input: object({
      cloudId: string({ minLength: 1 }),
      cql: string({ minLength: 1 }),
      limit: number().optional(),
    }),
  },
  async (context: Context, { cloudId, cql, limit }) => {
    const params = new URLSearchParams({
      cql,
      limit: String(boundedNumber(limit, 25, 100)),
      expand: "space",
    });
    const base = `${apiOrigin}/ex/confluence/${encodeURIComponent(cloudId)}/wiki/rest/api`;
    const response = await apiFetch(context, `${base}/content/search?${params}`);
    return decodeJson(response, ConfluenceSearch);
  },
);

const ConfluencePage = object({
  id: string(),
  title: string(),
  type: string().optional(),
  status: string().optional(),
  space: object({ key: string().optional(), name: string().optional() }).optional(),
  body: object({
    storage: object({ value: string(), representation: string().optional() }).optional(),
  }).optional(),
  _links: object({ webui: string().optional() }).optional(),
});

const readConfluencePage = query(
  {
    description: "Read a Confluence page and its storage-format body.",
    approval: never(),
    input: object({ cloudId: string({ minLength: 1 }), pageId: string({ minLength: 1 }) }),
  },
  async (context: Context, { cloudId, pageId }) => {
    const base = `${apiOrigin}/ex/confluence/${encodeURIComponent(cloudId)}/wiki/rest/api`;
    const params = new URLSearchParams({ expand: "body.storage,space,version" });
    const response = await apiFetch(
      context,
      `${base}/content/${encodeURIComponent(pageId)}?${params}`,
    );
    return decodeJson(response, ConfluencePage);
  },
);

const JiraIssue = object({
  id: string(),
  key: string(),
  self: string().optional(),
  fields: object({
    summary: string(),
    description: json().optional(),
    status: object({ name: string() }).optional(),
    issuetype: object({ name: string() }).optional(),
    project: object({ key: string(), name: string().optional() }).optional(),
    updated: string().optional(),
  }),
});

const getJiraIssue = query(
  {
    description: "Read a Jira issue by key from one accessible site.",
    approval: never(),
    input: object({ cloudId: string({ minLength: 1 }), issueKey: string({ minLength: 1 }) }),
  },
  async (context: Context, { cloudId, issueKey }) => {
    const base = `${apiOrigin}/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3`;
    const params = new URLSearchParams({
      fields: "summary,description,status,issuetype,project,updated",
    });
    const response = await apiFetch(
      context,
      `${base}/issue/${encodeURIComponent(issueKey)}?${params}`,
    );
    return decodeJson(response, JiraIssue);
  },
);

const JiraSearch = object({
  issues: array(JiraIssue),
  total: number().optional(),
  isLast: boolean().optional(),
  nextPageToken: string().optional(),
});

const searchJiraIssues = query(
  {
    description: "Search Jira issues with JQL on one accessible site.",
    approval: never(),
    input: object({
      cloudId: string({ minLength: 1 }),
      jql: string({ minLength: 1 }),
      maxResults: number().optional(),
    }),
  },
  async (context: Context, { cloudId, jql, maxResults }) => {
    const base = `${apiOrigin}/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3`;
    const response = await apiFetch(context, `${base}/search/jql`, {
      method: "POST",
      body: {
        jql,
        maxResults: boundedNumber(maxResults, 25, 100),
        fields: ["summary", "status", "issuetype", "project", "updated"],
      },
    });
    return decodeJson(response, JiraSearch);
  },
);

export default defineApp(requirements, {
  tools: router({
    listSites,
    searchConfluence,
    readConfluencePage,
    getJiraIssue,
    searchJiraIssues,
  }),
});
