/** Bounded HTTP operations for the host-owned account reporting protocol. */
import { Effect, Option, Result, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as Headers from "effect/http/Headers";
import { parseDestination, type UrlPolicy } from "@executor-js/utils/url-policy";
import type { PersonalDataReporting } from "../contracts/oauth.ts";

const maxBodyBytes = 64 * 1024;
const accountIdPattern = /^[A-Za-z0-9:-]{1,128}$/u;

export interface ReportAccount {
  readonly accountId: string;
  readonly updatedAt: Date;
}

export type AccountAction = { readonly accountId: string; readonly status: "closed" | "updated" };

export type HttpFailure = {
  readonly kind: "failed";
  readonly status: number | null;
  readonly retryAfterSeconds: number | undefined;
};

export type IdentityResult = { readonly kind: "ok"; readonly accountId: string } | HttpFailure;

export type ReportResult =
  | { readonly kind: "no_action"; readonly cycleDays: number }
  | {
      readonly kind: "actions";
      readonly cycleDays: number;
      readonly actions: readonly AccountAction[];
    }
  | HttpFailure;

const responseText = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    let size = 0;
    const chunks: Uint8Array[] = [];
    let overflow = false;
    const read = yield* response.stream.pipe(
      Stream.takeWhile((chunk) => {
        size += chunk.byteLength;
        if (size > maxBodyBytes) {
          overflow = true;
          return false;
        }
        chunks.push(chunk);
        return true;
      }),
      Stream.runDrain,
      Effect.result,
    );
    if (Result.isFailure(read)) return undefined;
    if (overflow) return undefined;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  });

const header = (headers: Headers.Headers, name: string) =>
  Option.getOrUndefined(Headers.get(headers, name));

const retryAfter = (headers: Headers.Headers) => {
  const value = header(headers, "retry-after");
  if (value === undefined || !/^\d+(?:\.\d+)?$/u.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
};

const failed = (status: number | null, headers?: Headers.Headers): HttpFailure => ({
  kind: "failed",
  status,
  retryAfterSeconds: headers === undefined ? undefined : retryAfter(headers),
});

const json = (text: string | undefined): unknown => {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const identityId = (value: unknown, field: string): string | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const id = (value as Record<string, unknown>)[field];
  return typeof id === "string" && id !== "unknown" && accountIdPattern.test(id) ? id : undefined;
};

const cycleDays = (headers: Headers.Headers): number | undefined => {
  const value = header(headers, "cycle-period");
  if (value === undefined) return 7;
  const days = Number(value);
  return Number.isFinite(days) && days > 0 && days <= 100_000_000 ? days : undefined;
};

const actions = (
  value: unknown,
  requested: ReadonlySet<string>,
): readonly AccountAction[] | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (Object.keys(value).some((key) => key !== "accounts")) return undefined;
  const accounts = (value as { readonly accounts?: unknown }).accounts;
  if (!Array.isArray(accounts) || accounts.length > 90) return undefined;
  const seen = new Set<string>();
  const result: AccountAction[] = [];
  for (const item of accounts) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some((key) => key !== "accountId" && key !== "status")) return undefined;
    const { accountId, status } = row;
    if (
      typeof accountId !== "string" ||
      !accountIdPattern.test(accountId) ||
      !requested.has(accountId) ||
      seen.has(accountId) ||
      (status !== "closed" && status !== "updated")
    )
      return undefined;
    seen.add(accountId);
    result.push({ accountId, status });
  }
  return result;
};

const send = (
  client: HttpClient.HttpClient,
  policy: UrlPolicy,
  url: string,
  token: string,
  body?: unknown,
) =>
  Effect.gen(function* () {
    const destination = parseDestination(url, policy);
    if (destination === undefined) return undefined;
    const request =
      body === undefined
        ? HttpClientRequest.get(destination.href).pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
            HttpClientRequest.setHeader("accept", "application/json"),
          )
        : HttpClientRequest.post(destination.href).pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
            HttpClientRequest.setHeader("accept", "application/json"),
            HttpClientRequest.bodyText(JSON.stringify(body), "application/json"),
          );
    const result = yield* HttpClient.withScope(client)
      .execute(request)
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.result,
      );
    if (Result.isFailure(result)) return undefined;
    return result.success;
  });

export const fetchIdentity = (
  client: HttpClient.HttpClient,
  policy: UrlPolicy,
  config: PersonalDataReporting,
  token: string,
): Effect.Effect<IdentityResult> =>
  Effect.scoped(
    Effect.gen(function* () {
      const response = yield* send(client, policy, config.identityUrl, token);
      if (response === undefined) return failed(null);
      if (response.status !== 200) return failed(response.status, response.headers);
      const id = identityId(json(yield* responseText(response)), config.accountIdField);
      return id === undefined
        ? failed(response.status, response.headers)
        : { kind: "ok", accountId: id };
    }),
  );

export const reportAccounts = (
  client: HttpClient.HttpClient,
  policy: UrlPolicy,
  config: PersonalDataReporting,
  token: string,
  accounts: readonly ReportAccount[],
): Effect.Effect<ReportResult> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (accounts.length === 0 || accounts.length > 90) return failed(null);
      const requested = new Set(accounts.map((account) => account.accountId));
      if (
        requested.size !== accounts.length ||
        accounts.some(
          (account) => !accountIdPattern.test(account.accountId) || account.accountId === "unknown",
        )
      )
        return failed(null);
      const response = yield* send(client, policy, config.reportUrl, token, {
        accounts: accounts.map((account) => ({
          accountId: account.accountId,
          updatedAt: account.updatedAt.toISOString(),
        })),
      });
      if (response === undefined) return failed(null);
      const cycle = cycleDays(response.headers);
      if (response.status === 204 && cycle !== undefined)
        return { kind: "no_action", cycleDays: cycle };
      if (response.status === 200 && cycle !== undefined) {
        const parsed = actions(json(yield* responseText(response)), requested);
        if (parsed !== undefined) return { kind: "actions", cycleDays: cycle, actions: parsed };
      }
      return failed(response.status, response.headers);
    }),
  );
