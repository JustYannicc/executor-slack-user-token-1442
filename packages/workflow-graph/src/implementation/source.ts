import { parse } from "@babel/parser";
import type * as t from "@babel/types";

/**
 * Parsed app source files and the static name resolution the derivation reads them with. A name
 * resolves only when the code says what it is; anything that could be something else at runtime,
 * such as a reassigned binding or a property a spread may override, stays unknown.
 */

/** A source file as stored. Files kept by Git object ID instead of inlined have no `content`. */
export interface SourceFile {
  readonly path: string;
  readonly content?: string;
}

export interface Module {
  readonly path: string;
  readonly source: string;
  readonly program: t.Program;
  /** Top-level bindings: a declared function, or the initializer of a `const`; `null` when unknown. */
  readonly locals: Map<string, t.Node | null>;
  /** `name` is the imported export, `"default"`, or `"*"` for a namespace. */
  readonly imports: Map<string, { readonly from: string; readonly name: string }>;
  readonly exports: Map<string, string>;
  /** Modules this one re-exports everything from, as `export * from`. */
  readonly stars: ReadonlyArray<string>;
  readonly defaultExport: t.Node | undefined;
}

/**
 * Bindings in scope where a node is read, innermost last: a node, or `null` for a binding whose
 * value isn't known statically, such as a parameter or a `let`. They shadow module bindings.
 */
export type Environment = ReadonlyMap<string, t.Node | null>;

/** A node together with where it was written, so its identifiers resolve there. */
export interface At<N extends t.Node = t.Node> {
  readonly module: Module;
  readonly node: N;
  readonly env?: Environment | undefined;
}

export const CODE = /\.(?:[cm]?[jt]sx?)$/u;
export const NOT_SERVER = /^(?:ui|skills|migrations|node_modules)\//u;

const SKIPPED_KEYS = new Set([
  "loc",
  "start",
  "end",
  "extra",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "typeAnnotation",
  "typeParameters",
  "typeArguments",
  "returnType",
]);
const MAX_RESOLVE_DEPTH = 40;

export function readModule(file: {
  readonly path: string;
  readonly content: string;
}): Module | undefined {
  let program: t.Program;
  try {
    program = parse(file.content, {
      sourceType: "module",
      plugins: file.path.endsWith("x") ? ["typescript", "jsx"] : ["typescript"],
      errorRecovery: true,
    }).program;
  } catch {
    return undefined;
  }
  const locals = new Map<string, t.Node | null>();
  const imports = new Map<string, { readonly from: string; readonly name: string }>();
  const exports = new Map<string, string>();
  const stars: string[] = [];
  let defaultExport: t.Node | undefined;
  for (const statement of program.body) {
    declareIn(locals, statement);
    if (statement.type === "ImportDeclaration") {
      if (statement.importKind === "type") continue;
      const from = resolvePath(file.path, statement.source.value);
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportSpecifier")
          imports.set(specifier.local.name, { from, name: exportName(specifier.imported) });
        if (specifier.type === "ImportDefaultSpecifier")
          imports.set(specifier.local.name, { from, name: "default" });
        if (specifier.type === "ImportNamespaceSpecifier")
          imports.set(specifier.local.name, { from, name: "*" });
      }
    }
    if (statement.type === "ExportNamedDeclaration") {
      if (statement.declaration) {
        declareIn(locals, statement.declaration);
        for (const name of declaredNames(statement.declaration)) exports.set(name, name);
      }
      const from = statement.source ? resolvePath(file.path, statement.source.value) : undefined;
      for (const specifier of statement.specifiers) {
        const exported = exportName(specifier.exported);
        if (from === undefined) {
          if (specifier.type === "ExportSpecifier") exports.set(exported, specifier.local.name);
          continue;
        }
        // A re-export is an import under a name no code can write.
        const local = `\0${exported}`;
        imports.set(local, {
          from,
          name:
            specifier.type === "ExportNamespaceSpecifier"
              ? "*"
              : specifier.type === "ExportDefaultSpecifier"
                ? "default"
                : exportName(specifier.local),
        });
        exports.set(exported, local);
      }
    }
    if (statement.type === "ExportAllDeclaration" && statement.exportKind !== "type")
      stars.push(resolvePath(file.path, statement.source.value));
    if (statement.type === "ExportDefaultDeclaration") defaultExport = statement.declaration;
  }
  return {
    path: file.path,
    source: file.content,
    program,
    locals,
    imports,
    exports,
    stars,
    defaultExport,
  };
}

