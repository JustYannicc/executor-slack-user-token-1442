import type * as t from "@babel/types";
import type { Arm, EndNode, Label, WorkflowNode } from "../contracts/graph.ts";
import {
  children,
  declareIn,
  isFunction,
  keyName,
  line,
  memberName,
  patternNames,
  resolve,
  unwrap,
  type At,
  type Environment,
  type FunctionNode,
  type Module,
} from "./source.ts";
import { describeStep, sourceText, stepKind } from "./steps.ts";

export interface Tools {
  /** Tool path by the operation's defining expression, to name `runQuery(…, op)` targets. */
  readonly byNode: Map<t.Node, string>;
  readonly handlers: Map<string, At>;
}

export interface Context {
  readonly modules: Map<string, Module>;
  readonly tools: Tools;
  readonly startsByTool: Map<string, Set<string>>;
}

/**
 * Where the walk is. `env` holds the bindings in scope, and `contexts` and `steps` the names that
 * hold `ctx` and `ctx.step`; each block gets its own copies, so a block's names end with it.
 */
interface Scope {
  readonly module: Module;
  readonly env: Map<string, t.Node | null>;
  readonly contexts: Set<string>;
  readonly steps: Set<string>;
  /** What a `return` leaves: the run, a callback such as one item's pass, or an inlined helper. */
  readonly exit: "workflow" | "callback" | "helper";
  /** A `throw` here lands in a `catch`. */
  readonly catches: boolean;
  /** What an unlabelled `break` leaves. */
  readonly breaks: "loop" | "switch" | undefined;
  readonly inLoop: boolean;
  readonly helpers: ReadonlyArray<t.Node>;
}

/** A block's nodes, and whether every path through it stops instead of reaching what follows. */
export interface Block {
  readonly nodes: WorkflowNode[];
  readonly ends: boolean;
}

/** Inlined helpers stop once a workflow has this many nodes; the graph is then marked partial. */
const MAX_NODES = 600;

export class Walker {
  private count = 0;
  /** Set when a helper was left out for the budget. */
  partial = false;

  constructor(private readonly context: Context) {}

  private id() {
    this.count += 1;
    return `n${this.count}`;
  }

  /**
   * A function's scope. `roles` names the parameters that receive `ctx` or `ctx.step`; for the
   * workflow handler that is its first. Every other parameter shadows outer names with an unknown.
   */
  enter(
    module: Module,
    fn: FunctionNode,
    roles: ReadonlyArray<"ctx" | "step" | undefined>,
    exit: Scope["exit"],
    helpers: ReadonlyArray<t.Node>,
    outer?: Environment,
  ): Scope {
    const scope: Scope = {
      module,
      env: new Map<string, t.Node | null>(outer ?? []),
      contexts: new Set(),
      steps: new Set(),
      exit,
      catches: false,
      breaks: undefined,
      inLoop: false,
      helpers,
    };
    fn.params.forEach((param, index) => {
      for (const name of patternNames(param)) scope.env.set(name, null);
      const role = exit === "workflow" ? (index === 0 ? "ctx" : undefined) : roles[index];
      if (param.type === "Identifier" && role)
        (role === "ctx" ? scope.contexts : scope.steps).add(param.name);
      if (param.type === "ObjectPattern" && role === "ctx") this.stepsFrom(param, scope);
    });
    return scope;
  }

  body(fn: FunctionNode, scope: Scope): Block {
    if (fn.body.type === "BlockStatement") return this.statements(fn.body.body, scope);
    return this.flow(this.expression(fn.body, scope));
  }

  private child(scope: Scope, changes: Partial<Scope> = {}): Scope {
    return {
      ...scope,
      env: new Map<string, t.Node | null>(scope.env),
      contexts: new Set(scope.contexts),
      steps: new Set(scope.steps),
      ...changes,
    };
  }

  /** A run of statements in their own block scope; it stops at the first one no path gets past. */
  statements(list: ReadonlyArray<t.Statement>, outer: Scope): Block {
    const scope = this.child(outer);
    for (const statement of list)
      if (statement.type === "FunctionDeclaration" && statement.id)
        scope.env.set(statement.id.name, statement);
    const nodes: WorkflowNode[] = [];
    for (const statement of list) {
      const block = this.statement(statement, scope);
      nodes.push(...block.nodes);
      if (block.ends) return { nodes, ends: true };
    }
    return { nodes, ends: false };
  }

