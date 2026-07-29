import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import { newLineTexts } from "../git/diff.js";
import type { ContextInput, ContextProvider } from "./port.js";

/**
 * The four shapes a changed line's enclosing construct can take. A real loop
 * re-enters the same block every iteration (the Rhino `const`-in-loop bug);
 * an iteration-method callback (`.forEach`/`.map`/...) gets a fresh function
 * scope per call and is never a loop for that purpose, whatever it looks
 * like at a glance. A plain function is everything else scope-introducing
 * (declarations, expressions, arrows, methods, route-handler callbacks).
 */
export type ConstructKind =
  "for" | "for-in" | "for-of" | "while" | "do-while" | "iteration-callback" | "function";

export interface EnclosingConstruct {
  kind: ConstructKind;
  /** True only for a genuine loop (for/for-in/for-of/while/do-while). */
  isLoop: boolean;
  /** 1-based line the construct's keyword (or function signature) starts on. */
  openedAtLine: number;
  /** The function's own name, or the iteration method's name; absent when neither is derivable. */
  label?: string;
}

export interface LineScope {
  line: number;
  /** Enclosing constructs, innermost first; empty means module top level. */
  enclosing: EnclosingConstruct[];
}

export interface ScopeAnalysis {
  /** False when the source could not be parsed at all; lines is empty then. */
  parsed: boolean;
  lines: Map<number, LineScope>;
}

const ITERATION_METHODS: ReadonlySet<string> = new Set([
  "forEach",
  "map",
  "filter",
  "find",
  "reduce",
]);
const MAX_SOURCE_BYTES = 512 * 1024;

function loopKindOf(nodeType: string): ConstructKind | undefined {
  switch (nodeType) {
    case "ForStatement":
      return "for";
    case "ForInStatement":
      return "for-in";
    case "ForOfStatement":
      return "for-of";
    case "WhileStatement":
      return "while";
    case "DoWhileStatement":
      return "do-while";
    default:
      return undefined;
  }
}

type FunctionNode =
  acorn.FunctionDeclaration | acorn.FunctionExpression | acorn.ArrowFunctionExpression;

function isFunctionNode(node: acorn.AnyNode): node is FunctionNode {
  return (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  );
}

/** The identifier or string-literal name of a (possibly computed) key; undefined when neither. */
function propertyKeyName(key: acorn.Expression | acorn.PrivateIdentifier): string | undefined {
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  return undefined;
}

/** The `.method` name of a `x.method(...)` callee; undefined for anything computed or not a member call. */
function calleeMethodName(callee: acorn.Expression | acorn.Super): string | undefined {
  if (callee.type !== "MemberExpression" || callee.computed) return undefined;
  return propertyKeyName(callee.property);
}

/**
 * The iteration-method name when `node` is an argument of a
 * `something.<method>(...)` call and `<method>` is one this reviewer treats
 * as non-loop iteration; undefined otherwise (including when the function is
 * itself the callee, e.g. an IIFE, rather than an argument).
 */
function iterationMethodName(
  node: FunctionNode,
  parent: acorn.AnyNode | undefined,
): string | undefined {
  if (parent?.type !== "CallExpression") return undefined;
  const isArgument = parent.arguments.some((argument) => (argument as acorn.AnyNode) === node);
  if (!isArgument) return undefined;
  const method = calleeMethodName(parent.callee);
  return method !== undefined && ITERATION_METHODS.has(method) ? method : undefined;
}

/**
 * A best-effort name for a function that only sometimes names itself: a
 * declaration or named expression carries its own `id`; an anonymous
 * expression borrows the name of whatever it was bound to (a variable, an
 * object/class method key, a simple assignment). Anything else -- a bare
 * callback argument, an IIFE -- stays unlabeled rather than guessed at.
 */
function functionLabel(node: FunctionNode, parent: acorn.AnyNode | undefined): string | undefined {
  if (node.type !== "ArrowFunctionExpression" && node.id != null) return node.id.name;
  if (parent === undefined) return undefined;
  if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier") {
    return parent.id.name;
  }
  if (parent.type === "AssignmentExpression" && parent.left.type === "Identifier") {
    return parent.left.name;
  }
  if (
    parent.type === "AssignmentExpression" &&
    parent.left.type === "MemberExpression" &&
    !parent.left.computed
  ) {
    return propertyKeyName(parent.left.property);
  }
  if ((parent.type === "Property" || parent.type === "MethodDefinition") && !parent.computed) {
    return propertyKeyName(parent.key);
  }
  return undefined;
}