function exportName(node: t.Identifier | t.StringLiteral): string {
  return node.type === "Identifier" ? node.name : node.value;
}

/** Records what a declaration binds: functions and `const`s by value, everything else as unknown. */
export function declareIn(env: Map<string, t.Node | null>, statement: t.Node) {
  if (statement.type === "FunctionDeclaration" && statement.id)
    env.set(statement.id.name, statement);
  if (statement.type === "ClassDeclaration" && statement.id) env.set(statement.id.name, null);
  if (statement.type !== "VariableDeclaration") return;
  for (const declarator of statement.declarations) {
    if (declarator.id.type === "Identifier")
      env.set(
        declarator.id.name,
        statement.kind === "const" && declarator.init ? declarator.init : null,
      );
    else for (const name of patternNames(declarator.id)) env.set(name, null);
  }
}

/** The names a destructuring pattern or parameter binds. */
export function patternNames(pattern: t.Node): string[] {
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return pattern.properties.flatMap((entry) =>
        entry.type === "RestElement" ? patternNames(entry.argument) : patternNames(entry.value),
      );
    case "ArrayPattern":
      return pattern.elements.flatMap((element) => (element ? patternNames(element) : []));
    case "AssignmentPattern":
      return patternNames(pattern.left);
    case "RestElement":
      return patternNames(pattern.argument);
    case "TSParameterProperty":
      return patternNames(pattern.parameter);
    default:
      return [];
  }
}

function declaredNames(declaration: t.Node): string[] {
  if (declaration.type === "FunctionDeclaration" && declaration.id) return [declaration.id.name];
  if (declaration.type === "VariableDeclaration")
    return declaration.declarations.flatMap((d) => patternNames(d.id));
  return [];
}

