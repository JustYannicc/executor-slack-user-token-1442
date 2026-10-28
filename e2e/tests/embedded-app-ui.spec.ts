/** Browser proof through a real self-host, including the existing browser-bound sign-in protocol. */
import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { waitForAppUrl } from "../support/app-pages.ts";
import { Target } from "../support/platform.ts";

const files = [
  {
    path: "index.ts",
    content: `import { defineApp } from "apps"; export default defineApp({}, {});`,
  },
  {
    path: "ui/index.html",
    content: `<!doctype html><html><head><title>Embedded fixture</title><style>body{font:14px system-ui;margin:28px;color:#18181b}h1{font-size:24px;letter-spacing:-.02em}label{display:grid;gap:8px;max-width:360px}input{font:inherit;border:1px solid #d4d4d8;border-radius:6px;padding:8px}</style></head><body><main><h1>Embedded fixture screen</h1><label>Draft<input name="draft"></label></main></body></html>`,
  },
  appsManifest,
];

layer(HostedLive, { excludeTestServices: true })("Embedded app screens", (it) => {
  it.effect(scenarios.embeddedAppUi.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          target = yield* Target;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deploy = (name: string, ancestor?: string) =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name,
              files:
                ancestor === undefined
                  ? files
                  : files.map((file) =>
                      file.path === "ui/index.html"
                        ? {
                            ...file,
                            content: file.content.replace(
                              "</main>",
                              `<iframe title="Foreign app frame" src="${ancestor}"></iframe></main>`,
                            ),
                          }
                        : file,
                    ),
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const app = yield* body(App, response);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
            );
            const url = yield* waitForAppUrl(actors.owner, `${prefix}/apps/${app.id}/ui`);
            expect(new URL(url).hostname).toBe(`a-${app.id.slice(4)}.fixture.localhost`);
            return { app, url };
          });
        const first = yield* deploy("Embedded fixture one");
        const second = yield* deploy("Embedded fixture two", first.url);
        yield* browser.login(actors.owner);
        // Cookies never enter retained network traces or screenshots.
        yield* browser.omitNetworkTrace;
        const detail = `/org/${actors.organization.slug}/apps/${first.app.id}`;
        yield* browser.use("Open the app cards", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps`),
        );
        yield* browser.use("App cards advertise screens", (page) =>
          page
            .getByRole("link", { name: `Open ${first.app.name}`, exact: true })
            .getByText("App screen")
            .waitFor(),
        );
        yield* browser.checkpoint("apps-list-with-screen");
        yield* browser.use("The App tab completes sign-in inside its frame", (page) =>
          Promise.all([
            page.waitForResponse(
              (response) =>
                new URL(response.url()).origin === first.url &&
                new URL(response.url()).pathname === "/_executor/auth/callback" &&
                response.status() === 302 &&
                response.request().frame() !== page.mainFrame(),
            ),
            page.goto(detail),
          ]),
        );
        yield* browser.use("The isolated app renders its authored screen", (page) =>
          page
            .frameLocator(`iframe[title="${first.app.name} app"]`)
            .getByRole("heading", { name: "Embedded fixture screen" })
            .waitFor(),
        );
        yield* browser.use("The host receives app readiness", (page) =>
          page.getByRole("status").filter({ hasText: "Loading app…" }).waitFor({ state: "hidden" }),
        );
        yield* browser.use("The default App tab has the approved sandbox", (page) =>
          Promise.all([
            page
              .getByRole("navigation", { name: "App navigation" })
              .getByRole("link", { name: "App", exact: true })
              .getAttribute("aria-current"),
            page.locator("iframe").getAttribute("sandbox"),
            page.locator("iframe").getAttribute("allow"),
            page.locator("iframe").getAttribute("referrerpolicy"),
            page.getByRole("link", { name: "Open in new tab" }).getAttribute("href"),
          ]).then(([selected, sandbox, allow, referrer, href]) => {
            expect(page.url()).toBe(`${target.metadata.origin}${detail}`);
            expect(selected).toBe("page");
            expect(sandbox).toBe(
              "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads",
            );
            expect(allow).toBe("clipboard-write");
            expect(referrer).toBe("no-referrer");
            expect(href).toBe(first.url);
          }),
        );
        yield* browser.checkpoint("embedded-app-tab");
        yield* browser.use("App origins cannot read the dashboard DOM or cookies", (page) => {
          const frame = page.frames().find((frame) => frame.url().startsWith(first.url));
          expect(frame).toBeDefined();
          return Promise.all([
            frame!.evaluate(() => {
              try {
                void parent.document.body;
                return false;
              } catch {
                return true;
              }
            }),
            frame!.evaluate(() => document.cookie),
          ]).then(([blocked, cookies]) => {
            expect(blocked).toBe(true);
            expect(cookies).toBe("");
          });
        });
        yield* browser.use("Host-only Lax cookies and app-scoped tokens isolate sessions", (page) =>
          page
            .context()
            .cookies(first.url)
            .then((cookies) => {
              const session = cookies.find((cookie) => cookie.name === "executor_app");
              expect(
                session !== undefined &&
                  session.httpOnly &&
                  session.sameSite === "Lax" &&
                  session.domain === new URL(first.url).hostname,
              ).toBe(true);
              return page
                .context()
                .request.get(`${second.url}/`, {
                  headers: {
                    Cookie: `${session!.name}=${session!.value}`,
                    Accept: "application/json",
                  },
                })
                .then((response) => expect(response.status()).toBe(401));
            }),
        );
        yield* browser.use("The second app has no first-app cookie", (page) =>
          page
            .context()
            .cookies(second.url)
            .then((cookies) =>
              expect(cookies.some((cookie) => cookie.name === "executor_app")).toBe(false),
            ),
        );
        yield* browser.use("Only the dashboard may frame app documents", (page) =>
          page
            .context()
            .request.get(first.url)
            .then((response) =>
              expect(response.headers()["content-security-policy"]).toBe(
                `frame-ancestors ${target.metadata.origin}`,
              ),
            ),
        );
        yield* browser.use("Only app-auth allows same-origin framing", (page) =>
          page
            .context()
            .request.get(`${target.metadata.origin}/app-auth`)
            .then((response) => {
              expect(response.headers()["content-security-policy"]).toBe("frame-ancestors 'self'");
              expect(response.headers()["x-frame-options"]).toBe("SAMEORIGIN");
            }),
        );
        yield* browser.use("Other dashboard pages refuse all ancestors", (page) =>
          page
            .context()
            .request.get(`${target.metadata.origin}/`)
            .then((response) =>
              expect(response.headers()["content-security-policy"]).toBe("frame-ancestors 'none'"),
            ),
        );
        yield* browser.use("Open the second app's own frame", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${second.app.id}?view=app`),
        );
        yield* browser.use("The second app has its own screen", (page) =>
          page
            .frameLocator("iframe")
            .getByRole("heading", { name: "Embedded fixture screen" })
            .waitFor(),
        );
        yield* browser.use("The second app cannot fetch the first app's session", (page) => {
          const frame = page.frames().find((frame) => frame.url().startsWith(second.url));
          expect(frame).toBeDefined();
          return Promise.all([
            page.waitForRequest((request) => request.url() === `${first.url}/`),
            frame!
              .evaluate(
                (url) =>
                  fetch(url, { credentials: "include" }).then(
                    () => false,
                    () => true,
                  ),
                first.url,
              )
              .then((blocked) => expect(blocked).toBe(true)),
          ]);
        });
        yield* browser.use(
          "The server refuses a second-app origin even with first-app cookies",
          (page) =>
            page
              .context()
              .request.get(first.url, { headers: { Origin: second.url } })
              .then((response) => expect(response.status()).toBe(403)),
        );
        yield* browser.checkpoint("second-app-isolated");
        const foreign = yield* browser.use("Open a foreign same-site origin", (page) =>
          page.context().newPage(),
        );
        yield* Effect.addFinalizer(() =>
          browser.use("Close the foreign page", () => foreign.close()).pipe(Effect.orDie),
        );
        const foreignOrigin = second.url;
        const foreignResult = yield* browser.use("Browser CSP refuses the foreign ancestor", () => {
          const refused = { csp: false, failures: [] as string[] };
          foreign.on("console", (message) => {
            if (message.text().includes("frame-ancestors")) refused.csp = true;
          });
          foreign.on("requestfailed", (request) => {
            if (request.resourceType() === "document")
              refused.failures.push(request.failure()?.errorText ?? "unknown");
          });
          return foreign.goto(foreignOrigin).then(() => ({
            ...refused,
            appCommitted: foreign.frames().some((frame) => frame.url().startsWith(first.url)),
          }));
        });
        expect(foreignResult).toEqual({
          csp: true,
          failures: ["net::ERR_BLOCKED_BY_RESPONSE"],
          appCommitted: false,
        });
        // Network failure and time are controlled at the browser boundary.
        yield* browser.use("Refuse the next app document", (page) =>
          page.route(`${first.url}/`, (route) => route.abort("failed")),
        );
        yield* browser.use("Control the frame loading deadline", (page) => page.clock.install());
        yield* browser.use("Open the failing frame", (page) => page.goto(`${detail}?view=app`));
        yield* browser.use("The pending frame announces loading", (page) =>
          page.getByRole("status").filter({ hasText: "Loading app…" }).waitFor(),
        );
        yield* browser.use("Reach the loading deadline", (page) => page.clock.runFor(30001));
        yield* browser.use("The failed frame offers recovery", (page) =>
          page.getByRole("alert").filter({ hasText: "The app did not finish loading" }).waitFor(),
        );
        yield* browser.checkpoint("embedded-app-failed");
        yield* browser.use("Restore app documents", (page) => page.unroute(`${first.url}/`));
        yield* browser.use("Retry the app frame", (page) =>
          page.getByRole("button", { name: "Retry", exact: true }).click(),
        );
        yield* browser.use("Retry renders the real screen", (page) =>
          page
            .frameLocator("iframe")
            .getByRole("heading", { name: "Embedded fixture screen" })
            .waitFor(),
        );
        yield* browser.checkpoint("embedded-app-recovered");
        const renamed = yield* api.request(
          actors.owner,
          "PATCH",
          `${prefix}/apps/${first.app.id}/name`,
          { name: "Renamed embedded fixture" },
        );
        expect(renamed.status).toBe(200);
        expect(yield* waitForAppUrl(actors.owner, `${prefix}/apps/${first.app.id}/ui`)).toBe(
          first.url,
        );
        const toolResponse = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Tool only fixture",
          files: files.filter((file) => !file.path.startsWith("ui/")),
        });
        expect(toolResponse.status).toBe(200);
        const toolOnly = yield* body(App, toolResponse);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${toolOnly.id}`).pipe(Effect.orDie),
        );
        const toolLocation = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/apps/${toolOnly.id}/ui`,
        );
        expect(toolLocation.body).toEqual({
          status: "unavailable",
          embedded: true,
          reason: "no_ui",
          url: null,
        });
        yield* browser.use("Open an app whose deployed version has no UI", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${toolOnly.id}`),
        );
        yield* browser.use("The tool-only app keeps its overview", (page) =>
          page.getByRole("heading", { name: toolOnly.name }).waitFor(),
        );
        expect(
          yield* browser.use("Tool-only apps have no App tab or frame", (page) =>
            Promise.all([
              page
                .getByRole("navigation", { name: "App navigation" })
                .getByRole("link", { name: "App", exact: true })
                .count(),
              page.locator("iframe").count(),
            ]),
          ),
        ).toEqual([0, 0]);
      }),
    ),
  );
});
