import type * as acorn from "acorn";
import type { AstRule } from "../../domain/guideline.js";

/** One parsed script: its tree, its comments and a way from offsets to lines. */
export interface ParsedScript {
  program: acorn.Program;
  comments: readonly acorn.Comment[];
  text: string;
  /** The 1 based line of an offset into `text`. */
  lineAt: (offset: number) => number;
}

/** One place a rule found; the first of its lines the change touched holds the finding. */
export interface Hit {
  lines: readonly number[];
  /** What was measured, then the fix. */
  body: string;
}

type Node = acorn.AnyNode;
type FunctionNode =
  acorn.FunctionDeclaration | acorn.FunctionExpression | acorn.ArrowFunctionExpression;
type Find = (script: ParsedScript) => Hit[];

/** A rule's parameter keys and how its raw parameters become a finder, or why they cannot. */
interface RuleSpec {
  keys: readonly string[];
  compile: (params: Readonly<Record<string, unknown>>) => Find | string;
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string";

function childrenOf(node: Node): Node[] {
  const found: Node[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) found.push(...value.filter(isNode));
    else if (isNode(value)) found.push(value);
  }
  return found;
}

/** Calls `each` on every node below `root` with its ancestors, outermost first. */
function walk(root: Node, each: (node: Node, ancestors: readonly Node[]) => void): void {
  const visit = (node: Node, ancestors: Node[]): void => {
    each(node, ancestors);
    ancestors.push(node);
    for (const child of childrenOf(node)) visit(child, ancestors);
    ancestors.pop();
  };
  visit(root, []);
}

const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);
const isFunction = (node: Node): node is FunctionNode => FUNCTION_TYPES.has(node.type);

const LOOP_TYPES = new Set([
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "WhileStatement",
  "DoWhileStatement",
]);

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

const linesOf = (script: ParsedScript, node: Node): number[] =>
  range(script.lineAt(node.start), script.lineAt(node.end));

const code = (text: string): string => (text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``);

/** The string a literal or a plain template holds; undefined for anything else. */
function stringOf(node: Node): string | undefined {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/** A dotted name such as `Transaction.wrap`; undefined when part of it is computed. */
function nameOf(node: Node): string | undefined {
  if (node.type === "Identifier") return node.name;
  if (node.type === "ThisExpression") return "this";
  if (node.type !== "MemberExpression") return undefined;
  const object = nameOf(node.object);
  const property = memberName(node);
  return object === undefined || property === undefined ? undefined : `${object}.${property}`;
}

function memberName(node: acorn.MemberExpression): string | undefined {
  if (!node.computed && node.property.type === "Identifier") return node.property.name;
  return stringOf(node.property);
}

/** A name matches itself and any longer path ending in it: `Logger.getLogger` matches `dw.system.Logger.getLogger`. */
const matchesName = (name: string | undefined, wanted: readonly string[]): boolean =>
  name !== undefined && wanted.some((one) => name === one || name.endsWith(`.${one}`));

const calleeOf = (node: acorn.CallExpression): string | undefined => nameOf(node.callee);

const plural = (count: number, word: string): string =>
  `${String(count)} ${word}${count === 1 ? "" : "s"}`;

// parameter readers: each returns the value or the problem in words

type Read<T> = T | { problem: string };
const failed = <T>(value: Read<T>): value is { problem: string } =>
  typeof value === "object" && value !== null && "problem" in value;

function wholeNumber(raw: unknown, key: string, min: number): Read<number> {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= min) return raw;
  return { problem: `"${key}" must be a whole number of at least ${String(min)}` };
}

function names(raw: unknown, key: string): Read<string[]> {
  const list = typeof raw === "string" ? [raw] : raw;
  if (
    Array.isArray(list) &&
    list.length > 0 &&
    list.every((one) => typeof one === "string" && one !== "")
  ) {
    return list as string[];
  }
  return { problem: `"${key}" must be a name or a list of names` };
}