  /** Nodes from an expression: a path through them stops when the last is an end. */
  private flow(nodes: WorkflowNode[]): Block {
    return { nodes, ends: nodes.at(-1)?.type === "end" };
  }

  statement(node: t.Statement, scope: Scope): Block {
    switch (node.type) {
      case "ExpressionStatement":
        return this.flow(this.expression(node.expression, scope));
      case "VariableDeclaration": {
        const nodes = node.declarations.flatMap((declarator) =>
          declarator.init ? this.expression(declarator.init, scope) : [],
        );
        for (const declarator of node.declarations) this.alias(declarator, scope);
        declareIn(scope.env, node);
        return this.flow(nodes);
      }
      case "ReturnStatement": {
        const nodes = node.argument ? this.expression(node.argument, scope) : [];
        if (scope.exit === "workflow") nodes.push(this.end(node, scope, "done"));
        return { nodes, ends: true };
      }
      case "ThrowStatement": {
        const nodes = node.argument ? this.expression(node.argument, scope) : [];
        if (!scope.catches) nodes.push(this.end(node, scope, "fails"));
        return { nodes, ends: true };
      }
      case "BreakStatement":
        return {
          nodes: scope.breaks === "loop" || node.label ? [this.end(node, scope, "exit")] : [],
          ends: true,
        };
      case "ContinueStatement":
        return { nodes: scope.inLoop ? [this.end(node, scope, "next")] : [], ends: true };
      case "BlockStatement":
        return this.statements(node.body, scope);
      case "LabeledStatement":
        return this.statement(node.body, scope);
      case "IfStatement":
        return this.ifStatement(node, scope);
      case "SwitchStatement":
        return this.switchStatement(node, scope);
      case "ForOfStatement":
      case "ForInStatement":
        return this.eachLoop(node, scope);
      case "ForStatement":
        return this.forLoop(node, scope);
      case "WhileStatement":
      case "DoWhileStatement":
        return this.whileLoop(node, scope);
      case "TryStatement":
        return this.tryStatement(node, scope);
      default:
        return { nodes: [], ends: false };
    }
  }

  private end(node: t.Node, scope: Scope, outcome: EndNode["outcome"]): EndNode {
    return { type: "end", id: this.id(), file: scope.module.path, line: line(node), outcome };
  }

  /** `const step = ctx.step` and `const { step } = ctx` add receivers; any other value removes them. */
  private alias(declarator: t.VariableDeclarator, scope: Scope) {
    const init = declarator.init && unwrap(declarator.init);
    for (const name of patternNames(declarator.id)) {
      scope.steps.delete(name);
      scope.contexts.delete(name);
    }
    if (!init) return;
    if (declarator.id.type === "Identifier" && this.isStepReceiver(init, scope))
      scope.steps.add(declarator.id.name);
    if (declarator.id.type === "Identifier" && this.isContext(init, scope))
      scope.contexts.add(declarator.id.name);
    if (declarator.id.type === "ObjectPattern" && this.isContext(init, scope))
      this.stepsFrom(declarator.id, scope);
  }

  private stepsFrom(pattern: t.ObjectPattern, scope: Scope) {
    for (const entry of pattern.properties)
      if (
        entry.type === "ObjectProperty" &&
        !entry.computed &&
        keyName(entry.key) === "step" &&
        entry.value.type === "Identifier"
      )
        scope.steps.add(entry.value.name);
  }

  private ifStatement(node: t.IfStatement, scope: Scope): Block {
    const test = this.expression(node.test, scope);
    const yes = this.statement(node.consequent, this.child(scope));
    const no = node.alternate
      ? this.statement(node.alternate, this.child(scope))
      : { nodes: [], ends: false };
    const ends = yes.ends && no.ends;
    if (yes.nodes.length === 0 && no.nodes.length === 0) return { nodes: test, ends };
    return {
      nodes: [
        ...test,
        this.branch(node, scope, this.label(node.test, scope), [
          { label: "Yes", body: yes.nodes },
          { label: "No", body: no.nodes },
        ]),
      ],
      ends,
    };
  }

