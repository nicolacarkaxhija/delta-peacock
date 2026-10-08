import { describe, expect, it } from "vitest";
import type { AstCheck, Guideline } from "../src/domain/guideline.js";
import { parseGuidelineContent } from "../src/guidelines/loader.js";
import { astCovers, parseScript } from "../src/review/checks/ast.js";
import { findCandidates } from "../src/review/checks/detect.js";
import { splitChecked } from "../src/review/checks/index.js";

/** A guideline declaring one syntax tree rule, whose body says the message. */
function rule(name: string, params: string, message = "The code follows the rule."): Guideline {
  const content = `---\nid: ${name}-rule\nseverity: MAJOR\ncheck:\n  type: ast\n  rule: ${name}\n${params}  message: "${message}"\n---\n# ${name}\n\n${message}\n`;
  const parsed = parseGuidelineContent(content, "guidelines/rule.md");
  if (!("guideline" in parsed)) throw new Error("problem" in parsed ? parsed.problem : "disabled");
  return parsed.guideline;
}

const every = (text: string): number[] => text.split("\n").map((_, index) => index + 1);

function found(guideline: Guideline, text: string, changed = every(text), file = "app/script.js") {
  const notices: string[] = [];
  const { bound } = splitChecked([guideline], {});
  const candidates = findCandidates(bound, {
    changed: new Map([[file, new Set(changed)]]),
    read: (name) => (name === file ? text : undefined),
    files: () => [file],
    testIdAttribute: "data-testid",
    notices,
  });
  return { candidates, notices, lines: candidates.map((one) => one.line) };
}

/** The line of the first source line holding `snippet`. */
const at = (lines: readonly string[], snippet: string): number =>
  lines.findIndex((line) => line.includes(snippet)) + 1;

describe("a syntax tree check", () => {
  it("is owned by the guideline that declares it and reports facts quoting its message", () => {
    const guideline = rule("empty-catch", "");
    const { bound, free } = splitChecked([guideline], {});
    expect(bound.map(({ check }) => check)).toEqual(["ast"]);
    expect(free).toEqual([]);
    const { candidates } = found(guideline, "try { a(); } catch (e) {}\n");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      check: "ast",
      shape: "ast-empty-catch",
      line: 1,
      quote: "try { a(); } catch (e) {}",
      title: "The code follows the rule",
      sentence: "The code follows the rule.",
    });
    expect(candidates[0]?.judge).toBeUndefined();
  });

  it("skips a file no parser reads with one notice and no finding", () => {
    const guideline = rule("empty-catch", "");
    const rhino = "for each (var item in list) {\n  try { use(item); } catch (e) {}\n}\n";
    const { candidates, notices } = found(guideline, rhino, every(rhino), "app/legacy.js");
    expect(candidates).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(
      /^check: app\/legacy\.js skipped by the syntax tree checks: .*\(1:4\)$/,
    );
  });

  it("reads ES5 era scripts and modern modules alike", () => {
    expect(typeof parseScript("var a = function () { with (b) { return c; } };\n")).toBe("object");
    expect(typeof parseScript("export const a = async () => b?.c ?? (await d());\n")).toBe(
      "object",
    );
    expect(parseScript("export const a = ;\n")).toMatch(/Unexpected token \(1:17\)/);
  });

  it("reads only JavaScript files its globs cover", () => {
    const guideline = rule("empty-catch", "  files: ['app/**']\n");
    const text = "try { a(); } catch (e) {}\n";
    expect(found(guideline, text, [1], "app/script.ts").candidates).toEqual([]);
    expect(found(guideline, text, [1], "lib/script.js").candidates).toEqual([]);
    expect(found(guideline, text, [1], "app/script.mjs").lines).toEqual([1]);
    expect(found(guideline, text, [], "app/script.js").notices).toEqual([]);
  });

  it("skips an unreadable file quietly when no one collects notices", () => {
    const { bound } = splitChecked([rule("empty-catch", "")], {});
    const candidates = findCandidates(bound, {
      changed: new Map([["a.js", new Set([1])]]),
      read: () => "for each (var a in b) {}\n",
      files: () => ["a.js"],
      testIdAttribute: "data-testid",
    });
    expect(candidates).toEqual([]);
  });

  it("refuses to run a check built with parameters its rule cannot read", () => {
    const check: AstCheck = {
      type: "ast",
      files: [],
      rule: "max-function-lines",
      params: {},
      message: "Functions stay short.",
    };
    expect(() => astCovers(check, "a.js")).toThrow(
      'the max-function-lines rule cannot run: "limit" must be a whole number of at least 1',
    );
  });
});

