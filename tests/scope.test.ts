import { describe, expect, it } from "vitest";
import {
  analyzeScope,
  createScopeProvider,
  describeLineScope,
  isInsideLoop,
  isModuleScope,
  type LineScope,
} from "../src/context/scope.js";
import { activeStrategies, buildContextProvider } from "../src/context/build.js";
import { loadConfig } from "../src/config/loader.js";
import { makeRepo, write } from "./helpers/git.js";

/** The scope for a single requested line; fails the test loudly if analysis found none. */
function scopeOf(source: string, line: number): LineScope {
  const scope = analyzeScope(source, [line]).lines.get(line);
  if (scope === undefined)
    throw new Error(`analyzeScope produced no entry for line ${String(line)}`);
  return scope;
}

describe("analyzeScope: real loops", () => {
  it("recognizes a for loop and its opening line", () => {
    const source = [
      "function f() {",
      "  for (var i = 0; i < 10; i++) {",
      "    const x = i;",
      "  }",
      "}",
    ].join("\n");
    const scope = scopeOf(source, 3);
    expect(scope.enclosing[0]).toMatchObject({ kind: "for", isLoop: true, openedAtLine: 2 });
    expect(isInsideLoop(scope)).toBe(true);
  });

  it("recognizes for...in, for...of, while and do...while as loops", () => {
    const cases: { source: string; kind: string; line: number }[] = [
      {
        source: "function f() {\n  for (var k in o) {\n    const x = k;\n  }\n}",
        kind: "for-in",
        line: 3,
      },
      {
        source: "function f() {\n  for (const k of o) {\n    const x = k;\n  }\n}",
        kind: "for-of",
        line: 3,
      },
      { source: "function f() {\n  while (a) {\n    const x = 1;\n  }\n}", kind: "while", line: 3 },
      {
        source: "function f() {\n  do {\n    const x = 1;\n  } while (a);\n}",
        kind: "do-while",
        line: 3,
      },
    ];
    for (const { source, kind, line } of cases) {
      const scope = scopeOf(source, line);
      expect(scope.enclosing[0]?.kind).toBe(kind);
      expect(scope.enclosing[0]?.isLoop).toBe(true);
      expect(isInsideLoop(scope)).toBe(true);
    }
  });
});

describe("analyzeScope: iteration-method callbacks are not loops", () => {
  it.each(["forEach", "map", "filter", "find", "reduce"])(
    "does not treat a .%s callback body as a loop",
    (method) => {
      const source = [
        "function addProducts() {",
        `  items.${method}(function (item) {`,
        "    const id = item.id;",
        "  });",
        "}",
      ].join("\n");
      const scope = scopeOf(source, 3);
      expect(scope.enclosing[0]).toMatchObject({
        kind: "iteration-callback",
        isLoop: false,
        openedAtLine: 2,
        label: method,
      });
      expect(isInsideLoop(scope)).toBe(false);
    },
  );

  it("describes an arrow callback the same way as a plain function callback (both are just not loops)", () => {
    const arrow = scopeOf(
      [
        "function addProducts() {",
        "  items.forEach((item) => {",
        "    const id = item.id;",
        "  });",
        "}",
      ].join("\n"),
      3,
    );
    expect(describeLineScope(arrow)).toContain("callback passed to .forEach");
  });

  it("does not classify a callback passed to an unrelated method as an iteration callback", () => {
    const source = [
      "server.replace('Show', function (req, res, next) {",
      "  const deliveryUtil = require('*/scripts/order/deliveryUtil');",
      "});",
    ].join("\n");
    const scope = scopeOf(source, 2);
    expect(scope.enclosing[0]?.kind).toBe("function");
    expect(isInsideLoop(scope)).toBe(false);
  });
});