  /** Each option runs its case and falls through the following ones until a `break` or an end. */
  private switchStatement(node: t.SwitchStatement, scope: Scope): Block {
    const test = this.expression(node.discriminant, scope);
    const arms: Arm[] = [];
    const ends: boolean[] = [];
    let names: string[] = [];
    let hasDefault = false;
    node.cases.forEach((entry, index) => {
      names.push(entry.test ? this.text(entry.test, scope) : "default");
      if (!entry.test) hasDefault = true;
      if (entry.consequent.length === 0 && index < node.cases.length - 1) return;
      const path: t.Statement[] = [];
      collect: for (const later of node.cases.slice(index))
        for (const statement of later.consequent) {
          if (statement.type === "BreakStatement" && !statement.label) break collect;
          path.push(statement);
        }
      const block = this.statements(path, this.child(scope, { breaks: "switch" }));
      arms.push({ label: names.join(", "), body: block.nodes });
      ends.push(block.ends);
      names = [];
    });
    if (!hasDefault) {
      arms.push({ label: "default", body: [] });
      ends.push(false);
    }
    const stops = ends.every(Boolean);
    if (arms.every((arm) => arm.body.length === 0)) return { nodes: test, ends: stops };
    return {
      nodes: [...test, this.branch(node, scope, this.label(node.discriminant, scope), arms)],
      ends: stops,
    };
  }

  private loopScope(scope: Scope): Scope {
    return this.child(scope, { breaks: "loop", inLoop: true });
  }

  private eachLoop(node: t.ForOfStatement | t.ForInStatement, scope: Scope): Block {
    const before = this.expression(node.right, scope);
    const inner = this.loopScope(scope);
    const left =
      node.left.type === "VariableDeclaration" ? node.left.declarations[0]?.id : node.left;
    if (left) for (const name of patternNames(left)) inner.env.set(name, null);
    const body = this.statement(node.body, inner);
    const name = left ? this.text(left, scope) : "item";
    return this.loop(
      node,
      scope,
      before,
      body.nodes,
      `Each ${name}`,
      `of ${this.text(node.right, scope)}`,
    );
  }

  private forLoop(node: t.ForStatement, scope: Scope): Block {
    const inner = this.loopScope(scope);
    const init = !node.init
      ? []
      : node.init.type === "VariableDeclaration"
        ? this.statement(node.init, inner).nodes
        : this.expression(node.init, inner);
    const test = node.test ? this.expression(node.test, inner) : [];
    const body = this.statement(node.body, inner);
    const update = node.update && !body.ends ? this.expression(node.update, inner) : [];
    return this.loop(
      node,
      scope,
      init,
      [...test, ...body.nodes, ...update],
      "Repeat",
      node.test ? `while ${this.text(node.test, scope)}` : undefined,
    );
  }

  private whileLoop(node: t.WhileStatement | t.DoWhileStatement, scope: Scope): Block {
    const inner = this.loopScope(scope);
    const test = this.expression(node.test, inner);
    const body = this.statement(node.body, inner);
    const pass =
      node.type === "WhileStatement"
        ? [...test, ...body.nodes]
        : [...body.nodes, ...(body.ends ? [] : test)];
    return this.loop(node, scope, [], pass, "Repeat", `while ${this.text(node.test, scope)}`);
  }

  /** A loop may run no passes, so what follows it is always reachable. */
  private loop(
    node: t.Node,
    scope: Scope,
    before: WorkflowNode[],
    body: WorkflowNode[],
    label: string,
    detail: string | undefined,
  ): Block {
    if (body.length === 0) return { nodes: before, ends: false };
    return {
      nodes: [
        ...before,
        {
          type: "loop",
          id: this.id(),
          file: scope.module.path,
          line: line(node),
          label: { text: label, dynamic: false },
          detail,
          body,
        },
      ],
      ends: false,
    };
  }