describe("max-function-lines", () => {
  const guideline = rule("max-function-lines", "  limit: 3\n");
  const source = [
    "function short(a) {",
    "  return a;",
    "}",
    "function long(a) {",
    "  var b = a + 1;",
    "  var handler = function () {",
    "    b += 1;",
    "    return b;",
    "  };",
    "  return handler;",
    "}",
    "",
  ];
  const text = source.join("\n");

  it("flags a function over the limit on its first changed line, the innermost first", () => {
    const { candidates } = found(guideline, text);
    expect(candidates.map((one) => one.line)).toEqual([4, 6]);
    expect(candidates[0]?.body).toBe(
      "The function `long` runs 8 lines, over the limit of 3. Move parts of its work into smaller named functions.",
    );
    expect(candidates[1]?.body).toContain("The function `handler` runs 4 lines");
    expect(found(guideline, text, [7]).candidates[0]?.body).toContain("`handler` runs 4 lines");
    expect(found(guideline, text, [10]).candidates[0]?.body).toContain("`long` runs 8 lines");
  });

  it("leaves a function within the limit alone", () => {
    expect(found(guideline, text, [1, 2, 3]).lines).toEqual([]);
  });

  it("excuses a long function the change does not touch", () => {
    expect(found(guideline, `${text}var x = 1;\n`, [12]).lines).toEqual([]);
  });

  it("names an anonymous callback as this function", () => {
    const callback = "run(function () {\n  a();\n  b();\n  c();\n});\n";
    expect(found(guideline, callback).candidates[0]?.body).toMatch(/^This function runs 5 lines/);
  });
});

describe("call-outside-wrapper", () => {
  const guideline = rule(
    "call-outside-wrapper",
    "  wrapper: [Transaction.wrap, Transaction.begin]\n  call: ProductMgr.getProduct\n  end: Transaction.commit\n",
  );
  const source = [
    "Transaction.wrap(function () {",
    "  order.setNote('x');",
    "});",
    "Transaction.wrap(function () {",
    "  for (var i = 0; i < n; i++) {",
    "    items[i].setNote('x');",
    "  }",
    "});",
    "Transaction.begin();",
    "var product = ProductMgr.getProduct(id);",
    "Transaction.commit();",
    "var later = ProductMgr.getProduct(id);",
    "dw.system.Transaction.wrap(() => ProductMgr.getProduct(id));",
    "",
  ];
  const text = source.join("\n");

  it("flags a loop and a heavy call inside a wrapped body or between begin and commit", () => {
    const { candidates } = found(guideline, text);
    expect(candidates.map((one) => one.line)).toEqual([5, 10, 13]);
    expect(candidates[0]?.body).toBe(
      "A loop runs inside `Transaction.wrap`. Do the work before the transaction opens and keep only the writes inside it.",
    );
    expect(candidates[1]?.body).toContain(
      "`ProductMgr.getProduct` runs inside `Transaction.begin`",
    );
  });

  it("leaves a transaction holding only writes alone, and work after the commit", () => {
    expect(found(guideline, text, [1, 2, 3, 12]).lines).toEqual([]);
  });

  it("puts old work in a new transaction on the wrapper line, and excuses an untouched one", () => {
    expect(found(guideline, text, [4]).lines).toEqual([4]);
    expect(found(guideline, text, [6]).lines).toEqual([]);
  });

  it("runs a begin with no commit to the end of its block", () => {
    const open =
      "function save() {\n  Transaction.begin();\n  while (more()) next();\n}\nwhile (more()) next();\n";
    expect(found(guideline, open).lines).toEqual([3]);
  });

  it("refuses a wrapper that is no name", () => {
    expect(() => rule("call-outside-wrapper", "  wrapper: []\n")).toThrow(
      '"wrapper" must be a name or a list of names',
    );
  });
});