describe("analyzeScope: plain functions and module scope", () => {
  it("names a function declaration", () => {
    const source = ["function positiveControlTotals() {", "  const total = 1;", "}"].join("\n");
    const scope = scopeOf(source, 2);
    expect(scope.enclosing[0]).toMatchObject({
      kind: "function",
      isLoop: false,
      openedAtLine: 1,
      label: "positiveControlTotals",
    });
  });

  it("derives a name for a function expression from its variable", () => {
    const source = [
      "const addProducts = function (items) {",
      "  const total = items.length;",
      "}",
    ].join("\n");
    const scope = scopeOf(source, 2);
    expect(scope.enclosing[0]?.label).toBe("addProducts");
  });

  it("derives a name for a method-shorthand function from its key", () => {
    const source = [
      "const helpers = {",
      "  addProducts(items) {",
      "    const total = items.length;",
      "  },",
      "};",
    ].join("\n");
    const scope = scopeOf(source, 3);
    expect(scope.enclosing[0]?.label).toBe("addProducts");
  });

  it("leaves an anonymous function unlabeled", () => {
    const source = [
      "server.replace('Show', function (req, res, next) {",
      "  const id = 1;",
      "});",
    ].join("\n");
    const scope = scopeOf(source, 2);
    expect(scope.enclosing[0]?.label).toBeUndefined();
  });

  it("reports module top level for a line outside every function and loop", () => {
    const source = [
      "const ProductMgr = require('dw/catalog/ProductMgr');",
      "module.exports = {};",
    ].join("\n");
    const scope = scopeOf(source, 1);
    expect(scope.enclosing).toEqual([]);
    expect(describeLineScope(scope)).toBe("module scope (top level)");
    expect(isModuleScope(scope)).toBe(true);
  });

  it("orders nested constructs innermost first and reports scope depth", () => {
    const source = [
      "function positiveControlTotals() {",
      "  for (var i = 0; i < 10; i++) {",
      "    const total = i;",
      "  }",
      "}",
    ].join("\n");
    const scope = scopeOf(source, 3);
    expect(scope.enclosing.map((c) => c.kind)).toEqual(["for", "function"]);
    expect(scope.enclosing[0]?.openedAtLine).toBe(2);
    expect(scope.enclosing[1]?.openedAtLine).toBe(1);
    expect(describeLineScope(scope)).toBe(
      "inside for loop opened at line 2; inside function positiveControlTotals opened at line 1; module scope depth 2",
    );
  });
});

describe("analyzeScope: function labels and callee shapes", () => {
  it.each([
    [
      "an assignment to a plain variable",
      "let handler;\nhandler = function () {\n  const x = 1;\n};",
      "handler",
    ],
    ["a member assignment", "exports.run = function () {\n  const x = 1;\n};", "run"],
    [
      "a quoted object key",
      "const o = {\n  'quoted': function () {\n    const x = 1;\n  },\n};",
      "quoted",
    ],
    ["a class method", "class A {\n  run() {\n    const x = 1;\n  }\n}", "run"],
  ])("borrows the name of %s", (_what, source, label) => {
    expect(scopeOf(source, 3).enclosing[0]?.label).toBe(label);
  });

  it.each([
    ["a numeric object key", "const o = {\n  1: function () {\n    const x = 1;\n  },\n};"],
    ["a computed object key", "const o = {\n  [k]: function () {\n    const x = 1;\n  },\n};"],
    ["a computed member assignment", "o[k] = function () {\n  const x = 1;\n};"],
    ["a destructuring declarator", "const { length } = function () {\n  const x = 1;\n};"],
  ])("leaves a function bound to %s unlabeled", (_what, source) => {
    const line = source.split("\n").findIndex((text) => text.includes("const x")) + 1;
    const scope = scopeOf(source, line);
    expect(scope.enclosing[0]).toMatchObject({ kind: "function" });
    expect(scope.enclosing[0]?.label).toBeUndefined();
  });

  it.each([
    ["a computed callee", "items['forEach'](function () {\n  const x = 1;\n});"],
    ["a bare function callee", "run(function () {\n  const x = 1;\n});"],
    ["an IIFE", "(function () {\n  const x = 1;\n})();"],
  ])("does not treat a function passed through %s as an iteration callback", (_what, source) => {
    expect(scopeOf(source, 2).enclosing[0]?.kind).toBe("function");
  });
});

