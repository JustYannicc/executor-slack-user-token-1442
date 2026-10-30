import type { App } from "@executor-js/sdk";
import { roundedPath, type WorkflowLayout } from "@executor-js/workflow-graph/layout";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/button.tsx";
import { cn } from "../lib/utils.ts";
import { Box, Card } from "./workflow-diagram-cards.tsx";

/**
 * A laid-out workflow: boxes underneath, then the connecting lines and option labels, then the
 * cards. It fits the panel's width by default; the zoom controls step from there.
 */

const ZOOM_STEP = 0.15;

export function WorkflowCanvas({
  app,
  layout,
  input,
  selected,
  onSelect,
  onOpenWorkflow,
}: {
  readonly app: App;
  readonly layout: WorkflowLayout;
  readonly input: ReadonlyArray<string>;
  readonly selected: string;
  readonly onSelect: (id: string) => void;
  readonly onOpenWorkflow: (name: string, step: string) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<number>();
  const [zoom, setZoom] = useState<number>();
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setAvailable(entry?.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const fit = available === undefined ? 1 : Math.min(1, (available - 32) / layout.width);
  const scale = zoom ?? fit;
  return (
    <div className="relative min-w-0 bg-muted bg-[radial-gradient(circle_at_1px_1px,var(--border)_1px,transparent_0)] bg-size-[18px_18px]">
      <div ref={frame} className="max-h-[720px] overflow-auto px-4 py-7">
        <div
          className="mx-auto"
          style={{ width: layout.width * scale, height: layout.height * scale }}
        >
          <div
            className="relative origin-top-left"
            style={{ width: layout.width, height: layout.height, transform: `scale(${scale})` }}
          >
            {layout.boxes.map((box) => (
              <Box key={box.id} box={box} selected={selected === box.id} onSelect={onSelect} />
            ))}
            <Edges layout={layout} />
            {layout.labels.map((label, index) => (
              <span
                // Labels have no identity of their own; their order is fixed for one layout.
                key={index}
                className={cn(
                  "pointer-events-none absolute -translate-x-1/2 rounded-full border bg-background px-2 text-[11px] leading-[18px] whitespace-nowrap",
                  label.failure && "border-transparent bg-transparent font-medium text-destructive",
                )}
                style={{ left: label.x, top: label.y }}
              >
                {label.text}
              </span>
            ))}
            {layout.cards.map((card) => (
              <Card
                key={card.id}
                app={app}
                card={card}
                input={input}
                selected={selected === card.id}
                onSelect={onSelect}
                onOpenWorkflow={onOpenWorkflow}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="absolute bottom-3 left-3 flex overflow-hidden rounded-md border bg-background">
        <Button
          variant="ghost"
          size="xs"
          className="rounded-none"
          onClick={() => setZoom(undefined)}
        >
          Fit
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="rounded-none border-l"
          aria-label="Zoom out"
          onClick={() => setZoom(Math.max(0.3, scale - ZOOM_STEP))}
        >
          −
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          className="rounded-none border-l"
          aria-label="Zoom in"
          onClick={() => setZoom(Math.min(1.5, scale + ZOOM_STEP))}
        >
          +
        </Button>
      </div>
    </div>
  );
}

function Edges({ layout }: { readonly layout: WorkflowLayout }) {
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-visible"
      width={layout.width}
      height={layout.height}
    >
      <defs>
        <marker
          id="workflow-arrow"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0 .5L7.5 4 0 7.5z" className="fill-muted-foreground/60" />
        </marker>
        <marker
          id="workflow-arrow-failure"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0 .5L7.5 4 0 7.5z" className="fill-destructive/70" />
        </marker>
      </defs>
      {layout.edges.map((edge, index) => (
        <path
          // An edge is identified by its ends and option; two can share both, so order breaks ties.
          key={`${edge.from}:${edge.to}:${edge.arm?.index}:${index}`}
          d={roundedPath(edge.points, 8)}
          fill="none"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeDasharray={edge.failure ? "4 4" : undefined}
          className={edge.failure ? "stroke-destructive/70" : "stroke-muted-foreground/50"}
          markerEnd={
            edge.to === null
              ? undefined
              : edge.failure
                ? "url(#workflow-arrow-failure)"
                : "url(#workflow-arrow)"
          }
        />
      ))}
    </svg>
  );
}
