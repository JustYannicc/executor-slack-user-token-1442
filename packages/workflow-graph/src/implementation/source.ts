import { parse } from "@babel/parser";
import type * as t from "@babel/types";

/** Parsed app source files and the static name resolution the derivation reads them with. */

/** A source file as stored. Files kept by Git object ID instead of inlined have no `content`. */
export interface SourceFile {
  readonly path: string;
  readonly content?: string;
}

export interface Module {
  readonly path: string;
  readonly source: string;
  readonly program: t.Program;
  /** Top-level bindings: a declared function, or the initializer of a `const`. */
  readonly locals: Map<string, t.Node>;
  readonly imports: Map<string, { readonly from: string; readonly name: string }>;
  readonly exports: Map<string, string>;
  readonly defaultExport: t.Node | undefined;
}

/** A node together with the module it was written in, so its identifiers resolve there. */
export interface At<N extends t.Node = t.Node> {
  readonly module: Module;
  readonly node: N;
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
  const module: Module = {
    path: file.path,
    source: file.content,
    program,
    locals: new Map(),
    imports: new Map(),
    exports: new Map(),
    defaultExport: undefined,
  };
  const declare = (statement: t.Node) => {
    if (statement.type === "FunctionDeclaration" && statement.id)
      module.locals.set(statement.id.name, statement);
    if (statement.type === "VariableDeclaration")
      for (const declarator of statement.declarations)
        if (declarator.id.type === "Identifier" && declarator.init)
          module.locals.set(declarator.id.name, declarator.init);
  };
  let defaultExport: t.Node | undefined;
  for (const statement of program.body) {
    declare(statement);
    if (statement.type === "ImportDeclaration") {
      const from = resolvePath(file.path, statement.source.value);
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportSpecifier")
          module.imports.set(specifier.local.name, {
            from,
            name:
              specifier.imported.type === "Identifier"
                ? specifier.imported.name
                : specifier.imported.value,
          });
        if (specifier.type === "ImportDefaultSpecifier")
          module.imports.set(specifier.local.name, { from, name: "default" });
      }
    }
    if (statement.type === "ExportNamedDeclaration") {
      if (statement.declaration) {
        declare(statement.declaration);
        for (const name of declaredNames(statement.declaration)) module.exports.set(name, name);
      }
      for (const specifier of statement.specifiers)
        if (specifier.type === "ExportSpecifier") {
          const exported =
            specifier.exported.type === "Identifier"
              ? specifier.exported.name
              : specifier.exported.value;
          if (statement.source) {
            const local = `\0${exported}`;
            module.imports.set(local, {
              from: resolvePath(file.path, statement.source.value),
              name: specifier.local.name,
            });
            module.exports.set(exported, local);
          } else module.exports.set(exported, specifier.local.name);
        }
    }
    if (statement.type === "ExportDefaultDeclaration") defaultExport = statement.declaration;
  }
  return { ...module, defaultExport };
}

function declaredNames(declaration: t.Node): string[] {
  if (declaration.type === "FunctionDeclaration" && declaration.id) return [declaration.id.name];
  if (declaration.type === "VariableDeclaration")
    return declaration.declarations.flatMap((d) => (d.id.type === "Identifier" ? [d.id.name] : []));
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

/** Follows identifiers through `const`s and imports to the expression they name. */
export function resolve(at: At, modules: Map<string, Module>, depth = 0): At {
  const node = unwrap(at.node);
  if (node.type !== "Identifier" || depth > 20) return { module: at.module, node };
  return resolveName(at.module, node.name, modules, depth) ?? { module: at.module, node };
}

function resolveName(
  module: Module,
  name: string,
  modules: Map<string, Module>,
  depth: number,
): At | undefined {
  const local = module.locals.get(name);
  if (local) return resolve({ module, node: local }, modules, depth + 1);
  const imported = module.imports.get(name);
  const target = imported && moduleAt(modules, imported.from);
  if (!imported || !target) return undefined;
  if (imported.name === "default")
    return (
      target.defaultExport &&
      resolve({ module: target, node: target.defaultExport }, modules, depth + 1)
    );
  const exported = target.exports.get(imported.name);
  return exported === undefined ? undefined : resolveName(target, exported, modules, depth + 1);
}

export function calleeName(node: t.Node): string | undefined {
  if (node.type !== "CallExpression") return undefined;
  const callee = unwrap(node.callee);
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && callee.property.type === "Identifier")
    return callee.property.name;
  return undefined;
}

export function property(
  at: At | undefined,
  name: string,
  modules: Map<string, Module>,
): At | undefined {
  if (!at || at.node.type !== "ObjectExpression") return undefined;
  for (const entry of at.node.properties) {
    if (entry.type === "ObjectMethod" && keyName(entry.key) === name)
      return { module: at.module, node: entry };
    if (entry.type !== "ObjectProperty" || entry.computed || keyName(entry.key) !== name) continue;
    return resolve({ module: at.module, node: entry.value }, modules);
  }
  return undefined;
}

export function keyName(key: t.Node): string | undefined {
  if (key.type === "Identifier") return key.name;
  if (key.type === "StringLiteral") return key.value;
  return undefined;
}

export function objectEntries(
  at: At | undefined,
  modules: Map<string, Module>,
): Array<[string, At]> {
  if (!at || at.node.type !== "ObjectExpression") return [];
  return at.node.properties.flatMap((entry): Array<[string, At]> => {
    if (entry.type === "ObjectMethod") {
      const name = keyName(entry.key);
      return name === undefined ? [] : [[name, { module: at.module, node: entry }]];
    }
    if (entry.type !== "ObjectProperty" || entry.computed) return [];
    const name = keyName(entry.key);
    return name === undefined
      ? []
      : [[name, resolve({ module: at.module, node: entry.value }, modules)]];
  });
}

export function stringProperty(node: t.Node, name: string): string | undefined {
  if (node.type !== "ObjectExpression") return undefined;
  for (const entry of node.properties)
    if (entry.type === "ObjectProperty" && keyName(entry.key) === name) {
      const value = unwrap(entry.value);
      if (value.type === "StringLiteral") return value.value;
    }
  return undefined;
}

export function memberName(
  node: t.MemberExpression | t.OptionalMemberExpression,
): string | undefined {
  if (node.computed)
    return node.property.type === "StringLiteral" ? node.property.value : undefined;
  return node.property.type === "Identifier" ? node.property.name : undefined;
}

/** Every node below `root`, functions included. */
export function deep(root: t.Node, visit: (node: t.Node) => void) {
  visit(root);
  for (const child of children(root)) deep(child, visit);
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