function regexes(raw: unknown, key: string): Read<RegExp[]> {
  const list = names(raw, key);
  if (failed(list)) return { problem: `"${key}" must be a regex or a list of regexes` };
  try {
    return list.map((source) => new RegExp(source));
  } catch (error) {
    return { problem: `"${key}" is not a valid regex: ${(error as Error).message}` };
  }
}

/** Reads every given key; the first problem wins. */
function readAll<T extends Record<string, unknown>>(readers: { [K in keyof T]: () => Read<T[K]> }):
  T | string {
  const values: Record<string, unknown> = {};
  for (const [key, reader] of Object.entries(readers) as [string, () => Read<unknown>][]) {
    const value = reader();
    if (failed(value)) return value.problem;
    values[key] = value;
  }
  return values as T;
}

/** Reads `key` only when given; absent keys keep the fallback. */
const optional =
  <T>(
    params: Readonly<Record<string, unknown>>,
    key: string,
    read: (raw: unknown) => Read<T>,
    fallback: T,
  ) =>
  (): Read<T> =>
    params[key] === undefined ? fallback : read(params[key]);

/** The name a function goes by: its own, its variable's, its property's, or undefined. */
function functionLabel(node: FunctionNode, parent: Node | undefined): string | undefined {
  if (node.id) return node.id.name;
  if (parent?.type === "VariableDeclarator" && parent.id.type === "Identifier")
    return parent.id.name;
  if (parent?.type === "AssignmentExpression") return nameOf(parent.left);
  if (parent?.type === "Property" || parent?.type === "MethodDefinition") {
    return parent.key.type === "Identifier" ? parent.key.name : stringOf(parent.key);
  }
  return undefined;
}

const named = (label: string | undefined): string =>
  label === undefined ? "this function" : `the function ${code(label)}`;

const described = (label: string | undefined): string => named(label).replace(/^t/, "T");

const maxFunctionLines: RuleSpec = {
  keys: ["limit"],
  compile: (params) => {
    const read = readAll<{ limit: number }>({
      limit: () => wholeNumber(params["limit"], "limit", 1),
    });
    if (typeof read === "string") return read;
    return (script) => {
      const found: { length: number; hit: Hit }[] = [];
      walk(script.program, (node, ancestors) => {
        if (!isFunction(node)) return;
        const lines = linesOf(script, node);
        if (lines.length <= read.limit) return;
        const label = functionLabel(node, ancestors.at(-1));
        found.push({
          length: lines.length,
          hit: {
            lines,
            body: `${described(label)} runs ${plural(lines.length, "line")}, over the limit of ${String(read.limit)}. Move parts of its work into smaller named functions.`,
          },
        });
      });
      // the innermost function holds a line both share
      return found.sort((a, b) => a.length - b.length).map(({ hit }) => hit);
    };
  },
};

const STATEMENT_LISTS = new Set(["BlockStatement", "Program"]);

/** Statements after a begin call in its block, up to and with the first one that ends it. */
function openRegion(ancestors: readonly Node[], end: readonly string[]): Node[] {
  // the program is the outermost block, and a call always sits in a statement below it
  const at = ancestors.findLastIndex((one) => STATEMENT_LISTS.has(one.type));
  const block = ancestors[at] as acorn.BlockStatement | acorn.Program;
  const statement = ancestors[at + 1] as acorn.Statement;
  const after = block.body.slice(block.body.indexOf(statement) + 1) as Node[];
  const closing = after.findIndex((one) => {
    let ends = false;
    walk(one, (node) => {
      if (node.type === "CallExpression" && matchesName(calleeOf(node), end)) ends = true;
    });
    return ends;
  });
  return closing < 0 ? after : after.slice(0, closing + 1);
}