describe("describeLineScope: every construct kind", () => {
  it.each([
    ["for-in", "inside for...in loop opened at line 4"],
    ["for-of", "inside for...of loop opened at line 4"],
    ["while", "inside while loop opened at line 4"],
    ["do-while", "inside do...while loop opened at line 4"],
    ["iteration-callback", "inside callback passed to .? opened at line 4"],
    ["function", "inside an anonymous function opened at line 4"],
  ] as const)("describes %s", (kind, text) => {
    const scope: LineScope = {
      line: 5,
      enclosing: [{ kind, isLoop: false, openedAtLine: 4 }],
    };
    expect(describeLineScope(scope)).toBe(`${text}; module scope depth 1`);
  });
});

describe("isInsideLoop", () => {
  it("is false when a function boundary sits between the line and an outer loop", () => {
    // the const below sits in a callback; that callback happens to run once
    // per outer-loop iteration at runtime, but its own binding is fresh each
    // call, so Rhino's re-entered-block bug does not apply to it
    const source = [
      "function f() {",
      "  for (var i = 0; i < 10; i++) {",
      "    items.forEach(function (item) {",
      "      const x = item;",
      "    });",
      "  }",
      "}",
    ].join("\n");
    const scope = scopeOf(source, 4);
    expect(isInsideLoop(scope)).toBe(false);
  });

  it("is undefined-safe", () => {
    expect(isInsideLoop(undefined)).toBe(false);
  });
});

describe("isModuleScope", () => {
  it("stays true across a bare top-level loop (no function boundary crossed)", () => {
    const source = ["for (var i = 0; i < 10; i++) {", "  const x = i;", "}"].join("\n");
    const scope = scopeOf(source, 2);
    expect(isModuleScope(scope)).toBe(true);
  });

  it("is false once the line sits inside any function, matching a deferred require inside a route handler", () => {
    const source = [
      "server.replace(",
      "  'Show',",
      "  function (req, res, next) {",
      "    const deliveryUtil = require('*/scripts/order/deliveryUtil');",
      "  }",
      ");",
    ].join("\n");
    const scope = scopeOf(source, 4);
    expect(isModuleScope(scope)).toBe(false);
  });

  it("is undefined-safe", () => {
    expect(isModuleScope(undefined)).toBe(true);
  });
});

describe("analyzeScope: graceful degradation", () => {
  it("does not throw on unparseable source and reports parsed: false", () => {
    const analysis = analyzeScope("function f( { const x = ;;;", [1]);
    expect(analysis.parsed).toBe(false);
    expect(analysis.lines.size).toBe(0);
  });

  it("returns an empty result without parsing when no lines are requested", () => {
    const analysis = analyzeScope("function f() {}", []);
    expect(analysis.parsed).toBe(true);
    expect(analysis.lines.size).toBe(0);
  });
});

