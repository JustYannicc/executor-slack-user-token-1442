/** Host-owned polling and cleanup for OAuth personal-data reporting registrations. */
import { Clock, Effect, Option, Redacted, Result, Schema } from "effect";
import { Hex } from "effect/encoding";
import { HttpClient } from "effect/http";
import type { UrlPolicy } from "@executor-js/utils/url-policy";
import { FirstPartyOAuthClient, allowedScopes } from "../contracts/oauth.ts";
import type { PersonalDataReportingHost } from "../contracts/executor.ts";
import {
  OwnerId,
  StorageError,
  type AccountId,
  type OwnerId as OwnerIdType,
} from "../contracts/shared.ts";
import { Provider, type ProviderDefinition } from "../contracts/provider.ts";
import { StoredAccount, StoredConnectionState, type Credentials } from "../contracts/storage.ts";
import type { makeOAuth } from "./oauth.ts";
import { query, transaction, type Query } from "./database.ts";
import {
  fetchIdentity,
  reportAccounts,
  type AccountAction,
} from "./personal-data-reporting-http.ts";

const batchSize = 90;
const batchesPerRun = 20;
const leaseMillis = 5 * 60_000;
const closedMessage =
  "The service closed this account. Stored credentials and identity were removed.";
const ExternalId = Schema.Struct({ externalId: Schema.String });

type AccountContext = {
  readonly account: StoredAccount;
  readonly provider: Provider;
  readonly method: Extract<ProviderDefinition["auth"][string], { readonly type: "oauth2" }>;
};
type ReportRow = {
  readonly id: AccountId;
  readonly owner: OwnerIdType;
  readonly clientFingerprint: string;
  readonly credentialGeneration: number;
  readonly status: "active" | "refresh_pending" | "closed";
  readonly encryptedExternalId: Uint8Array | null;
  readonly externalIdFingerprint: string | null;
  readonly retrievedAt: Date | null;
  readonly reportedAt: Date | null;
  readonly cycleDays: number;
  readonly nextReportAt: Date | null;
  readonly retryAt: Date | null;
  readonly retries: number;
  readonly lease: string | null;
  readonly leaseUntil: Date | null;
};
type OAuth = Pick<ReturnType<typeof makeOAuth>, "resolve" | "revokeRemoved">;
type ReportingClient = typeof FirstPartyOAuthClient.Type & {
  readonly personalDataReporting: NonNullable<
    (typeof FirstPartyOAuthClient.Type)["personalDataReporting"]
  >;
};

const canonicalUrl = (value: string | undefined) => {
  if (value === undefined) return undefined;
  try {
    return new URL(value).href;
  } catch {
    return undefined;
  }
};

const clientFingerprint = (client: ReportingClient, crypto: import("effect").Crypto.Crypto) => {
  const authority =
    canonicalUrl(client.server.issuer) ??
    `${canonicalUrl(client.server.authorizationUrl) ?? ""}\0${canonicalUrl(client.server.tokenUrl) ?? ""}`;
  return crypto
    .digest("SHA-256", new TextEncoder().encode(`${authority}\0${client.clientId}`))
    .pipe(
      Effect.map(Hex.encode),
      Effect.mapError(() => new StorageError()),
    );
};

const subjectFingerprint = (credentials: Credentials, externalId: string) =>
  credentials
    .fingerprint("OAuth personal-data reporting subject", Redacted.make(externalId))
    .pipe(Effect.mapError(() => new StorageError()));

const usableMethod = (
  definition: ProviderDefinition,
  methodName: string,
  client: ReportingClient,
) => {
  const method = definition.auth[methodName];
  if (
    method?.type !== "oauth2" ||
    method.grant === "client_credentials" ||
    canonicalUrl(method.authorizationUrl) !== canonicalUrl(client.server.authorizationUrl) ||
    canonicalUrl(method.tokenUrl) !== canonicalUrl(client.server.tokenUrl) ||
    !(method.scopes ?? []).every((scope) => allowedScopes(client).includes(scope))
  )
    return undefined;
  return method;
};

const accountToken = (fields: Redacted.Redacted<unknown>) => {
  const value = Redacted.value(fields);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const token = (value as Record<string, unknown>).access_token;
  return typeof token === "string" && token !== "" ? token : undefined;
};