interface ScopeFrame {
  construct: EnclosingConstruct;
  startLine: number;
  endLine: number;
}

/** Every loop and function in the tree, each tagged with its own line range. */
function collectFrames(program: acorn.Program): ScopeFrame[] {
  const frames: ScopeFrame[] = [];
  walk.fullAncestor(program, (node: acorn.AnyNode, _state: unknown, ancestors: acorn.AnyNode[]) => {
    const loc = node.loc;
    if (loc == null) return;
    const loopKind = loopKindOf(node.type);
    if (loopKind !== undefined) {
      frames.push({
        construct: { kind: loopKind, isLoop: true, openedAtLine: loc.start.line },
        startLine: loc.start.line,
        endLine: loc.end.line,
      });
      return;
    }
    if (!isFunctionNode(node)) return;
    const parent = ancestors[ancestors.length - 2];
    const method = iterationMethodName(node, parent);
    let construct: EnclosingConstruct;
    if (method !== undefined) {
      construct = {
        kind: "iteration-callback",
        isLoop: false,
        openedAtLine: loc.start.line,
        label: method,
      };
    } else {
      const label = functionLabel(node, parent);
      construct = {
        kind: "function",
        isLoop: false,
        openedAtLine: loc.start.line,
        ...(label !== undefined ? { label } : {}),
      };
    }
    frames.push({ construct, startLine: loc.start.line, endLine: loc.end.line });
  });
  return frames;
}

/** Innermost first: the smallest containing range sorts first. */
function enclosingFor(frames: readonly ScopeFrame[], line: number): EnclosingConstruct[] {
  return frames
    .filter((frame) => frame.startLine <= line && line <= frame.endLine)
    .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine))
    .map((frame) => frame.construct);
}

/** Tries the dialects this corpus actually uses; undefined means none parsed. */
function tryParse(source: string): acorn.Program | undefined {
  const sourceTypes = ["script", "module"] as const;
  for (const sourceType of sourceTypes) {
    try {
      return acorn.parse(source, {
        ecmaVersion: "latest",
        sourceType,
        locations: true,
        allowReturnOutsideFunction: true,
      });
    } catch {
      // try the next dialect before giving up
    }
  }
  return undefined;
}

/**
 * For each requested line, its enclosing constructs innermost first (empty
 * means module top level). Error-tolerant by construction: a file this
 * corpus's parser cannot read (a syntax error, a dialect neither script nor
 * module parses) comes back as `parsed: false` with no entries, never a
 * thrown error -- the caller degrades to no enrichment for that file.
 */
export function analyzeScope(source: string, lines: readonly number[]): ScopeAnalysis {
  if (lines.length === 0) return { parsed: true, lines: new Map() };
  const program = tryParse(source);
  if (program === undefined) return { parsed: false, lines: new Map() };
  const frames = collectFrames(program);
  const result = new Map<number, LineScope>();
  for (const line of lines) {
    result.set(line, { line, enclosing: enclosingFor(frames, line) });
  }
  return { parsed: true, lines: result };
}

function describeConstruct(construct: EnclosingConstruct): string {
  switch (construct.kind) {
    case "for":
      return `inside for loop opened at line ${String(construct.openedAtLine)}`;
    case "for-in":
      return `inside for...in loop opened at line ${String(construct.openedAtLine)}`;
    case "for-of":
      return `inside for...of loop opened at line ${String(construct.openedAtLine)}`;
    case "while":
      return `inside while loop opened at line ${String(construct.openedAtLine)}`;
    case "do-while":
      return `inside do...while loop opened at line ${String(construct.openedAtLine)}`;
    case "iteration-callback":
      return `inside callback passed to .${construct.label ?? "?"} opened at line ${String(construct.openedAtLine)}`;
    case "function":
      return construct.label !== undefined
        ? `inside function ${construct.label} opened at line ${String(construct.openedAtLine)}`
        : `inside an anonymous function opened at line ${String(construct.openedAtLine)}`;
  }
}

