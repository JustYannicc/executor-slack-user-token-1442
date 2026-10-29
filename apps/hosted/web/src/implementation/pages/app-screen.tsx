import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { App } from "@executor-js/sdk";
import { Button } from "@executor-js/ui/components/button";
import { Skeleton } from "@executor-js/ui/components/skeleton";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";
import { appUiError, appUiLocationAtom } from "../../contracts/app-ui.ts";
import { useOrganizationRoute } from "../components/organization.tsx";

/** App metadata keeps the card label in the existing list request. */
export function AppScreenBadge({ app }: { readonly app: App }) {
  const hasUi = "hasUi" in app ? app.hasUi : undefined;
  return app.activeVersion !== null && hasUi !== false ? (
    <span className="font-mono text-xs text-muted-foreground">App screen</span>
  ) : null;
}

export function AppScreen({ app }: { readonly app: App }) {
  const { organization, slug } = useOrganizationRoute();
  const location = appUiLocationAtom({
    organization,
    slug,
    app: app.id,
    appSlug: app.slug,
    version: app.activeVersion,
  });
  const result = useAtomValue(location);
  const refresh = useAtomRefresh(location);
  if (AsyncResult.isFailure(result))
    return <ScreenStatus message={appUiError(result.cause)} retry={refresh} />;
  if (!AsyncResult.isSuccess(result)) return <AppSkeleton />;
  if (result.value.status === "pending")
    return <ScreenStatus message="Preparing app domain…" retry={refresh} />;
  if (result.value.status === "failed")
    return <ScreenStatus message="App domain setup needs attention." retry={refresh} />;
  if (result.value.status === "unavailable")
    return (
      <ScreenStatus
        message={
          result.value.reason === "no_ui"
            ? "This app has no screen."
            : "App hosting is not configured."
        }
        retry={refresh}
      />
    );
  if (result.value.url === null)
    return <ScreenStatus message="App domain setup needs attention." retry={refresh} />;
  if (!result.value.embedded)
    return <ScreenStatus message="Embedded app screens are not enabled on this host." />;
  return <AppFrame key={result.value.url} url={result.value.url} name={app.name} />;
}

function ScreenStatus({
  message,
  retry,
}: {
  readonly message: string;
  readonly retry?: (() => void) | undefined;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-5">
      <p role="status" className="text-sm text-muted-foreground">
        {message}
      </p>
      {retry && (
        <Button variant="outline" onClick={retry}>
          Check again
        </Button>
      )}
    </div>
  );
}

function AppSkeleton() {
  return (
    <div role="status" aria-label="Loading app" className="relative flex min-h-0 flex-1">
      <Skeleton className="absolute inset-0 size-full rounded-none motion-reduce:animate-none" />
    </div>
  );
}

/** A host-owned readiness message catches blocked frames and HTTP errors, which do not fire onError. */
function AppFrame({ url, name }: { readonly url: string; readonly name: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  useEffect(() => {
    const timer = window.setTimeout(() => setState("failed"), 30000);
    const ready = (event: MessageEvent) => {
      if (
        event.origin !== new URL(url).origin ||
        event.source !== frame.current?.contentWindow ||
        event.data?.type !== "executor:app-ready"
      )
        return;
      window.clearTimeout(timer);
      setState("ready");
    };
    window.addEventListener("message", ready);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", ready);
    };
  }, [url, attempt]);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {state === "loading" && (
        <div className="absolute inset-0 z-10 flex">
          <AppSkeleton />
        </div>
      )}
      {state === "failed" && (
        <div role="alert" className="flex items-center gap-3 border-b p-3 text-sm">
          <span>The app did not finish loading. Retry or open it in a new tab.</span>
          <Button
            variant="outline"
            onClick={() => {
              setState("loading");
              setAttempt((value) => value + 1);
            }}
          >
            Retry
          </Button>
        </div>
      )}
      <iframe
        key={attempt}
        ref={frame}
        src={url}
        title={`${name} app`}
        className="min-h-0 w-full flex-1 border-0"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
        allow="clipboard-write"
        referrerPolicy="no-referrer"
        onError={() => setState("failed")}
      />
    </div>
  );
}