export const makePersonalDataReporting = (input: {
  readonly db: Query;
  readonly credentials: Credentials;
  readonly crypto: import("effect").Crypto.Crypto;
  readonly oauth: OAuth;
  readonly clients: ReadonlyArray<typeof FirstPartyOAuthClient.Type>;
  readonly httpClient: HttpClient.HttpClient | undefined;
  readonly urlPolicy: UrlPolicy | undefined;
}): PersonalDataReportingHost => {
  const clients = input.clients.filter(
    (client): client is ReportingClient => client.personalDataReporting !== undefined,
  );
  let allFingerprints: string[] = [];
  const clientsByFingerprint = new Map<string, ReportingClient>();

  const findContext = (id: AccountId, owner: OwnerIdType, client: ReportingClient) =>
    Effect.gen(function* () {
      const row = yield* query(() =>
        input.db.findFirst("accounts", {
          where: (b) => b.and(b("id", "=", id), b("owner", "=", OwnerId.make(owner))),
        }),
      );
      if (row === null) return undefined;
      const account = yield* Schema.decodeUnknownEffect(StoredAccount)(row).pipe(
        Effect.mapError(() => new StorageError()),
      );
      const providerRow = yield* query(() =>
        input.db.findFirst("providers", { where: (b) => b("id", "=", account.provider) }),
      );
      if (providerRow === null) return undefined;
      const provider = yield* Schema.decodeUnknownEffect(Provider)(providerRow).pipe(
        Effect.mapError(() => new StorageError()),
      );
      const method = usableMethod(provider.definition, account.method, client);
      return method === undefined
        ? undefined
        : ({ account, provider, method } satisfies AccountContext);
    });

  const resolveToken = (context: AccountContext, client: ReportingClient) =>
    input.oauth.resolve(context.account, context.provider.definition).pipe(
      Effect.result,
      Effect.flatMap((result) => {
        if (Result.isFailure(result)) return Effect.succeed(undefined);
        if (result.success.firstParty !== client.id) return Effect.succeed(undefined);
        const token = accountToken(result.success.fields);
        return Effect.succeed(
          token === undefined ? undefined : { token, generation: result.success.generation },
        );
      }),
    );

  const resetState = (
    account: StoredAccount,
    owner: OwnerIdType,
    fingerprint: string,
    now: Date,
  ) => ({
    id: account.id,
    owner,
    clientFingerprint: fingerprint,
    credentialGeneration: account.credentialGeneration,
    status: "refresh_pending" as const,
    encryptedExternalId: null,
    externalIdFingerprint: null,
    retrievedAt: null,
    reportedAt: null,
    cycleDays: 7,
    nextReportAt: now,
    retryAt: null,
    retries: 0,
    lease: null,
    leaseUntil: null,
  });

  /** Add new connections and invalidate state after a reconnect changed its credential generation. */
  const synchronize = () =>
    Effect.gen(function* () {
      if (clients.length === 0) return;
      const clientFingerprints = new Map<string, string>();
      for (const client of clients)
        clientFingerprints.set(client.id, yield* clientFingerprint(client, input.crypto));
      const providerRows = yield* query(() => input.db.findMany("providers"));
      const providers = yield* Schema.decodeUnknownEffect(Schema.Array(Provider))(
        providerRows,
      ).pipe(Effect.mapError(() => new StorageError()));
      const providerMethods = new Map<
        string,
        { readonly provider: Provider; readonly clients: ReportingClient[] }
      >();
      for (const provider of providers) {
        for (const client of clients) {
          for (const method of Object.keys(provider.definition.auth)) {
            if (usableMethod(provider.definition, method, client) === undefined) continue;
            const key = `${provider.id}:${method}`;
            const match = providerMethods.get(key);
            if (match === undefined) providerMethods.set(key, { provider, clients: [client] });
            else match.clients.push(client);
          }
        }
      }
      yield* Effect.annotateCurrentSpan(
        "executor.personal_data_reporting.provider_method_count",
        providerMethods.size,
      );
      if (providerMethods.size === 0) return;
      const providerIds = [
        ...new Set([...providerMethods.values()].map(({ provider }) => provider.id)),
      ];
      const accountRows = yield* query(() =>
        input.db.findMany("accounts", { where: (b) => b("provider", "in", providerIds) }),
      );
      const accounts = yield* Schema.decodeUnknownEffect(Schema.Array(StoredAccount))(
        accountRows,
      ).pipe(Effect.mapError(() => new StorageError()));
      const eligibleAccountCount = accounts.filter((account) =>
        providerMethods.has(`${account.provider}:${account.method}`),
      ).length;
      yield* Effect.annotateCurrentSpan({
        "executor.personal_data_reporting.account_count": accounts.length,
        "executor.personal_data_reporting.eligible_account_count": eligibleAccountCount,
      });
      const accountIds = accounts.map((account) => account.id);
      if (accountIds.length === 0) return;
      const oldRows = yield* query(() =>
        input.db.findMany("accountReports", { where: (b) => b("id", "in", accountIds) }),
      );
      const old = new Map((oldRows as ReportRow[]).map((row) => [row.id, row]));
      const now = new Date(yield* Clock.currentTimeMillis);
      let synchronizedAccountCount = 0;
      for (const account of accounts) {
        const matches = providerMethods.get(`${account.provider}:${account.method}`);
        if (matches === undefined) continue;
        const previous = old.get(account.id);
        const existingClient =
          previous === undefined
            ? undefined
            : matches.clients.find(
                (client) => clientFingerprints.get(client.id) === previous.clientFingerprint,
              );
        if (
          previous !== undefined &&
          existingClient !== undefined &&
          previous.owner === account.owner &&
          previous.credentialGeneration === account.credentialGeneration
        )
          continue;
        const provider = matches.provider;
        let selectedClient: ReportingClient | undefined;
        let resolved: { readonly token: string; readonly generation: number } | undefined;
        const candidates = existingClient === undefined ? matches.clients : [existingClient];
        for (const candidate of candidates) {
          const candidateContext = {
            account,
            provider,
            method: usableMethod(provider.definition, account.method, candidate)!,
          } satisfies AccountContext;
          resolved = yield* resolveToken(candidateContext, candidate);
          if (resolved !== undefined) {
            selectedClient = candidate;
            break;
          }
        }
        if (resolved === undefined || selectedClient === undefined) continue;
        const fingerprint = clientFingerprints.get(selectedClient.id);
        if (fingerprint === undefined) continue;
        const reset = resetState(account, account.owner, fingerprint, now);
        yield* query(() =>
          input.db.upsert("accountReports", {
            where: (b) => b("id", "=", account.id),
            create: { ...reset, owner: OwnerId.make(reset.owner) },
            update: reset,
          }),
        );
        synchronizedAccountCount++;
      }
      yield* Effect.annotateCurrentSpan(
        "executor.personal_data_reporting.synchronized_account_count",
        synchronizedAccountCount,
      );
    });

  const parseExternalId = (row: ReportRow) =>
    Effect.gen(function* () {
      if (row.encryptedExternalId === null) return undefined;
      const decrypted = yield* input.credentials
        .decrypt(row.id, Redacted.make(row.encryptedExternalId))
        .pipe(Effect.mapError(() => new StorageError()));
      const decoded = Schema.decodeUnknownOption(ExternalId)(Redacted.value(decrypted));
      return Option.isSome(decoded) ? decoded.value.externalId : undefined;
    });

  const backoff = (
    row: ReportRow,
    retryAfterSeconds: number | undefined,
    status: number | null,
    now: Date,
  ) => {
    const seconds =
      retryAfterSeconds ??
      (status === 403 || status === 400
        ? 24 * 60 * 60
        : Math.min(24 * 60 * 60, 5 * 60 * 2 ** Math.min(row.retries, 8)));
    return new Date(now.getTime() + Math.ceil(seconds * 1000));
  };

  const delayForCycle = (cycleDays: number, fingerprint: string, now: Date) => {
    // Stable positive jitter spreads a registration's subjects over the cycle without reporting early.
    const jitterHours = Number.parseInt(fingerprint.slice(0, 8), 16) % 6;
    return new Date(now.getTime() + cycleDays * 86_400_000 + jitterHours * 3_600_000);
  };

  const updateBySubject = (
    clientFingerprint: string,
    fingerprints: readonly string[],
    set: Partial<Omit<ReportRow, "id" | "owner">>,
    lease?: string,
  ) =>
    query(() =>
      input.db.updateMany("accountReports", {
        where: (b) =>
          b.and(
            b("clientFingerprint", "=", clientFingerprint),
            b("externalIdFingerprint", "in", fingerprints),
            lease === undefined ? true : b("lease", "=", lease),
          ),
        set,
      }),
    );

  const releaseFailedSubject = (
    rows: readonly ReportRow[],
    lease: string,
    now: Date,
    status: number | null,
    retryAfterSeconds?: number,
  ) => {
    const retryAt = backoff(rows[0]!, retryAfterSeconds, status, now);
    const fingerprints = [...new Set(rows.flatMap((row) => row.externalIdFingerprint ?? []))];
    return Effect.forEach(
      fingerprints,
      (fingerprint) =>
        updateBySubject(
          rows[0]!.clientFingerprint,
          [fingerprint],
          {
            retryAt,
            retries: rows[0]!.retries + 1,
            lease: null,
            leaseUntil: null,
          },
          lease,
        ),
      { concurrency: 1, discard: true },
    ).pipe(Effect.asVoid);
  };

  const releaseFailedAccount = (
    row: ReportRow,
    lease: string,
    now: Date,
    status: number | null,
    retryAfterSeconds?: number,
  ) =>
    query(() =>
      input.db.updateMany("accountReports", {
        where: (b) => b.and(b("id", "=", row.id), b("lease", "=", lease)),
        set: {
          retryAt: backoff(row, retryAfterSeconds, status, now),
          retries: row.retries + 1,
          lease: null,
          leaseUntil: null,
        },
      }),
    );

  const claimAccount = (row: ReportRow, now: Date) =>
    Effect.gen(function* () {
      const token = yield* input.crypto.randomUUIDv4.pipe(
        Effect.mapError(() => new StorageError()),
      );
      const leaseUntil = new Date(now.getTime() + leaseMillis);
      yield* query(() =>
        input.db.updateMany("accountReports", {
          where: (b) =>
            b.and(
              b("id", "=", row.id),
              b("status", "=", "refresh_pending"),
              b.or(b("lease", "is", null), b("leaseUntil", "<=", now)),
              b.or(b("retryAt", "is", null), b("retryAt", "<=", now)),
            ),
          set: { lease: token, leaseUntil },
        }),
      );
      const claimed = yield* query(() =>
        input.db.findFirst("accountReports", {
          where: (b) => b.and(b("id", "=", row.id), b("lease", "=", token)),
        }),
      );
      return claimed === null ? undefined : { row: claimed as ReportRow, token };
    });

  const resolveContextToken = (row: ReportRow, client: ReportingClient) =>
    Effect.gen(function* () {
      const context = yield* findContext(row.id, row.owner, client);
      if (context === undefined) return undefined;
      if (context.account.credentialGeneration !== row.credentialGeneration) return undefined;
      const resolved = yield* resolveToken(context, client);
      return resolved === undefined || resolved.generation !== row.credentialGeneration
        ? undefined
        : { context, token: resolved.token };
    });

  const refreshOne = (row: ReportRow, lease: string, client: ReportingClient, now: Date) =>
    Effect.gen(function* () {
      const resolved = yield* resolveContextToken(row, client);
      if (resolved === undefined) {
        yield* releaseFailedAccount(row, lease, now, null);
        return false;
      }
      const config = client.personalDataReporting;
      const http = input.httpClient;
      const policy = input.urlPolicy;
      if (http === undefined || policy === undefined) {
        yield* releaseFailedAccount(row, lease, now, null);
        return false;
      }
      const identity = yield* fetchIdentity(http, policy, config, resolved.token);
      const completedAt = new Date(yield* Clock.currentTimeMillis);
      if (identity.kind !== "ok") {
        yield* releaseFailedAccount(
          row,
          lease,
          completedAt,
          identity.status,
          identity.retryAfterSeconds,
        );
        return false;
      }
      const encrypted = yield* input.credentials
        .encrypt(row.id, Redacted.make({ externalId: identity.accountId }))
        .pipe(Effect.mapError(() => new StorageError()));
      const fingerprint = yield* subjectFingerprint(input.credentials, identity.accountId);
      const peers = yield* query(() =>
        input.db.findMany("accountReports", {
          where: (b) =>
            b.and(
              b("clientFingerprint", "=", row.clientFingerprint),
              b("externalIdFingerprint", "=", fingerprint),
              b("status", "!=", "closed"),
            ),
        }),
      );
      const peerRows = peers as ReportRow[];
      const nextReportAt = peerRows.reduce<Date | null>(
        (latest, peer) =>
          peer.nextReportAt !== null &&
          (latest === null || peer.nextReportAt.getTime() > latest.getTime())
            ? peer.nextReportAt
            : latest,
        row.nextReportAt,
      );
      const reportedAt = peerRows.reduce<Date | null>(
        (latest, peer) =>
          peer.reportedAt !== null &&
          (latest === null || peer.reportedAt.getTime() > latest.getTime())
            ? peer.reportedAt
            : latest,
        row.reportedAt,
      );
      yield* query(() =>
        input.db.updateMany("accountReports", {
          where: (b) => b.and(b("id", "=", row.id), b("lease", "=", lease)),
          set: {
            status: "active",
            encryptedExternalId: encrypted,
            externalIdFingerprint: fingerprint,
            retrievedAt: completedAt,
            reportedAt,
            nextReportAt: nextReportAt ?? now,
            retryAt: null,
            retries: 0,
            lease: null,
            leaseUntil: null,
          },
        }),
      );
      return true;
    });

  const processRefreshes = () =>
    Effect.gen(function* () {
      const now = new Date(yield* Clock.currentTimeMillis);
      const rows = (yield* query(() =>
        input.db.findMany("accountReports", {
          where: (b) =>
            b.and(
              b("status", "=", "refresh_pending"),
              b.or(b("retryAt", "is", null), b("retryAt", "<=", now)),
              b.or(b("lease", "is", null), b("leaseUntil", "<=", now)),
              b("clientFingerprint", "in", allFingerprints),
            ),
          orderBy: ["nextReportAt", "asc"],
          limit: batchSize,
        }),
      )) as ReportRow[];
      let processed = 0;
      for (const row of rows) {
        const client = clientsByFingerprint.get(row.clientFingerprint);
        if (client === undefined) continue;
        const claimed = yield* claimAccount(row, now);
        if (claimed === undefined) continue;
        processed += 1;
        yield* refreshOne(claimed.row, claimed.token, client, now).pipe(
          Effect.ensuring(
            query(() =>
              input.db.updateMany("accountReports", {
                where: (b) => b.and(b("id", "=", row.id), b("lease", "=", claimed.token)),
                set: { lease: null, leaseUntil: null },
              }),
            ).pipe(
              Effect.asVoid,
              Effect.catch(() => Effect.void),
            ),
          ),
        );
      }
      return processed;
    });

  const claimSubjects = (clientFingerprint: string, fingerprints: readonly string[], now: Date) =>
    Effect.gen(function* () {
      const token = yield* input.crypto.randomUUIDv4.pipe(
        Effect.mapError(() => new StorageError()),
      );
      const leaseUntil = new Date(now.getTime() + leaseMillis);
      const claimable: string[] = [];
      for (const fingerprint of fingerprints) {
        const rows = (yield* query(() =>
          input.db.findMany("accountReports", {
            where: (b) =>
              b.and(
                b("clientFingerprint", "=", clientFingerprint),
                b("externalIdFingerprint", "=", fingerprint),
                b("status", "=", "active"),
              ),
          }),
        )) as ReportRow[];
        if (
          rows.length === 0 ||
          rows.some((row) => row.lease !== null && row.leaseUntil !== null && row.leaseUntil > now)
        )
          continue;
        yield* query(() =>
          input.db.updateMany("accountReports", {
            where: (b) =>
              b.and(
                b("clientFingerprint", "=", clientFingerprint),
                b("externalIdFingerprint", "=", fingerprint),
                b("status", "=", "active"),
                b.or(b("lease", "is", null), b("leaseUntil", "<=", now)),
              ),
            set: { lease: token, leaseUntil },
          }),
        );
        const claimed = (yield* query(() =>
          input.db.findMany("accountReports", {
            where: (b) =>
              b.and(
                b("clientFingerprint", "=", clientFingerprint),
                b("externalIdFingerprint", "=", fingerprint),
                b("status", "=", "active"),
              ),
          }),
        )) as ReportRow[];
        if (claimed.length > 0 && claimed.every((row) => row.lease === token))
          claimable.push(fingerprint);
        else
          yield* query(() =>
            input.db.updateMany("accountReports", {
              where: (b) =>
                b.and(
                  b("clientFingerprint", "=", clientFingerprint),
                  b("externalIdFingerprint", "=", fingerprint),
                  b("lease", "=", token),
                ),
              set: { lease: null, leaseUntil: null },
            }),
          );
      }
      return { token, leaseUntil, fingerprints: claimable };
    });

  const updateReported = (
    clientFingerprint: string,
    fingerprints: readonly string[],
    lease: string,
    cycleDays: number,
    now: Date,
  ) =>
    Effect.forEach(
      fingerprints,
      (fingerprint) =>
        updateBySubject(
          clientFingerprint,
          [fingerprint],
          {
            status: "active",
            reportedAt: now,
            cycleDays,
            nextReportAt: delayForCycle(cycleDays, fingerprint, now),
            retryAt: null,
            retries: 0,
            lease: null,
            leaseUntil: null,
          },
          lease,
        ),
      { concurrency: 1, discard: true },
    ).pipe(Effect.asVoid);

  const closeSubject = (clientFingerprint: string, fingerprint: string, lease: string, now: Date) =>
    Effect.gen(function* () {
      const rows = (yield* query(() =>
        input.db.findMany("accountReports", {
          where: (b) =>
            b.and(
              b("clientFingerprint", "=", clientFingerprint),
              b("externalIdFingerprint", "=", fingerprint),
              b("lease", "=", lease),
            ),
        }),
      )) as ReportRow[];
      const removed: { account: AccountId; provider: string; encrypted: Uint8Array }[] = [];
      yield* transaction(input.db, (tx) =>
        Effect.gen(function* () {
          for (const row of rows) {
            const accountRow = yield* query(() =>
              tx.findFirst("accounts", {
                where: (b) => b.and(b("id", "=", row.id), b("owner", "=", OwnerId.make(row.owner))),
              }),
            );
            if (accountRow === null) continue;
            const account = yield* Schema.decodeUnknownEffect(StoredAccount)(accountRow).pipe(
              Effect.mapError(() => new StorageError()),
            );
            const grant = yield* query(() =>
              tx.findFirst("oauthGrants", { where: (b) => b("id", "=", account.id) }),
            );
            const generation = account.credentialGeneration + 1;
            const connections = yield* query(() =>
              tx.findMany("accountConnections", {
                select: ["id", "state"],
                where: (b) => b("reconnectAccount", "=", account.id),
              }),
            );
            const pendingConnections = connections.flatMap((connection) => {
              const state = Schema.decodeUnknownOption(StoredConnectionState)(connection.state);
              return Option.isSome(state) && state.value.status === "pending"
                ? [connection.id]
                : [];
            });
            if (pendingConnections.length > 0)
              yield* query(() =>
                tx.updateMany("accountConnections", {
                  where: (b) => b("id", "in", pendingConnections),
                  set: { state: { status: "cancelled" }, oauthAttempt: null },
                }),
              );
            yield* query(() =>
              tx.updateMany("accounts", {
                where: (b) => b("id", "=", account.id),
                set: {
                  label: "Closed account",
                  description: null,
                  encryptedCredentials: new Uint8Array(),
                  credentialGeneration: generation,
                },
              }),
            );
            yield* query(() =>
              tx.deleteMany("oauthGrants", { where: (b) => b("id", "=", account.id) }),
            );
            yield* query(() =>
              tx.updateMany("accountChecks", {
                where: (b) => b("account", "=", account.id),
                set: {
                  credentialGeneration: generation,
                  status: "credentials_rejected",
                  checkedAt: now,
                  info: null,
                  infoCheckedAt: null,
                  message: closedMessage,
                },
              }),
            );
            yield* query(() =>
              tx.updateMany("accountReports", {
                where: (b) =>
                  b.and(b("id", "=", account.id), b("clientFingerprint", "=", clientFingerprint)),
                set: {
                  credentialGeneration: generation,
                  status: "closed",
                  encryptedExternalId: null,
                  externalIdFingerprint: null,
                  retrievedAt: null,
                  reportedAt: now,
                  nextReportAt: null,
                  retryAt: null,
                  retries: 0,
                  lease: null,
                  leaseUntil: null,
                },
              }),
            );
            if (grant !== null)
              removed.push({
                account: account.id,
                provider: account.provider,
                encrypted: grant.encrypted,
              });
          }
          yield* query(() =>
            tx.updateMany("accountReports", {
              where: (b) =>
                b.and(
                  b("clientFingerprint", "=", clientFingerprint),
                  b("externalIdFingerprint", "=", fingerprint),
                ),
              set: {
                status: "closed",
                encryptedExternalId: null,
                externalIdFingerprint: null,
                retrievedAt: null,
                reportedAt: now,
                nextReportAt: null,
                retryAt: null,
                retries: 0,
                lease: null,
                leaseUntil: null,
              },
            }),
          );
        }),
      );
      yield* Effect.forEach(removed, input.oauth.revokeRemoved, { concurrency: 1, discard: true });
    });

  const refreshSubject = (
    client: ReportingClient,
    clientFp: string,
    fingerprint: string,
    lease: string,
    cycle: number,
    now: Date,
  ) =>
    Effect.gen(function* () {
      const rows = (yield* query(() =>
        input.db.findMany("accountReports", {
          where: (b) =>
            b.and(
              b("clientFingerprint", "=", clientFp),
              b("externalIdFingerprint", "=", fingerprint),
              b("lease", "=", lease),
            ),
        }),
      )) as ReportRow[];
      const deadline = delayForCycle(cycle, fingerprint, now);
      // Invalidate every copy before reading the subject again; a failed lookup cannot report stale data.
      yield* updateBySubject(
        clientFp,
        [fingerprint],
        {
          status: "refresh_pending",
          encryptedExternalId: null,
          externalIdFingerprint: null,
          retrievedAt: null,
          reportedAt: now,
          cycleDays: cycle,
          nextReportAt: deadline,
          retryAt: now,
          retries: 0,
          lease: null,
          leaseUntil: null,
        },
        lease,
      );
      for (const row of rows) {
        const pending = {
          ...row,
          status: "refresh_pending" as const,
          externalIdFingerprint: null,
          encryptedExternalId: null,
          retrievedAt: null,
          nextReportAt: deadline,
          retryAt: now,
          lease: null,
          leaseUntil: null,
        };
        const claimed = yield* claimAccount(pending, now);
        if (claimed !== undefined) yield* refreshOne(claimed.row, claimed.token, client, now);
      }
    });

  const processActions = (
    client: ReportingClient,
    clientFp: string,
    lease: string,
    cycleDays: number,
    requested: ReadonlyMap<string, string>,
    actions: readonly AccountAction[],
    now: Date,
  ) =>
    Effect.gen(function* () {
      const acted = new Set(actions.map((action) => action.accountId));
      for (const [accountId, fingerprint] of requested) {
        if (!acted.has(accountId)) {
          yield* updateReported(clientFp, [fingerprint], lease, cycleDays, now);
          continue;
        }
        const action = actions.find((item) => item.accountId === accountId)!;
        if (action.status === "closed") yield* closeSubject(clientFp, fingerprint, lease, now);
        else yield* refreshSubject(client, clientFp, fingerprint, lease, cycleDays, now);
      }
    });

  const processOneReportBatch = () =>
    Effect.gen(function* () {
      if (clients.length === 0 || input.httpClient === undefined || input.urlPolicy === undefined)
        return 0;
      const now = new Date(yield* Clock.currentTimeMillis);
      const due = (yield* query(() =>
        input.db.findMany("accountReports", {
          where: (b) =>
            b.and(
              b("status", "=", "active"),
              b("clientFingerprint", "in", allFingerprints),
              b("nextReportAt", "<=", now),
              b.or(b("retryAt", "is", null), b("retryAt", "<=", now)),
              b.or(b("lease", "is", null), b("leaseUntil", "<=", now)),
            ),
          orderBy: ["nextReportAt", "asc"],
          limit: batchSize,
        }),
      )) as ReportRow[];
      if (due.length === 0) return 0;
      const first = due[0]!;
      const client = clientsByFingerprint.get(first.clientFingerprint);
      if (client === undefined) return 0;
      const selected = due.filter(
        (row) => row.owner === first.owner && row.clientFingerprint === first.clientFingerprint,
      );
      const invalid = selected.filter((row) => row.externalIdFingerprint === null);
      for (const row of invalid)
        yield* query(() =>
          input.db.updateMany("accountReports", {
            where: (b) => b.and(b("id", "=", row.id), b("status", "=", "active")),
            set: {
              status: "refresh_pending",
              encryptedExternalId: null,
              externalIdFingerprint: null,
              retrievedAt: null,
              retryAt: now,
            },
          }),
        );
      const fingerprints = [...new Set(selected.flatMap((row) => row.externalIdFingerprint ?? []))];
      const claimed = yield* claimSubjects(first.clientFingerprint, fingerprints, now);
      const claimedSet = new Set(claimed.fingerprints);
      const rows = selected.filter(
        (row) => row.externalIdFingerprint !== null && claimedSet.has(row.externalIdFingerprint),
      );
      if (rows.length === 0) return invalid.length;
      const requestIds = new Map<string, string>();
      const bodyAccounts: { accountId: string; updatedAt: Date }[] = [];
      const peersByFingerprint = new Map<string, ReportRow[]>();
      for (const fingerprint of claimed.fingerprints) {
        const peers = (yield* query(() =>
          input.db.findMany("accountReports", {
            where: (b) =>
              b.and(
                b("clientFingerprint", "=", first.clientFingerprint),
                b("externalIdFingerprint", "=", fingerprint),
                b("status", "=", "active"),
                b("lease", "=", claimed.token),
              ),
          }),
        )) as ReportRow[];
        peersByFingerprint.set(fingerprint, peers);
      }
      for (const row of rows) {
        const fingerprint = row.externalIdFingerprint!;
        if (requestIds.has(fingerprint)) continue;
        const peers = peersByFingerprint.get(fingerprint) ?? [];
        const ids = yield* Effect.forEach(peers, parseExternalId, { concurrency: 1 });
        const externalId = ids.find((id) => id !== undefined);
        const oldest = peers
          .map((peer) => peer.retrievedAt)
          .filter((at): at is Date => at !== null)
          .toSorted((a, b) => a.getTime() - b.getTime())[0];
        if (externalId === undefined || oldest === undefined) continue;
        requestIds.set(externalId, fingerprint);
        bodyAccounts.push({ accountId: externalId, updatedAt: oldest });
      }
      if (bodyAccounts.length === 0) {
        yield* updateBySubject(
          first.clientFingerprint,
          claimed.fingerprints,
          {
            status: "refresh_pending",
            encryptedExternalId: null,
            externalIdFingerprint: null,
            retrievedAt: null,
            retryAt: now,
            lease: null,
            leaseUntil: null,
          },
          claimed.token,
        );
        return rows.length;
      }
      let reporter: string | undefined;
      for (const row of rows) {
        const resolved = yield* resolveContextToken(row, client);
        if (resolved !== undefined && row.owner === first.owner) {
          reporter = resolved.token;
          break;
        }
      }
      if (reporter === undefined) {
        yield* releaseFailedSubject(rows, claimed.token, now, null);
        return rows.length;
      }
      const result = yield* reportAccounts(
        input.httpClient,
        input.urlPolicy,
        client.personalDataReporting,
        reporter,
        bodyAccounts,
      );
      const completedAt = new Date(yield* Clock.currentTimeMillis);
      if (result.kind === "failed") {
        yield* releaseFailedSubject(
          rows,
          claimed.token,
          completedAt,
          result.status,
          result.retryAfterSeconds,
        );
        return rows.length;
      }
      yield* processActions(
        client,
        first.clientFingerprint,
        claimed.token,
        result.cycleDays,
        requestIds,
        result.kind === "actions" ? result.actions : [],
        completedAt,
      );
      return rows.length;
    });

  const run = Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({
      "executor.personal_data_reporting.client_count": clients.length,
      "executor.personal_data_reporting.http_client_available": input.httpClient !== undefined,
      "executor.personal_data_reporting.url_policy_available": input.urlPolicy !== undefined,
    });
    if (clients.length === 0 || input.httpClient === undefined || input.urlPolicy === undefined)
      return;
    for (const client of clients) {
      const fingerprint = yield* clientFingerprint(client, input.crypto);
      clientsByFingerprint.set(fingerprint, client);
    }
    allFingerprints = [...clientsByFingerprint.keys()];
    yield* synchronize();
    let refreshCount = 0;
    let reportCount = 0;
    for (let batch = 0; batch < batchesPerRun; batch++) {
      const refreshed = yield* processRefreshes();
      const reported = yield* processOneReportBatch();
      refreshCount += refreshed;
      reportCount += reported;
      if (refreshed === 0 && reported === 0) break;
    }
    yield* Effect.annotateCurrentSpan({
      "executor.personal_data_reporting.refresh_count": refreshCount,
      "executor.personal_data_reporting.report_count": reportCount,
    });
  }).pipe(Effect.withSpan("sdk.personalDataReporting.run"));

  return { run };
};