describe("require-at-top", () => {
  const guideline = rule("require-at-top", "  except: ['/services/']\n");
  const source = [
    "var helper = require('./helper');",
    "function load(name) {",
    "  var util = require('./util');",
    "  var service = require('./services/payment');",
    "  return require(name);",
    "}",
    "",
  ];
  const text = source.join("\n");

  it("flags a require inside a function, a computed one too", () => {
    const { candidates } = found(guideline, text);
    expect(candidates.map((one) => one.line)).toEqual([3, 5]);
    expect(candidates[0]?.body).toBe(
      "`require('./util')` runs inside a function. Require the module once at the top of the file.",
    );
  });

  it("leaves a require at the top alone and excuses one the exception matches", () => {
    expect(found(guideline, text, [1, 4]).lines).toEqual([]);
  });

  it("names a broken exception pattern", () => {
    expect(() => rule("require-at-top", "  except: ['(']\n")).toThrow(
      '"except" is not a valid regex',
    );
  });
});

describe("jsdoc-matches-signature", () => {
  const guideline = rule("jsdoc-matches-signature", "");
  const source = [
    "/**",
    " * Adds two numbers.",
    " * @param {number} a The first.",
    " * @param {number} b The second.",
    " * @returns {number} The sum.",
    " */",
    "function add(a, b) { return a + b; }",
    "/**",
    " * @param {{name: string}} options The options.",
    " * @param {string} options.name A property.",
    " * @param {number} count",
    " */",
    "function rename(opts, count) {}",
    "/** Logs the value. */",
    "function log(value) { return value; }",
    "/**",
    " * @returns {string} A text.",
    " */",
    "function nothing() { helper(); }",
    "/**",
    " * @param {number} x",
    " */",
    "var twice = function (x) {",
    "  return x * 2;",
    "};",
    "/**",
    " * @param {number} x",
    " * @returns {void}",
    " */",
    "exports.store = function (x) { save(x); };",
    "/**",
    " * @inheritDoc",
    " */",
    "function inherited(a) { return a; }",
    "/**",
    " * @param {Object} param0",
    " * @param {string} [label='x']",
    " * @param {...number} rest",
    " * @returns {Promise<void>}",
    " */",
    "async function run({ id }, label = 'x', ...rest) { await go(id, rest); }",
    "var shapes = {",
    "  /**",
    "   * @param {number} n",
    "   * @returns {number}",
    "   */",
    "  square: (n) => n * n,",
    "};",
    "class Box {",
    "  /**",
    "   * @param {number} size",
    "   */",
    "  resize(size, unit) {}",
    "}",
    "/**",
    " * @returns {Iterator<number>}",
    " */",
    "function* count() { yield 1; }",
    "list.map(function (item) { return item; });",
    "/**",
    " * @param {number} extra",
    " */",
    "function bare() {}",
    "/**",
    " * @param {Object} options",
    " */",
    "function pick({ a }, b) { use(a, b); }",
    "/** @param {broken */",
    "function odd(a) { return a; }",
    "/** @param {number} trailing */",
    "",
  ];
  const text = source.join("\n");

  it("flags params that differ, a @returns with no value and a missing @returns", () => {
    const { candidates } = found(guideline, text);
    expect(candidates.map((one) => one.line)).toEqual([
      at(source, "function rename"),
      at(source, "function nothing"),
      at(source, "var twice"),
      at(source, "resize(size"),
      at(source, "function bare"),
      at(source, "function pick"),
    ]);
    expect(candidates[4]?.body).toContain("name `extra` while it takes none");
    expect(candidates[5]?.body).toContain("name `options` while it takes `{...}`, `b`");
    expect(candidates[0]?.body).toBe(
      "The @param tags of the function `rename` name `options`, `count` while it takes `opts`, `count`. Make the tags say what the code does.",
    );
    expect(candidates[1]?.body).toContain(
      "the function `nothing` has @returns, yet it returns no value",
    );
    expect(candidates[2]?.body).toContain(
      "The function `twice` returns a value its doc comment has no @returns for",
    );
    expect(candidates[3]?.body).toContain("name `size` while it takes `size`, `unit`");
  });

  it("leaves matching doc comments, untagged ones and inherited ones alone", () => {
    const right = [
      ...every(text).filter((line) => line <= at(source, "function add")),
      at(source, "function log"),
      at(source, "exports.store"),
      at(source, "function inherited"),
      at(source, "async function run"),
      at(source, "square:"),
      at(source, "function* count"),
      at(source, "list.map"),
    ];
    expect(found(guideline, text, right).lines).toEqual([]);
  });

  it("flags a missing @returns where the change adds the return, and excuses an untouched function", () => {
    expect(found(guideline, text, [at(source, "return x * 2")]).lines).toEqual([
      at(source, "return x * 2"),
    ]);
    expect(found(guideline, text, [at(source, "options.name")]).lines).toEqual([
      at(source, "options.name"),
    ]);
    expect(found(guideline, text, [at(source, "return x * 2") + 1]).lines).toEqual([]);
  });

  it("reads the doc comment above an exported function of a module", () => {
    const module =
      "/**\n * @param {number} id\n */\nexport function find(id) {\n  return lookup(id);\n}\n";
    expect(found(guideline, module).candidates[0]?.body).toContain("`find` returns a value");
  });
});