  /**
   * A `finally` runs before a pending `return` or `throw` takes effect, so that end is drawn after
   * the cleanup. A `throw` in the body only ends the run when no `catch` takes it.
   */
  private tryStatement(node: t.TryStatement, scope: Scope): Block {
    const handler = node.handler;
    const body = this.statements(
      node.block.body,
      this.child(scope, { catches: scope.catches || !!handler }),
    );
    let failure: Block = { nodes: [], ends: false };
    if (handler) {
      const inner = this.child(scope);
      if (handler.param) for (const name of patternNames(handler.param)) inner.env.set(name, null);
      failure = this.statements(handler.body.body, inner);
    }
    const cleanup = node.finalizer
      ? this.statements(node.finalizer.body, scope)
      : { nodes: [], ends: false };
    const stops = body.ends && (!handler || failure.ends);
    let bodyNodes = body.nodes;
    let failureNodes = failure.nodes;
    let pending: WorkflowNode | undefined;
    if (cleanup.nodes.length > 0 && stops) {
      const bodyEnd = bodyNodes.at(-1)?.type === "end" ? bodyNodes.at(-1) : undefined;
      const failureEnd = failureNodes.at(-1)?.type === "end" ? failureNodes.at(-1) : undefined;
      if (bodyEnd) bodyNodes = bodyNodes.slice(0, -1);
      if (failureEnd) failureNodes = failureNodes.slice(0, -1);
      pending = handler ? (failureEnd ?? bodyEnd) : bodyEnd;
    }
    const core: WorkflowNode[] =
      bodyNodes.length === 0 && failureNodes.length === 0
        ? []
        : !handler
          ? bodyNodes
          : [
              {
                type: "try",
                id: this.id(),
                file: scope.module.path,
                line: line(node),
                body: bodyNodes,
                failure: failureNodes,
              },
            ];
    return {
      nodes: [...core, ...cleanup.nodes, ...(pending && !cleanup.ends ? [pending] : [])],
      ends: cleanup.ends || stops,
    };
  }

  private branch(node: t.Node, scope: Scope, label: Label, arms: Arm[]): WorkflowNode {
    return {
      type: "branch",
      id: this.id(),
      file: scope.module.path,
      line: line(node),
      label,
      arms,
    };
  }

  /** Steps inside an expression, in evaluation order. Functions are not entered unless called. */
  expression(node: t.Node, scope: Scope): WorkflowNode[] {
    const current = unwrap(node);
    if (current.type === "AwaitExpression") return this.expression(current.argument, scope);
    if (current.type === "CallExpression") {
      const step = this.step(current, scope);
      if (step) return step;
      const all = this.promiseAll(current, scope);
      if (all) return all;
      const inlined = this.helper(current, scope);
      if (inlined) return inlined;
    }
    if (current.type === "ConditionalExpression") {
      const test = this.expression(current.test, scope);
      const yes = this.expression(current.consequent, scope);
      const no = this.expression(current.alternate, scope);
      if (yes.length === 0 && no.length === 0) return test;
      return [
        ...test,
        this.branch(current, scope, this.label(current.test, scope), [
          { label: "Yes", body: yes },
          { label: "No", body: no },
        ]),
      ];
    }
    if (current.type === "LogicalExpression") {
      const left = this.expression(current.left, scope);
      const right = this.expression(current.right, scope);
      if (right.length === 0) return left;
      const runsWhenTrue = current.operator === "&&";
      return [
        ...left,
        this.branch(current, scope, this.label(current.left, scope), [
          { label: "Yes", body: runsWhenTrue ? right : [] },
          { label: "No", body: runsWhenTrue ? [] : right },
        ]),
      ];
    }
    if (isFunction(current)) return [];
    return children(current).flatMap((child) => this.expression(child, scope));
  }

  private isContext(node: t.Node, scope: Scope): boolean {
    const current = unwrap(node);
    return current.type === "Identifier" && scope.contexts.has(current.name);
  }

  private isStepReceiver(node: t.Node, scope: Scope): boolean {
    const current = unwrap(node);
    if (current.type === "Identifier") return scope.steps.has(current.name);
    if (current.type !== "MemberExpression" || memberName(current) !== "step") return false;
    return this.isContext(current.object, scope);
  }

  private step(call: t.CallExpression, scope: Scope): WorkflowNode[] | undefined {
    const callee = unwrap(call.callee);
    if (callee.type !== "MemberExpression") return undefined;
    const kind = stepKind(callee);
    if (!kind || !this.isStepReceiver(callee.object, scope)) return undefined;
    const before = call.arguments
      .slice(1)
      .flatMap((arg) => (isFunction(arg) ? [] : this.expression(arg, scope)));
    const described = describeStep(
      call,
      kind,
      { module: scope.module, env: scope.env },
      this.context,
    );
    return [...before, { type: "step", id: this.id(), ...described }];
  }