describe("scope context provider", () => {
  it("is named scope", () => {
    expect(createScopeProvider().name).toBe("scope");
  });

  it("emits terse facts only for changed JS lines, grouping consecutive same-scope lines", async () => {
    const repo = makeRepo();
    write(
      repo,
      "src/app.js",
      [
        "function addProducts(items) {",
        "  items.forEach(function (item) {",
        "    const a = item.a;",
        "    const b = item.b;",
        "  });",
        "}",
      ].join("\n"),
    );
    const diff = [
      "diff --git a/src/app.js b/src/app.js",
      "--- a/src/app.js",
      "+++ b/src/app.js",
      "@@ -1,6 +1,6 @@",
      " function addProducts(items) {",
      "   items.forEach(function (item) {",
      "+    const a = item.a;",
      "+    const b = item.b;",
      "   });",
      " }",
      "",
    ].join("\n");
    const text = await createScopeProvider().systemContext({
      cwd: repo,
      diff,
      changedFiles: ["src/app.js"],
    });
    expect(text).toContain("src/app.js:");
    expect(text).toContain("lines 3-4: inside callback passed to .forEach opened at line 2");
    expect(text).not.toContain("line 3:"); // collapsed into the range, not listed singly
  });

  it("splits ranges at gaps and at scope changes, listing single lines singly", async () => {
    const repo = makeRepo();
    write(
      repo,
      "src/app.js",
      ["const a = 1;", "function f() {", "  const b = 2;", "}", "const c = 3;"].join("\n"),
    );
    const diff = [
      "diff --git a/src/app.js b/src/app.js",
      "--- a/src/app.js",
      "+++ b/src/app.js",
      "@@ -0,0 +1,5 @@",
      "+const a = 1;",
      "+function f() {",
      "+  const b = 2;",
      " }",
      "+const c = 3;",
      "",
    ].join("\n");
    const text = await createScopeProvider().systemContext({
      cwd: repo,
      diff,
      changedFiles: ["src/app.js"],
    });
    expect(text).toContain("line 1: module scope (top level)");
    expect(text).toContain("lines 2-3: inside function f opened at line 2");
    expect(text).toContain("line 5: module scope (top level)");
  });

  it("skips deletion-only, oversized and vanished JS files without a notice", async () => {
    const repo = makeRepo();
    write(repo, "src/big.js", `const x = "${"a".repeat(600 * 1024)}";\n`);
    const header = (file: string): string[] => [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
    ];
    const diff = [
      ...header("src/gone.js"),
      "@@ -1,2 +1,1 @@",
      " const kept = 1;",
      "-const dropped = 2;",
      ...header("src/big.js"),
      "@@ -0,0 +1 @@",
      "+const x = 1;",
      ...header("src/missing.js"),
      "@@ -0,0 +1 @@",
      "+const y = 1;",
      "",
    ].join("\n");
    const provider = createScopeProvider();
    const text = await provider.systemContext({
      cwd: repo,
      diff,
      changedFiles: ["src/gone.js", "src/big.js", "src/missing.js"],
    });
    expect(text).toBe("");
    expect(provider.notices?.()).toEqual([]);
  });

  it("ignores non-JS changed files entirely", async () => {
    const repo = makeRepo();
    write(repo, "README.md", "# hello\n");
    const diff = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -0,0 +1 @@",
      "+# hello",
      "",
    ].join("\n");
    const text = await createScopeProvider().systemContext({
      cwd: repo,
      diff,
      changedFiles: ["README.md"],
    });
    expect(text).toBe("");
  });

  it("degrades gracefully on an unparseable changed file, with a single aggregated notice", async () => {
    const repo = makeRepo();
    write(repo, "src/broken.js", "function f( { const x = ;;;\n");
    const diff = [
      "diff --git a/src/broken.js b/src/broken.js",
      "--- a/src/broken.js",
      "+++ b/src/broken.js",
      "@@ -0,0 +1 @@",
      "+function f( { const x = ;;;",
      "",
    ].join("\n");
    const provider = createScopeProvider();
    const text = await provider.systemContext({
      cwd: repo,
      diff,
      changedFiles: ["src/broken.js"],
    });
    expect(text).toBe("");
    expect(provider.notices?.()).toEqual([
      "scope: 1 changed JS file(s) could not be parsed and were skipped",
    ]);
  });

  it("is selectable via DELTA_PEACOCK_CONTEXT_PROVIDER and combinable via the providers list", () => {
    const solo = loadConfig({ root: makeRepo(), env: { DELTA_PEACOCK_CONTEXT_PROVIDER: "scope" } });
    expect(activeStrategies(solo)).toEqual(["scope"]);
    expect(buildContextProvider(solo).name).toBe("scope");

    const layered = loadConfig({
      root: makeRepo(),
      env: { DELTA_PEACOCK_CONTEXT_PROVIDERS: "agentic,scope" },
    });
    expect(activeStrategies(layered)).toEqual(["agentic", "scope"]);
    expect(buildContextProvider(layered).name).toBe("agentic+scope");
  });
});