describe("empty-catch", () => {
  const guideline = rule("empty-catch", "");
  const source = [
    "try { a(); } catch (e) { log(e); }",
    "try { b(); } catch (e) {}",
    "try {",
    "  c();",
    "} catch (e) {",
    "  // nothing to do",
    "}",
    "try { d(); } catch { throw new Error('d failed'); }",
    "",
  ];
  const text = source.join("\n");

  it("flags a catch block with no statement or only a comment", () => {
    const { candidates } = found(guideline, text);
    expect(candidates.map((one) => one.line)).toEqual([2, 5]);
    expect(candidates[0]?.body).toBe(
      "The catch block holds no statement, so the error disappears. Catch only what can throw, and handle, log or rethrow it.",
    );
    expect(candidates[1]?.body).toContain("holds only a comment");
  });

  it("leaves a catch that handles the error alone, and excuses one the change does not touch", () => {
    expect(found(guideline, text, [1, 3, 4, 8]).lines).toEqual([]);
    expect(found(guideline, text, [6]).lines).toEqual([6]);
  });
});

describe("assignment-to-member", () => {
  const guideline = rule(
    "assignment-to-member",
    "  object: session.custom\n  property: '^(?!allowed)'\n  maxLength: 10\n",
  );
  const source = [
    "session.custom.token = 'short';",
    "session.custom.note = 'a string far too long';",
    "session.custom.payload = JSON.stringify(cart);",
    "session.custom['quoted'] = `tpl`;",
    "session.custom.allowed = 'a string far too long';",
    "other.custom.note = 'a string far too long';",
    "if (session.custom.note === 'x') { count = 1; }",
    "",
  ];
  const text = source.join("\n");

  it("flags a literal over the length and a value of unknown length", () => {
    const { candidates } = found(guideline, text);
    expect(candidates.map((one) => one.line)).toEqual([2, 3]);
    expect(candidates[0]?.body).toBe(
      "`session.custom.note` is assigned a string of 21 characters, over the limit of 10.",
    );
    expect(candidates[1]?.body).toBe(
      "`session.custom.payload` is assigned a value whose length the code does not hold to 10 characters.",
    );
  });

  it("leaves short literals, other objects, reads and excluded properties alone", () => {
    expect(found(guideline, text, [1, 4, 5, 6, 7]).lines).toEqual([]);
  });

  it("flags every assignment when no length is set", () => {
    const any = rule("assignment-to-member", "  object: session.custom\n");
    const { candidates } = found(any, text);
    expect(candidates.map((one) => one.line)).toEqual([1, 2, 3, 4, 5]);
    expect(candidates[0]?.body).toBe(
      "The change assigns to `session.custom.token`, which the guideline rules out.",
    );
    expect(found(any, "session.custom[key] = 1;\n").lines).toEqual([1]);
    expect(found(guideline, "session.custom[key] = 'long enough to count';\n").lines).toEqual([]);
  });
});

describe("call-with-arity", () => {
  const guideline = rule("call-with-arity", "  callee: Logger.getLogger\n  arity: 1\n");
  const source = [
    "var a = Logger.getLogger('checkout');",
    "var b = Logger.getLogger('checkout', 'payment');",
    "var c = dw.system.Logger.getLogger('orders');",
    "var d = Logger.getLogger(...parts);",
    "var e = OtherLogger.getLogger('orders');",
    "var f = this.factory().getLogger('orders');",
    "",
  ];
  const text = source.join("\n");

  it("flags a call with the given argument count, under a longer path too", () => {
    const { candidates } = found(guideline, text);
    expect(candidates.map((one) => one.line)).toEqual([1, 3]);
    expect(candidates[0]?.body).toBe("`Logger.getLogger` is called with 1 argument.");
  });

  it("leaves other counts and other functions alone, and excuses a spread", () => {
    expect(found(guideline, text, [2, 4, 5, 6]).lines).toEqual([]);
  });

  it("takes a list of counts", () => {
    const many = rule("call-with-arity", "  callee: [Logger.getLogger]\n  arity: [0, 2]\n");
    expect(found(many, `${text}Logger.getLogger();\n`).lines).toEqual([2, 7]);
  });
});