/** Import specifiers are resolved against the source paths; packages are outside the app. */
function resolvePath(from: string, specifier: string): string {
  if (!specifier.startsWith(".")) return `\0${specifier}`;
  const parts = from.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

export function moduleAt(modules: Map<string, Module>, path: string): Module | undefined {
  const bare = path.replace(CODE, "");
  for (const candidate of [path, `${bare}.ts`, `${bare}.tsx`, `${bare}.js`, `${bare}/index.ts`]) {
    const module = modules.get(candidate);
    if (module) return module;
  }
  return undefined;
}

export function unwrap(node: t.Node): t.Node {
  let current = node;
  while (
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "ParenthesizedExpression" ||
    current.type === "TSTypeAssertion"
  )
    current = current.expression;
  return current;
}

/**
 * Follows identifiers, namespace members and re-exports to the expression they name. Cycles and
 * unknown bindings stop at the identifier itself, which callers treat as unknown.
 */
export function resolve(at: At, modules: Map<string, Module>): At {
  return resolveWith(at, modules, new Set(), 0);
}

function resolveWith(at: At, modules: Map<string, Module>, seen: Set<string>, depth: number): At {
  const node = unwrap(at.node);
  const here: At = { module: at.module, node, env: at.env };
  if (depth > MAX_RESOLVE_DEPTH) return here;
  if (node.type === "Identifier") {
    if (at.env?.has(node.name)) {
      const bound = at.env.get(node.name);
      const key = `${at.module.path}:${node.start ?? -1}:${node.name}`;
      if (!bound || seen.has(key)) return here;
      seen.add(key);
      return resolveWith({ module: at.module, node: bound, env: at.env }, modules, seen, depth + 1);
    }
    return resolveName(at.module, node.name, modules, seen, depth + 1) ?? here;
  }
  if (node.type === "MemberExpression") {
    const name = memberName(node);
    if (name === undefined) return here;
    const owner = resolveWith({ ...at, node: node.object }, modules, seen, depth + 1);
    // A namespace import resolves to its module's program.
    if (owner.node.type === "Program")
      return resolveExport(owner.module, name, modules, seen, depth + 1) ?? here;
    if (owner.node.type === "ObjectExpression")
      return propertyWith(owner, name, modules, seen, depth + 1) ?? here;
  }
  return here;
}

function resolveName(
  module: Module,
  name: string,
  modules: Map<string, Module>,
  seen: Set<string>,
  depth: number,
): At | undefined {
  const key = `${module.path}#${name}`;
  if (seen.has(key) || depth > MAX_RESOLVE_DEPTH) return undefined;
  seen.add(key);
  if (module.locals.has(name)) {
    const local = module.locals.get(name);
    return local ? resolveWith({ module, node: local }, modules, seen, depth + 1) : undefined;
  }
  const imported = module.imports.get(name);
  const target = imported && moduleAt(modules, imported.from);
  if (!imported || !target) return undefined;
  if (imported.name === "*") return { module: target, node: target.program };
  if (imported.name === "default")
    return target.defaultExport
      ? resolveWith({ module: target, node: target.defaultExport }, modules, seen, depth + 1)
      : undefined;
  return resolveExport(target, imported.name, modules, seen, depth + 1);
}

/** An export of `module` by name: its own, or exactly one module's it re-exports everything from. */
function resolveExport(
  module: Module,
  name: string,
  modules: Map<string, Module>,
  seen: Set<string>,
  depth: number,
): At | undefined {
  const local = module.exports.get(name);
  if (local !== undefined) return resolveName(module, local, modules, seen, depth + 1);
  if (name === "default") return undefined;
  const found: At[] = [];
  for (const path of module.stars) {
    const target = moduleAt(modules, path);
    const key = `${path}*${name}`;
    if (!target || seen.has(key)) continue;
    seen.add(key);
    const at = resolveExport(target, name, modules, seen, depth + 1);
    if (at) found.push(at);
  }
  // Two star exports of one name are ambiguous, and the module doesn't export it.
  return found.length === 1 ? found[0] : undefined;
}

export function calleeName(node: t.Node): string | undefined {
  if (node.type !== "CallExpression") return undefined;
  const callee = unwrap(node.callee);
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && callee.property.type === "Identifier")
    return callee.property.name;
  return undefined;
}

/** An object's property as its last definition sets it; unknown when a spread or computed key may. */
export function property(at: At | undefined, name: string, modules: Map<string, Module>) {
  if (!at) return undefined;
  return propertyWith(at, name, modules, new Set(), 0);
}

const UNKNOWN = Symbol("unknown");

function propertyWith(
  at: At,
  name: string,
  modules: Map<string, Module>,
  seen: Set<string>,
  depth: number,
): At | undefined {
  const value = ownProperty(at, name, modules, seen, depth);
  return value === UNKNOWN ? undefined : value;
}

function ownProperty(
  at: At,
  name: string,
  modules: Map<string, Module>,
  seen: Set<string>,
  depth: number,
): At | undefined | typeof UNKNOWN {
  if (at.node.type !== "ObjectExpression" || depth > MAX_RESOLVE_DEPTH) return undefined;
  let found: At | undefined | typeof UNKNOWN;
  for (const entry of at.node.properties) {
    if (entry.type === "SpreadElement") {
      const spread = resolveWith({ ...at, node: entry.argument }, modules, seen, depth + 1);
      const inner =
        spread.node.type === "ObjectExpression"
          ? ownProperty(spread, name, modules, seen, depth + 1)
          : UNKNOWN;
      if (inner !== undefined) found = inner;
      continue;
    }
    const key = entryKey(entry, at, modules);
    if (key === UNKNOWN) found = UNKNOWN;
    else if (key === name)
      found =
        entry.type === "ObjectMethod"
          ? { module: at.module, node: entry, env: at.env }
          : resolveWith({ ...at, node: entry.value }, modules, seen, depth + 1);
  }
  return found;
}