const callOutsideWrapper: RuleSpec = {
  keys: ["wrapper", "call", "end"],
  compile: (params) => {
    const read = readAll<{ wrapper: string[]; call: string[]; end: string[] }>({
      wrapper: () => names(params["wrapper"], "wrapper"),
      call: optional(params, "call", (raw) => names(raw, "call"), []),
      end: optional(params, "end", (raw) => names(raw, "end"), []),
    });
    if (typeof read === "string") return read;
    return (script) => {
      const hits: Hit[] = [];
      const seen = new Set<number>();
      const scan = (region: readonly Node[], wrapper: acorn.CallExpression, name: string): void => {
        const wrapperLine = script.lineAt(wrapper.start);
        for (const root of region) {
          walk(root, (node) => {
            const loop = LOOP_TYPES.has(node.type);
            const heavy = node.type === "CallExpression" && matchesName(calleeOf(node), read.call);
            if ((!loop && !heavy) || seen.has(node.start)) return;
            seen.add(node.start);
            const what = node.type === "CallExpression" ? code(calleeOf(node) ?? "") : "A loop";
            hits.push({
              lines: [script.lineAt(node.start), wrapperLine],
              body: `${what} runs inside ${code(name)}. Do the work before the transaction opens and keep only the writes inside it.`,
            });
          });
        }
      };
      walk(script.program, (node, ancestors) => {
        if (node.type !== "CallExpression") return;
        const name = calleeOf(node);
        if (name === undefined || !matchesName(name, read.wrapper)) return;
        const body = node.arguments.find((argument) => isFunction(argument as Node)) as
          FunctionNode | undefined;
        if (body !== undefined) {
          scan([body.body], node, name);
          return;
        }
        scan(openRegion(ancestors, read.end), node, name);
      });
      return hits;
    };
  },
};

const requireAtTop: RuleSpec = {
  keys: ["except"],
  compile: (params) => {
    const read = readAll<{ except: RegExp[] }>({
      except: optional(params, "except", (raw) => regexes(raw, "except"), []),
    });
    if (typeof read === "string") return read;
    return (script) => {
      const hits: Hit[] = [];
      walk(script.program, (node, ancestors) => {
        if (node.type !== "CallExpression" || calleeOf(node) !== "require") return;
        if (!ancestors.some(isFunction)) return;
        const first = node.arguments[0] as Node | undefined;
        const target = first === undefined ? undefined : stringOf(first);
        if (target !== undefined && read.except.some((pattern) => pattern.test(target))) return;
        hits.push({
          lines: [script.lineAt(node.start)],
          body: `${code(script.text.slice(node.start, node.end))} runs inside a function. Require the module once at the top of the file.`,
        });
      });
      return hits;
    };
  },
};

interface DocTags {
  params: string[];
  returns: string | undefined;
  inherits: boolean;
}

/** The balanced `{...}` at `from`, as its end offset; `from` itself when there is none. */
function skipType(text: string, from: number): number {
  if (text[from] !== "{") return from;
  let depth = 0;
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    if (text[index] === "}") depth -= 1;
    if (depth === 0) return index + 1;
  }
  return text.length;
}