describe("the syntax tree examples in the checks guide", () => {
  it("loads each example and flags what it promises", () => {
    const slim = rule(
      "max-function-lines",
      "  files: ['cartridges/**/controllers/*.js']\n  limit: 40\n",
      "A route handler stays under 40 lines and hands its work to models and helpers.",
    );
    const handler = `server.get('Show', function (req, res, next) {\n${"  step();\n".repeat(40)}});\n`;
    expect(
      found(slim, handler, every(handler), "cartridges/app/controllers/Cart.js").lines,
    ).toEqual([1]);
    const transaction = rule(
      "call-outside-wrapper",
      "  wrapper: [Transaction.wrap, Transaction.begin]\n  call: [ProductMgr.getProduct, OrderMgr.searchOrders]\n  end: [Transaction.commit, Transaction.rollback]\n",
      "A transaction holds only the writes, never a loop or a lookup.",
    );
    const lookup =
      "Transaction.begin();\nvar orders = OrderMgr.searchOrders(query);\nTransaction.rollback();\n";
    expect(found(transaction, lookup).lines).toEqual([2]);
    const logger = rule(
      "call-with-arity",
      "  callee: Logger.getLogger\n  arity: 1\n",
      "getLogger takes a category as its second argument.",
    );
    expect(found(logger, "var log = Logger.getLogger('cart');\n").lines).toEqual([1]);
  });
});

describe("a declared syntax tree check that cannot run", () => {
  const problem = (params: string, message = "The code follows the rule."): string => {
    const content = `---\nid: broken\nseverity: MAJOR\ncheck:\n  type: ast\n${params}  message: "${message}"\n---\n# Broken\n\nThe code follows the rule.\n`;
    const parsed = parseGuidelineContent(content, "guidelines/rule.md");
    return "problem" in parsed ? parsed.problem : "";
  };

  it("names an unknown rule and every rule there is", () => {
    expect(problem("  rule: no-eval\n")).toBe(
      'guidelines/rule.md: guideline "broken" check: "rule" must be one of max-function-lines, call-outside-wrapper, require-at-top, jsdoc-matches-signature, empty-catch, assignment-to-member, call-with-arity',
    );
  });

  it("names a parameter the rule does not take, and one it needs", () => {
    expect(problem("  rule: empty-catch\n  limit: 3\n")).toContain(
      "unknown key(s) limit for the empty-catch rule",
    );
    expect(problem("  rule: max-function-lines\n")).toContain(
      '"limit" must be a whole number of at least 1',
    );
    expect(problem("  rule: max-function-lines\n  limit: 0\n")).toContain(
      '"limit" must be a whole number',
    );
    expect(problem("  rule: call-with-arity\n  callee: f\n  arity: two\n")).toContain(
      '"arity" must be a whole number of at least 0 or a list of them',
    );
    expect(problem("  rule: call-with-arity\n  arity: 1\n")).toContain(
      '"callee" must be a name or a list of names',
    );
    expect(problem("  rule: assignment-to-member\n  object: a.b\n  maxLength: -1\n")).toContain(
      '"maxLength" must be a whole number of at least 0',
    );
    expect(problem("  rule: assignment-to-member\n  object: a.b\n  property: [3]\n")).toContain(
      '"property" must be a regex or a list of regexes',
    );
  });

  it("refuses bad globs and a message the guideline does not say", () => {
    expect(problem("  rule: empty-catch\n  files: 3\n")).toContain(
      '"files" must be a list of path globs',
    );
    expect(problem("  rule: empty-catch\n", "")).toContain('"message" must be a non empty string');
    expect(problem("  rule: empty-catch\n", "Something else entirely.")).toContain(
      '"message" must be a sentence the guideline says word for word',
    );
  });
});