function entryKey(
  entry: t.ObjectProperty | t.ObjectMethod,
  at: At,
  modules: Map<string, Module>,
): string | typeof UNKNOWN {
  if (!entry.computed) return keyName(entry.key) ?? UNKNOWN;
  const key = resolve({ ...at, node: entry.key }, modules).node;
  return key.type === "StringLiteral" ? key.value : UNKNOWN;
}

export function keyName(key: t.Node): string | undefined {
  if (key.type === "Identifier") return key.name;
  if (key.type === "StringLiteral") return key.value;
  return undefined;
}

/**
 * An object's entries in order, later definitions replacing earlier ones and known spreads merged
 * in. A spread or computed key the code doesn't pin down could replace any entry before it, so
 * those entries are dropped rather than guessed.
 */
export function objectEntries(
  at: At | undefined,
  modules: Map<string, Module>,
): Array<[string, At]> {
  if (!at || at.node.type !== "ObjectExpression") return [];
  return [...entriesWith(at, modules, 0)];
}

function entriesWith(at: At, modules: Map<string, Module>, depth: number): Map<string, At> {
  const entries = new Map<string, At>();
  if (at.node.type !== "ObjectExpression" || depth > MAX_RESOLVE_DEPTH) return entries;
  for (const entry of at.node.properties) {
    if (entry.type === "SpreadElement") {
      const spread = resolve({ ...at, node: entry.argument }, modules);
      if (spread.node.type !== "ObjectExpression") {
        entries.clear();
        continue;
      }
      for (const [key, value] of entriesWith(spread, modules, depth + 1)) {
        entries.delete(key);
        entries.set(key, value);
      }
      continue;
    }
    const key = entryKey(entry, at, modules);
    if (key === UNKNOWN) {
      entries.clear();
      continue;
    }
    entries.delete(key);
    entries.set(
      key,
      entry.type === "ObjectMethod"
        ? { module: at.module, node: entry, env: at.env }
        : resolve({ ...at, node: entry.value }, modules),
    );
  }
  return entries;
}

export function stringProperty(
  at: At,
  name: string,
  modules: Map<string, Module>,
): string | undefined {
  const value = property(at, name, modules);
  return value?.node.type === "StringLiteral" ? value.node.value : undefined;
}

export function memberName(
  node: t.MemberExpression | t.OptionalMemberExpression,
): string | undefined {
  if (node.computed)
    return node.property.type === "StringLiteral" ? node.property.value : undefined;
  return node.property.type === "Identifier" ? node.property.name : undefined;
}

/**
 * Every node below `root` that runs when it does. A function inside is entered only when it is
 * passed straight to a call, as a callback is; one that is only declared or stored may never run.
 */
export function reachable(root: t.Node, visit: (node: t.Node) => void) {
  const walk = (node: t.Node, entered: boolean) => {
    if (!entered && isFunction(node)) return;
    visit(node);
    const callbacks =
      node.type === "CallExpression" || node.type === "NewExpression"
        ? new Set<t.Node>(node.arguments)
        : undefined;
    for (const child of children(node)) walk(child, callbacks?.has(child) ?? false);
  };
  walk(root, true);
}

export function children(node: t.Node): t.Node[] {
  const out: t.Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (SKIPPED_KEYS.has(key)) continue;
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) out.push(item);
    } else if (isNode(value)) out.push(value);
  }
  return out;
}

function isNode(value: unknown): value is t.Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

export type FunctionNode =
  | t.ArrowFunctionExpression
  | t.FunctionExpression
  | t.FunctionDeclaration
  | t.ObjectMethod;

export function isFunction(node: t.Node): node is FunctionNode {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration" ||
    node.type === "ObjectMethod"
  );
}

export function line(node: t.Node): number {
  return node.loc?.start.line ?? 1;
}
