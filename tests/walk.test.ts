import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SKIP_DIRS, walkFiles } from "../src/util/walk.js";
import { write } from "./helpers/git.js";

function tree(): string {
  const root = mkdtempSync(path.join(tmpdir(), "peacock-walk-"));
  write(root, "a/one.js", "1");
  write(root, "a/two.js", "2");
  write(root, "b/three.md", "3");
  write(root, ".hidden/four.js", "4");
  write(root, "node_modules/five.js", "5");
  return root;
}

function names(files: string[], root: string): string[] {
  return files.map((file) => path.relative(root, file).replaceAll("\\", "/")).sort();
}

describe("walkFiles", () => {
  it("skips dotdirs and skip-dirs and honors the include filter", () => {
    const root = tree();
    expect(names(walkFiles(root, { skipDirs: DEFAULT_SKIP_DIRS }), root)).toEqual([
      "a/one.js",
      "a/two.js",
      "b/three.md",
    ]);
    const onlyJs = walkFiles(root, {
      skipDirs: DEFAULT_SKIP_DIRS,
      include: (entry) => entry.name.endsWith(".js"),
    });
    expect(names(onlyJs, root)).toEqual(["a/one.js", "a/two.js"]);
  });

  it("stops at the file ceiling, even a ceiling of zero", () => {
    const root = tree();
    expect(walkFiles(root, { skipDirs: DEFAULT_SKIP_DIRS, maxFiles: 1 })).toHaveLength(1);
    expect(walkFiles(root, { skipDirs: DEFAULT_SKIP_DIRS, maxFiles: 0 })).toEqual([]);
  });

  it("treats an unlistable directory as empty unless told to throw", () => {
    const missing = path.join(tree(), "missing");
    expect(walkFiles(missing, { skipDirs: DEFAULT_SKIP_DIRS })).toEqual([]);
    expect(() =>
      walkFiles(missing, { skipDirs: DEFAULT_SKIP_DIRS, onReaddirError: "throw" }),
    ).toThrow(/ENOENT/);
  });
});
