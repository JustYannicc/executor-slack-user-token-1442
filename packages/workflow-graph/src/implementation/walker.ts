import type * as t from "@babel/types";
import type { Arm, Label, WorkflowNode } from "../contracts/graph.ts";
import {
  children,
  isFunction,
  keyName,
  line,
  memberName,
  resolve,
  unwrap,
  type At,
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

/** Where the walk is: names that hold `ctx` or `ctx.step`, and what a `return` leaves. */
interface Scope {
  readonly module: Module;
  readonly contexts: Set<string>;
  readonly steps: Set<string>;
  readonly exit: "workflow" | "callback" | "helper";
  readonly inTry: boolean;
  readonly helpers: ReadonlyArray<t.Node>;
}

export class Walker {
  constructor(
    private readonly context: Context,
    private readonly id: () => string,
  ) {}

  /** Binds a function's parameters: an argument that is `ctx` or `ctx.step` names it there. */
  enter(
    module: Module,
    fn: FunctionNode,
    args: ReadonlyArray<"ctx" | "step" | undefined>,
    exit: Scope["exit"],
    helpers: ReadonlyArray<t.Node>,
  ): Scope | undefined {
    const scope: Scope = {
      module,
      contexts: new Set(),
      steps: new Set(),
      exit,
      inTry: false,
      helpers,
    };
    fn.params.forEach((param, index) => {
      const role = exit === "workflow" ? (index === 0 ? "ctx" : undefined) : args[index];
      if (role === undefined) return;
      if (param.type === "Identifier")
        (role === "ctx" ? scope.contexts : scope.steps).add(param.name);
      if (param.type === "ObjectPattern" && role === "ctx")
        for (const entry of param.properties)
          if (
            entry.type === "ObjectProperty" &&
            keyName(entry.key) === "step" &&
            entry.value.type === "Identifier"
          )
            scope.steps.add(entry.value.name);
    });
    return scope;
  }

  body(fn: FunctionNode, scope: Scope): WorkflowNode[] {
    if (fn.body.type === "BlockStatement") return this.statements(fn.body.body, scope);
    return this.expression(fn.body, scope);
  }

  statements(list: ReadonlyArray<t.Statement>, scope: Scope): WorkflowNode[] {
    const out: WorkflowNode[] = [];
    for (const statement of list) {
      out.push(...this.statement(statement, scope));
      // Code after a return or throw in the same block never runs.
      if (out.at(-1)?.type === "end") break;
    }
    return out;
  }

  statement(node: t.Statement, scope: Scope): WorkflowNode[] {
    switch (node.type) {
      case "ExpressionStatement":
        return this.expression(node.expression, scope);
      case "VariableDeclaration":
        return node.declarations.flatMap((declarator) => {
          if (!declarator.init) return [];
          this.alias(declarator, scope);
          return this.expression(declarator.init, scope);
        });
      case "ReturnStatement": {
        const nodes = node.argument ? this.expression(node.argument, scope) : [];
        if (scope.exit !== "workflow") return nodes;
        return [...nodes, { type: "end", id: this.id(), line: line(node), outcome: "done" }];
      }
      case "ThrowStatement": {
        const nodes = node.argument ? this.expression(node.argument, scope) : [];
        if (scope.inTry) return nodes;
        return [...nodes, { type: "end", id: this.id(), line: line(node), outcome: "fails" }];
      }
      case "BlockStatement":
        return this.statements(node.body, scope);
      case "LabeledStatement":
        return this.statement(node.body, scope);
      case "IfStatement":
        return this.ifStatement(node, scope);
      case "SwitchStatement":
        return this.switchStatement(node, scope);
      case "ForOfStatement":
      case "ForInStatement": {
        const left =
          node.left.type === "VariableDeclaration" ? node.left.declarations[0]?.id : node.left;
        const name = left ? this.text(left, scope) : "item";
        return this.loop(
          node,
          node.body,
          { text: `Each ${name}`, dynamic: false },
          `of ${this.text(node.right, scope)}`,
          scope,
        );
      }
      case "ForStatement":
        return this.loop(
          node,
          node.body,
          { text: "Repeat", dynamic: false },
          node.test ? `while ${this.text(node.test, scope)}` : undefined,
          scope,
        );
      case "WhileStatement":
      case "DoWhileStatement":
        return this.loop(
          node,
          node.body,
          { text: "Repeat", dynamic: false },
          `while ${this.text(node.test, scope)}`,
          scope,
        );
      case "TryStatement": {
        const body = this.statements(node.block.body, { ...scope, inTry: true });
        const failure = node.handler ? this.statements(node.handler.body.body, scope) : [];
        const after = node.finalizer ? this.statements(node.finalizer.body, scope) : [];
        if (body.length === 0 && failure.length === 0) return after;
        if (failure.length === 0 && !node.handler) return [...body, ...after];
        return [{ type: "try", id: this.id(), line: line(node), body, failure }, ...after];
      }
      default:
        return [];
    }
  }

  /** `const step = ctx.step` and `const { step } = ctx` add receivers. */
  private alias(declarator: t.VariableDeclarator, scope: Scope) {
    const init = declarator.init && unwrap(declarator.init);
    if (!init) return;
    if (declarator.id.type === "Identifier" && this.isStepReceiver(init, scope))
      scope.steps.add(declarator.id.name);
    if (
      declarator.id.type === "ObjectPattern" &&
      init.type === "Identifier" &&
      scope.contexts.has(init.name)
    )
      for (const entry of declarator.id.properties)
        if (
          entry.type === "ObjectProperty" &&
          keyName(entry.key) === "step" &&
          entry.value.type === "Identifier"
        )
          scope.steps.add(entry.value.name);
  }

  private ifStatement(node: t.IfStatement, scope: Scope): WorkflowNode[] {
    const yes = this.statement(node.consequent, scope);
    const no = node.alternate ? this.statement(node.alternate, scope) : [];
    if (yes.length === 0 && no.length === 0) return [];
    return [
      this.branch(node, this.label(node.test, scope), [
        { label: "Yes", body: yes },
        { label: "No", body: no },
      ]),
    ];
  }

  private switchStatement(node: t.SwitchStatement, scope: Scope): WorkflowNode[] {
    const arms: Arm[] = [];
    let pending: string[] = [];
    let hasDefault = false;
    for (const entry of node.cases) {
      const name = entry.test ? this.text(entry.test, scope) : "default";
      if (!entry.test) hasDefault = true;
      pending.push(name);
      if (entry.consequent.length === 0) continue;
      const body = this.statements(
        entry.consequent.filter((statement) => statement.type !== "BreakStatement"),
        scope,
      );
      arms.push({ label: pending.join(", "), body });
      pending = [];
    }
    if (!hasDefault) arms.push({ label: "default", body: [] });
    if (arms.every((arm) => arm.body.length === 0)) return [];
    return [this.branch(node, this.label(node.discriminant, scope), arms)];
  }

  private loop(
    node: t.Node,
    body: t.Statement,
    label: Label,
    detail: string | undefined,
    scope: Scope,
  ): WorkflowNode[] {
    const nodes = this.statement(body, scope);
    if (nodes.length === 0) return [];
    return [{ type: "loop", id: this.id(), line: line(node), label, detail, body: nodes }];
  }

  private branch(node: t.Node, label: Label, arms: Arm[]): WorkflowNode {
    return { type: "branch", id: this.id(), line: line(node), label, arms };
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
      const yes = this.expression(current.consequent, scope);
      const no = this.expression(current.alternate, scope);
      const test = this.expression(current.test, scope);
      if (yes.length === 0 && no.length === 0) return test;
      return [
        ...test,
        this.branch(current, this.label(current.test, scope), [
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
        this.branch(current, this.label(current.left, scope), [
          { label: "Yes", body: runsWhenTrue ? right : [] },
          { label: "No", body: runsWhenTrue ? [] : right },
        ]),
      ];
    }
    if (isFunction(current)) return [];
    return children(current).flatMap((child) => this.expression(child, scope));
  }

  private isStepReceiver(node: t.Node, scope: Scope): boolean {
    const current = unwrap(node);
    if (current.type === "Identifier") return scope.steps.has(current.name);
    if (current.type !== "MemberExpression" || memberName(current) !== "step") return false;
    const owner = unwrap(current.object);
    return owner.type === "Identifier" && scope.contexts.has(owner.name);
  }

  private step(call: t.CallExpression, scope: Scope): WorkflowNode[] | undefined {
    const callee = unwrap(call.callee);
    if (callee.type !== "MemberExpression") return undefined;
    const kind = stepKind(callee);
    if (!kind || !this.isStepReceiver(callee.object, scope)) return undefined;
    const before = call.arguments
      .slice(1)
      .flatMap((arg) => (isFunction(arg) ? [] : this.expression(arg, scope)));
    return [
      ...before,
      { type: "step", id: this.id(), ...describeStep(call, kind, scope.module, this.context) },
    ];
  }

  /** `Promise.all([a, b])` runs side by side; `Promise.all(items.map(fn))` runs `fn` per item. */
  private promiseAll(call: t.CallExpression, scope: Scope): WorkflowNode[] | undefined {
    const callee = unwrap(call.callee);
    if (callee.type !== "MemberExpression") return undefined;
    const owner = unwrap(callee.object);
    const method = memberName(callee);
    if (owner.type !== "Identifier" || owner.name !== "Promise") return undefined;
    if (method !== "all" && method !== "allSettled" && method !== "race" && method !== "any")
      return undefined;
    const arg = call.arguments[0] && unwrap(call.arguments[0]);
    if (!arg) return [];
    if (arg.type === "ArrayExpression") {
      const branches = arg.elements
        .flatMap((element) => (element ? [this.expression(element, scope)] : []))
        .filter((branch) => branch.length > 0);
      if (branches.length <= 1) return branches[0] ?? [];
      return [{ type: "parallel", id: this.id(), line: line(call), branches }];
    }
    if (arg.type === "CallExpression") {
      const mapCallee = unwrap(arg.callee);
      const fn = arg.arguments[0] && unwrap(arg.arguments[0]);
      if (
        mapCallee.type === "MemberExpression" &&
        memberName(mapCallee) === "map" &&
        fn &&
        isFunction(fn)
      ) {
        const inner: Scope = {
          ...scope,
          exit: "callback",
          contexts: new Set(scope.contexts),
          steps: new Set(scope.steps),
        };
        const body = this.body(fn, inner);
        if (body.length === 0) return this.expression(mapCallee.object, scope);
        const param = fn.params[0];
        const name = param ? this.text(param, scope) : "item";
        return [
          ...this.expression(mapCallee.object, scope),
          {
            type: "loop",
            id: this.id(),
            line: line(call),
            label: { text: `Each ${name}`, dynamic: false },
            detail: `of ${this.text(mapCallee.object, scope)}, at the same time`,
            body,
          },
        ];
      }
    }
    return undefined;
  }

  /** A call to a function in the app's own code that receives `ctx` or `ctx.step` is drawn inline. */
  private helper(call: t.CallExpression, scope: Scope): WorkflowNode[] | undefined {
    const roles = call.arguments.map((arg) => {
      const current = unwrap(arg);
      if (current.type === "Identifier" && scope.contexts.has(current.name)) return "ctx" as const;
      return this.isStepReceiver(current, scope) ? ("step" as const) : undefined;
    });
    if (!roles.some(Boolean)) return undefined;
    const target = resolve({ module: scope.module, node: call.callee }, this.context.modules);
    if (!isFunction(target.node) || scope.helpers.includes(target.node) || scope.helpers.length > 8)
      return undefined;
    const inner = this.enter(target.module, target.node, roles, "helper", [
      ...scope.helpers,
      target.node,
    ]);
    if (!inner) return undefined;
    const before = call.arguments.flatMap((arg) =>
      isFunction(arg) ? [] : this.expression(arg, scope),
    );
    return [...before, ...this.body(target.node, { ...inner, inTry: scope.inTry })];
  }

  /** A condition as written. */
  private label(node: t.Node, scope: Scope): Label {
    return { text: sourceText(scope.module, node), dynamic: false };
  }

  private text(node: t.Node, scope: Scope): string {
    return sourceText(scope.module, node);
  }
}