function docTags(value: string): DocTags {
  const tags: DocTags = { params: [], returns: undefined, inherits: false };
  for (const match of value.matchAll(/@(\w+)/g)) {
    const tag = match[1] ?? "";
    let at = match.index + match[0].length;
    while (/\s/.test(value[at] ?? "")) at += 1;
    const typeEnd = skipType(value, at);
    if (/^(?:inheritdoc|override)$/i.test(tag)) tags.inherits = true;
    if (tag === "returns" || tag === "return") tags.returns = value.slice(at, typeEnd);
    if (tag !== "param" && tag !== "arg" && tag !== "argument") continue;
    const name = /^\s*\[?\s*([\w$.]+)/.exec(value.slice(typeEnd))?.[1];
    // a dotted name documents a property of an earlier parameter
    if (name !== undefined && !name.includes(".")) tags.params.push(name);
  }
  return tags;
}

/** The parameter names in order; undefined stands for a destructured one, which any name fits. */
function parameterNames(node: FunctionNode): (string | undefined)[] {
  return node.params.map((param) => {
    const inner =
      param.type === "AssignmentPattern"
        ? param.left
        : param.type === "RestElement"
          ? param.argument
          : param;
    return inner.type === "Identifier" ? inner.name : undefined;
  });
}

/** The statement or member a doc comment sits above, for a function that can carry one. */
function docAnchor(node: FunctionNode, ancestors: readonly Node[]): Node | undefined {
  const parent = ancestors.at(-1);
  const grand = ancestors.at(-2);
  const exported = (one: Node, above: Node | undefined): Node =>
    above?.type === "ExportNamedDeclaration" || above?.type === "ExportDefaultDeclaration"
      ? above
      : one;
  if (node.type === "FunctionDeclaration") return exported(node, parent);
  if (parent?.type === "VariableDeclarator" && grand?.type === "VariableDeclaration") {
    return exported(grand, ancestors.at(-3));
  }
  if (parent?.type === "AssignmentExpression" && grand?.type === "ExpressionStatement")
    return grand;
  if (
    parent?.type === "Property" ||
    parent?.type === "MethodDefinition" ||
    parent?.type === "PropertyDefinition"
  ) {
    return parent;
  }
  return undefined;
}

/** Return statements of the function itself, nested functions left out. */
function ownReturns(node: FunctionNode): acorn.ReturnStatement[] {
  const found: acorn.ReturnStatement[] = [];
  const visit = (one: Node): void => {
    if (one.type === "ReturnStatement") found.push(one);
    for (const child of childrenOf(one)) if (!isFunction(child)) visit(child);
  };
  visit(node.body);
  return found;
}

const VOID_TYPE = /^\{\s*(?:void|undefined|Promise\s*<\s*void\s*>)\s*\}$/;

const jsdocMatchesSignature: RuleSpec = {
  keys: [],
  compile: () => (script) => {
    // a doc comment belongs to the code that starts right after it
    const docs = new Map<number, acorn.Comment>();
    for (const comment of script.comments) {
      if (comment.type !== "Block" || !comment.value.startsWith("*")) continue;
      const next = /\S/.exec(script.text.slice(comment.end));
      docs.set(comment.end + (next?.index ?? 0), comment);
    }
    const hits: Hit[] = [];
    walk(script.program, (node, ancestors) => {
      if (!isFunction(node)) return;
      const anchor = docAnchor(node, ancestors);
      const doc = anchor === undefined ? undefined : docs.get(anchor.start);
      if (doc === undefined) return;
      const tags = docTags(doc.value);
      // a block with no signature tag documents no signature
      if (tags.inherits || (tags.params.length === 0 && tags.returns === undefined)) return;
      const label = functionLabel(node, ancestors.at(-1));
      const subject = named(label);
      const signature = [
        ...range(script.lineAt(node.start), script.lineAt(node.body.start)),
        ...range(script.lineAt(doc.start), script.lineAt(doc.end)),
      ];
      const fix = "Make the tags say what the code does.";
      const actual = parameterNames(node);
      const differ =
        actual.length !== tags.params.length ||
        actual.some((name, index) => name !== undefined && name !== tags.params[index]);
      if (differ) {
        const listed = (list: readonly (string | undefined)[]): string =>
          list.length === 0 ? "none" : list.map((one) => code(one ?? "{...}")).join(", ");
        hits.push({
          lines: signature,
          body: `The @param tags of ${subject} name ${listed(tags.params)} while it takes ${listed(actual)}. ${fix}`,
        });
      }
      // a generator hands back an iterator whatever it returns
      if (node.generator) return;
      const returns = ownReturns(node).filter((one) => one.argument);
      const gives = node.expression || returns.length > 0;
      const returnLines = [...signature, ...returns.map((one) => script.lineAt(one.start))];
      if (tags.returns !== undefined && !gives && !VOID_TYPE.test(tags.returns)) {
        hits.push({
          lines: returnLines,
          body: `The doc comment of ${subject} has @returns, yet it returns no value. ${fix}`,
        });
      }
      if (gives && tags.returns === undefined) {
        hits.push({
          lines: returnLines,
          body: `${described(label)} returns a value its doc comment has no @returns for. ${fix}`,
        });
      }
    });
    return hits;
  },
};

const emptyCatch: RuleSpec = {
  keys: [],
  compile: () => (script) => {
    const hits: Hit[] = [];
    walk(script.program, (node) => {
      if (node.type !== "CatchClause" || node.body.body.length > 0) return;
      const commented = script.comments.some(
        (comment) => comment.start > node.body.start && comment.end < node.body.end,
      );
      hits.push({
        lines: linesOf(script, node),
        body: `The catch block holds ${commented ? "only a comment" : "no statement"}, so the error disappears. Catch only what can throw, and handle, log or rethrow it.`,
      });
    });
    return hits;
  },
};

const assignmentToMember: RuleSpec = {
  keys: ["object", "property", "maxLength"],
  compile: (params) => {
    const read = readAll<{ object: string[]; property: RegExp[]; maxLength: number | undefined }>({
      object: () => names(params["object"], "object"),
      property: optional(params, "property", (raw) => regexes(raw, "property"), []),
      maxLength: optional<number | undefined>(
        params,
        "maxLength",
        (raw) => wholeNumber(raw, "maxLength", 0),
        undefined,
      ),
    });
    if (typeof read === "string") return read;
    return (script) => {
      const hits: Hit[] = [];
      walk(script.program, (node) => {
        if (node.type !== "AssignmentExpression" || node.left.type !== "MemberExpression") return;
        if (!matchesName(nameOf(node.left.object), read.object)) return;
        const property = memberName(node.left);
        if (
          read.property.length > 0 &&
          !read.property.some((one) => property !== undefined && one.test(property))
        ) {
          return;
        }
        const target = code(script.text.slice(node.left.start, node.left.end));
        const value = stringOf(node.right);
        const limit = read.maxLength;
        let body = `The change assigns to ${target}, which the guideline rules out.`;
        if (limit !== undefined && value !== undefined) {
          if (value.length <= limit) return;
          body = `${target} is assigned a string of ${plural(value.length, "character")}, over the limit of ${String(limit)}.`;
        } else if (limit !== undefined) {
          body = `${target} is assigned a value whose length the code does not hold to ${String(limit)} characters.`;
        }
        hits.push({ lines: [script.lineAt(node.start)], body });
      });
      return hits;
    };
  },
};

const callWithArity: RuleSpec = {
  keys: ["callee", "arity"],
  compile: (params) => {
    const read = readAll<{ callee: string[]; arity: number[] }>({
      callee: () => names(params["callee"], "callee"),
      arity: () => {
        const raw = params["arity"];
        const list = Array.isArray(raw) && raw.length > 0 ? (raw as unknown[]) : [raw];
        const read = list.map((one) => wholeNumber(one, "arity", 0));
        return read.every((one): one is number => !failed(one))
          ? read
          : { problem: `"arity" must be a whole number of at least 0 or a list of them` };
      },
    });
    if (typeof read === "string") return read;
    return (script) => {
      const hits: Hit[] = [];
      walk(script.program, (node) => {
        if (node.type !== "CallExpression") return;
        const name = calleeOf(node);
        if (!matchesName(name, read.callee)) return;
        // a spread hides the count
        if (node.arguments.some((argument) => argument.type === "SpreadElement")) return;
        if (!read.arity.includes(node.arguments.length)) return;
        hits.push({
          lines: [script.lineAt(node.start)],
          body: `${code(name ?? "")} is called with ${plural(node.arguments.length, "argument")}.`,
        });
      });
      return hits;
    };
  },
};

/** Every rule a syntax tree check can name. */
export const AST_RULE_SPECS: Readonly<Record<AstRule, RuleSpec>> = {
  "max-function-lines": maxFunctionLines,
  "call-outside-wrapper": callOutsideWrapper,
  "require-at-top": requireAtTop,
  "jsdoc-matches-signature": jsdocMatchesSignature,
  "empty-catch": emptyCatch,
  "assignment-to-member": assignmentToMember,
  "call-with-arity": callWithArity,
};