  /** `Promise.all([a, b])` runs side by side; `Promise.all(items.map(fn))` runs `fn` per item. */
  private promiseAll(call: t.CallExpression, scope: Scope): WorkflowNode[] | undefined {
    const callee = unwrap(call.callee);
    if (callee.type !== "MemberExpression") return undefined;
    const owner = unwrap(callee.object);
    const method = memberName(callee);
    if (owner.type !== "Identifier" || owner.name !== "Promise" || scope.env.has("Promise"))
      return undefined;
    if (method !== "all" && method !== "allSettled" && method !== "race" && method !== "any")
      return undefined;
    const arg = call.arguments[0] && unwrap(call.arguments[0]);
    if (!arg) return [];
    if (arg.type === "ArrayExpression") {
      const branches = arg.elements
        .flatMap((element) => (element ? [this.expression(element, scope)] : []))
        .filter((branch) => branch.length > 0);
      if (branches.length <= 1) return branches[0] ?? [];
      return [
        { type: "parallel", id: this.id(), file: scope.module.path, line: line(call), branches },
      ];
    }
    if (arg.type !== "CallExpression") return undefined;
    const mapCallee = unwrap(arg.callee);
    const fn = arg.arguments[0] && unwrap(arg.arguments[0]);
    if (
      mapCallee.type !== "MemberExpression" ||
      memberName(mapCallee) !== "map" ||
      !fn ||
      !isFunction(fn)
    )
      return undefined;
    const items = this.expression(mapCallee.object, scope);
    const inner = this.enter(scope.module, fn, [], "callback", scope.helpers, scope.env);
    // The callback keeps the receivers in scope, except names its own parameters shadow.
    const shadowed = new Set(fn.params.flatMap(patternNames));
    for (const name of scope.contexts) if (!shadowed.has(name)) inner.contexts.add(name);
    for (const name of scope.steps) if (!shadowed.has(name)) inner.steps.add(name);
    // `allSettled` collects a pass's failure instead of failing the run.
    const catches = scope.catches || method === "allSettled";
    const body = this.body(fn, { ...inner, catches }).nodes;
    if (body.length === 0) return items;
    const param = fn.params[0];
    return [
      ...items,
      {
        type: "loop",
        id: this.id(),
        file: scope.module.path,
        line: line(call),
        label: { text: `Each ${param ? this.text(param, scope) : "item"}`, dynamic: false },
        detail: `of ${this.text(mapCallee.object, scope)}, at the same time`,
        body,
      },
    ];
  }

  /** A call to a function in the app's own code that receives `ctx` or `ctx.step` is drawn inline. */
  private helper(call: t.CallExpression, scope: Scope): WorkflowNode[] | undefined {
    const roles = call.arguments.map((arg) =>
      this.isContext(arg, scope)
        ? ("ctx" as const)
        : this.isStepReceiver(arg, scope)
          ? ("step" as const)
          : undefined,
    );
    if (!roles.some(Boolean)) return undefined;
    const target = resolve(
      { module: scope.module, node: call.callee, env: scope.env },
      this.context.modules,
    );
    if (!isFunction(target.node) || scope.helpers.includes(target.node)) return undefined;
    if (this.count >= MAX_NODES) {
      this.partial = true;
      return undefined;
    }
    const before = call.arguments.flatMap((arg) =>
      isFunction(arg) ? [] : this.expression(arg, scope),
    );
    const inner = this.enter(
      target.module,
      target.node,
      roles,
      "helper",
      [...scope.helpers, target.node],
      target.env,
    );
    // A helper's own `return` ends only the helper; its uncaught `throw` still ends the run.
    return [...before, ...this.body(target.node, { ...inner, catches: scope.catches }).nodes];
  }

  /** A condition as written. */
  private label(node: t.Node, scope: Scope): Label {
    return { text: sourceText(scope.module, node), dynamic: false };
  }

  private text(node: t.Node, scope: Scope): string {
    return sourceText(scope.module, node);
  }
}
