import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Render long lists in slices. A sentinel after the last rendered row reveals the next slice
 * when it scrolls into view, so thousands of rows never mount at once. Changing `reset`
 * (for example a search query) returns to the first slice. A list that scrolls inside its own
 * container passes it as `root`, so the next slice loads as the container nears its end.
 */
export function useIncrementalList(
  total: number,
  reset: string,
  step = 100,
  root?: RefObject<Element | null>,
) {
  const [state, setState] = useState({ reset, count: step });
  const count = state.reset === reset ? state.count : step;
  if (state.reset !== reset) setState({ reset, count: step });
  const sentinel = useRef<HTMLDivElement>(null);
  const more = count < total;
  useEffect(() => {
    const element = sentinel.current;
    if (!more || element === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting))
          setState((previous) => ({ reset: previous.reset, count: previous.count + step }));
      },
      { root: root?.current ?? null, rootMargin: "400px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [more, count, step, root]);
  return {
    count: Math.min(count, total),
    sentinel: more ? <div ref={sentinel} aria-hidden className="h-px" /> : null,
  };
}