/** A terse, factual one-liner: the enclosing chain, innermost first, then the nesting depth. */
export function describeLineScope(scope: LineScope): string {
  if (scope.enclosing.length === 0) return "module scope (top level)";
  const chain = scope.enclosing.map(describeConstruct).join("; ");
  return `${chain}; module scope depth ${String(scope.enclosing.length)}`;
}

/**
 * True only when the line sits directly inside a real loop's body -- the
 * Rhino re-entered-block bug only bites a declaration in the loop's own
 * block. A declaration in a callback that merely runs once per outer-loop
 * iteration (`.forEach` and friends) gets a fresh scope per call, so only
 * the innermost enclosing construct is ever consulted, never the whole
 * chain.
 */
export function isInsideLoop(scope: LineScope | undefined): boolean {
  return scope?.enclosing[0]?.isLoop === true;
}

/**
 * True at bare module top level, and still true inside a top-level loop
 * (that code still runs once at load time, not deferred to a request) --
 * false as soon as any function or iteration-callback boundary sits between
 * the line and the module, which is exactly what defers execution.
 */
export function isModuleScope(scope: LineScope | undefined): boolean {
  return scope === undefined || scope.enclosing.every((construct) => construct.isLoop);
}

const JS_EXTENSIONS: ReadonlySet<string> = new Set([".js", ".mjs", ".cjs"]);

/** Groups consecutive changed lines that share the exact same scope description into one range. */
function renderFileFacts(scopes: readonly LineScope[]): string[] {
  const sorted = [...scopes].sort((a, b) => a.line - b.line);
  const lines: string[] = [];
  let index = 0;
  while (index < sorted.length) {
    const first = sorted[index];
    if (first === undefined) break;
    const description = describeLineScope(first);
    let last = first;
    let next = index + 1;
    while (next < sorted.length) {
      const candidate = sorted[next];
      if (candidate?.line !== last.line + 1) break;
      if (describeLineScope(candidate) !== description) break;
      last = candidate;
      next += 1;
    }
    const label =
      last.line === first.line
        ? `line ${String(first.line)}`
        : `lines ${String(first.line)}-${String(last.line)}`;
    lines.push(`  ${label}: ${description}`);
    index = next;
  }
  return lines;
}

/**
 * Deterministic, AST-derived facts about each changed line's enclosing
 * structure (JavaScript only; zero extra model calls, ADR 0004 cost
 * posture). Read-only background for the prompt -- it states what the code
 * *is*, never what to do about it, so a weak model does not have to guess
 * whether a `const` sits in a loop or a `.forEach` callback.
 */
export function createScopeProvider(): ContextProvider {
  const notices: string[] = [];
  return {
    name: "scope",
    notices: () => notices,
    systemContext(input: ContextInput): string {
      const changed = newLineTexts(input.diff);
      const sections: string[] = [];
      let unparseable = 0;
      for (const [file, lineTexts] of changed) {
        if (!JS_EXTENSIONS.has(path.extname(file))) continue;
        const lines = [...lineTexts.keys()];
        if (lines.length === 0) continue;
        const fullPath = path.resolve(input.cwd, file);
        let source: string;
        try {
          if (statSync(fullPath).size > MAX_SOURCE_BYTES) continue;
          source = readFileSync(fullPath, "utf8");
        } catch {
          continue; // deleted, renamed away, or otherwise unreadable at review time
        }
        const analysis = analyzeScope(source, lines);
        if (!analysis.parsed) {
          unparseable += 1;
          continue;
        }
        const scopes = lines
          .map((line) => analysis.lines.get(line))
          .filter((scope): scope is LineScope => scope !== undefined);
        const rendered = renderFileFacts(scopes);
        if (rendered.length === 0) continue;
        sections.push(`${file.replaceAll("\\", "/")}:`, ...rendered);
      }
      if (unparseable > 0) {
        notices.push(
          `scope: ${String(unparseable)} changed JS file(s) could not be parsed and were skipped`,
        );
      }
      if (sections.length === 0) return "";
      return [
        "Scope facts for changed lines (read-only, AST-derived; innermost enclosing construct first):",
        ...sections,
      ].join("\n");
    },
  };
}
