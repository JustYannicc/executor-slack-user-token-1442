import type * as t from "@babel/types";
import type { Label, Reference, StepKind, StepNode } from "../contracts/graph.ts";
import {
  deep,
  isFunction,
  keyName,
  line,
  memberName,
  resolve,
  unwrap,
  type FunctionNode,
  type Module,
} from "./source.ts";
import type { Context } from "./walker.ts";

/** What one `ctx.step` call says: its kind, name, options as written and what its code reaches. */

const STEP_METHODS: ReadonlyMap<string, StepKind> = new Map([
  ["do", "do"],
  ["runQuery", "query"],
  ["runMutation", "mutation"],
  ["sleep", "sleep"],
  ["sleepUntil", "sleepUntil"],
]);
const MAX_LABEL = 60;

export function stepKind(callee: t.MemberExpression): StepKind | undefined {
  const method = memberName(callee);
  return method === undefined ? undefined : STEP_METHODS.get(method);
}

export function describeStep(
  call: t.CallExpression,
  kind: StepKind,
  module: Module,
  context: Context,
): Omit<StepNode, "type" | "id"> {
  const [name, second, third] = call.arguments;
  const uses: Reference[] = [];
  const detail: Array<{ name: string; value: string }> = [];
  if (kind === "do") {
    const options = third && second && !isFunction(unwrap(second)) ? unwrap(second) : undefined;
    if (options) detail.push(...stepOptions(options, module));
    const fn = call.arguments.at(-1);
    if (fn) {
      const target = resolve({ module, node: fn }, context.modules);
      if (isFunction(target.node)) uses.push(...usesIn(target.node));
    }
  }
  if (kind === "query" || kind === "mutation") {
    if (second) {
      const op = resolve({ module, node: second }, context.modules);
      const path = context.tools.byNode.get(op.node);
      if (path !== undefined) {
        uses.push({ kind: "tool", path });
        for (const workflow of context.startsByTool.get(path) ?? [])
          uses.push({ kind: "workflow", name: workflow });
      }
    }
    const options = call.arguments[3];
    if (options) detail.push(...stepOptions(unwrap(options), module));
  }
  if (kind === "sleep" && second)
    detail.push({ name: "Duration", value: sourceValue(module, second) });
  if (kind === "sleepUntil" && second)
    detail.push({ name: "Until", value: sourceValue(module, second) });
  return {
    line: line(call),
    end: call.loc?.end.line ?? line(call),
    kind,
    label: name ? stepName(module, name) : { text: kind, dynamic: true },
    detail,
    uses: dedupe(uses),
  };
}

function stepOptions(options: t.Node, module: Module): Array<{ name: string; value: string }> {
  if (options.type !== "ObjectExpression") return [];
  const out: Array<{ name: string; value: string }> = [];
  for (const entry of options.properties) {
    if (entry.type !== "ObjectProperty") continue;
    const key = keyName(entry.key);
    const value = unwrap(entry.value);
    if (key === "timeout") out.push({ name: "Timeout", value: sourceValue(module, value) });
    if (key === "retries" && value.type === "ObjectExpression") {
      const field = (name: string) => {
        const found = value.properties.find(
          (item): item is t.ObjectProperty =>
            item.type === "ObjectProperty" && keyName(item.key) === name,
        );
        return found ? sourceValue(module, found.value) : undefined;
      };
      const limit = field("limit");
      const delay = field("delay");
      const backoff = field("backoff");
      out.push({
        name: "Retries",
        value: [limit, delay && `after ${delay}`, backoff].filter(Boolean).join(", "),
      });
    }
  }
  return out;
}

/** A step's name: literal text, a template's static parts, or the expression that computes it. */
function stepName(module: Module, node: t.Node): Label {
  const current = unwrap(node);
  if (current.type === "StringLiteral") return { text: current.value, dynamic: false };
  if (current.type === "TemplateLiteral") {
    const text = current.quasis
      .map(
        (quasi, index) =>
          (quasi.value.cooked ?? quasi.value.raw) + (index < current.expressions.length ? "…" : ""),
      )
      .join("");
    return { text, dynamic: current.expressions.length > 0 };
  }
  return { text: sourceText(module, current), dynamic: true };
}

function sourceValue(module: Module, node: t.Node): string {
  const current = unwrap(node);
  return current.type === "StringLiteral" ? current.value : sourceText(module, current);
}

/** The code of `node` on one line, shortened to fit a card. */
export function sourceText(module: Module, node: t.Node): string {
  const source =
    node.start != null && node.end != null ? module.source.slice(node.start, node.end) : "";
  const flat = source.replace(/\s+/gu, " ").trim();
  return flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL - 1)}…` : flat;
}

/** Accounts and hosts a step's own code reaches through its step context. */
function usesIn(fn: FunctionNode): Reference[] {
  const uses: Reference[] = [];
  deep(fn, (node) => {
    if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
      const owner = unwrap(node.object);
      if (owner.type === "MemberExpression" && memberName(owner) === "accounts") {
        const scopeOwner = unwrap(owner.object);
        const scope = scopeOwner.type === "MemberExpression" ? memberName(scopeOwner) : undefined;
        uses.push({
          kind: "account",
          slot: node.property.name,
          scope: scope === "user" || scope === "app" ? scope : undefined,
        });
      }
    }
    if (node.type === "CallExpression") {
      const callee = unwrap(node.callee);
      const isFetch =
        (callee.type === "Identifier" && callee.name === "fetch") ||
        (callee.type === "MemberExpression" && memberName(callee) === "fetch");
      const url = isFetch && node.arguments[0] ? urlPrefix(unwrap(node.arguments[0])) : undefined;
      const host = url && /^https?:\/\/([^/:?#]+)/u.exec(url)?.[1];
      if (host) uses.push({ kind: "host", host: host.toLowerCase() });
    }
  });
  return uses;
}

function urlPrefix(node: t.Node): string | undefined {
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "TemplateLiteral") return node.quasis[0]?.value.cooked ?? undefined;
  if (node.type === "BinaryExpression" && node.operator === "+")
    return urlPrefix(unwrap(node.left));
  return undefined;
}

function dedupe(uses: Reference[]): Reference[] {
  const seen = new Set<string>();
  return uses.filter((use) => {
    const key = JSON.stringify(use);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
