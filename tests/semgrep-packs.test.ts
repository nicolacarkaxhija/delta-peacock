import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Guideline } from "../src/domain/guideline.js";
import { loadGuidelinesFromFiles } from "../src/guidelines/loader.js";
import { resolvePack } from "../src/guidelines/packs.js";
import { combinedRules } from "../src/review/semgrep/rules.js";
import { SEMGREP_PIN, semgrepRunner } from "../src/review/semgrep/run.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packsDir = path.join(repoRoot, "packs");
const lockPath = path.join(repoRoot, "tests", "fixtures", "semgrep-rules.lock.json");
const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Record<string, string>;

const packNames = readdirSync(packsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const ruleFilesOf = (pack: string): string[] =>
  readdirSync(path.join(packsDir, pack))
    .filter((name) => name.endsWith(".semgrep.yaml"))
    .sort();

/** One digest over a pack's rule files, names included, so a rename counts as a change. */
function digestOf(pack: string): string {
  const hash = createHash("sha256");
  for (const name of ruleFilesOf(pack)) {
    hash.update(`${name}\0${readFileSync(path.join(packsDir, pack, name), "utf8")}\0`);
  }
  return hash.digest("hex");
}

function shipped(): Guideline[] {
  return packNames.flatMap((name) => {
    const loaded = loadGuidelinesFromFiles(resolvePack(repoRoot, `packs/${name}`).files);
    expect(loaded.problems).toEqual([]);
    return loaded.guidelines.map((guideline) => ({ ...guideline, pack: name }));
  });
}

describe("the shipped semgrep rules", () => {
  it("change only with a new guideline set version", () => {
    const stale = packNames
      .filter((pack) => ruleFilesOf(pack).length > 0)
      .flatMap((pack) => {
        const version = resolvePack(repoRoot, `packs/${pack}`).manifest.version ?? "none";
        const key = `${pack}@${version}`;
        const digest = digestOf(pack);
        if (lock[key] === digest) return [];
        return lock[key] === undefined
          ? [
              `${key}: no lock entry; add "${key}": "${digest}" to tests/fixtures/semgrep-rules.lock.json`,
            ]
          : [
              `${key}: rules changed without a new guideline set version; bump the pack version and every rule's guidelines-version`,
            ];
      });
    expect(stale).toEqual([]);
  });

  it("carry the guideline set version of their pack", () => {
    const unversioned = shipped()
      .filter(
        (guideline) => guideline.check?.type === "semgrep" && guideline.check.version === undefined,
      )
      .map((guideline) => guideline.id);
    expect(unversioned).toEqual([]);
  });
});

/** The pinned binary scripts/semgrep-install.mjs puts in the cache, or the one a test run names. */
const command =
  process.env["DELTA_PEACOCK_TEST_SEMGREP"] ??
  path.join(repoRoot, ".delta-peacock-cache", "semgrep", SEMGREP_PIN, "osemgrep");

interface Row {
  guideline: string;
  file: string;
  source: string;
  /** The lines the rule flags; empty for the clean fixture. */
  lines: number[];
}

const ROWS: Row[] = [
  {
    guideline: "logger-assigned-once",
    file: "cartridges/app_shop_core/cartridge/scripts/giftPack.js",
    source: [
      "'use strict';",
      "function pack(id) {",
      "    require('dw/system/Logger').getLogger('giftPack', 'checkout').error('no pack {0}', id);",
      "    require('dw/system/Logger')",
      "        .getLogger('giftPack', 'checkout')",
      "        .warn('late pack {0}', id);",
      "}",
      "",
    ].join("\n"),
    lines: [3, 4],
  },
  {
    guideline: "logger-assigned-once",
    file: "cartridges/app_shop_core/cartridge/scripts/giftPack.js",
    source: [
      "'use strict';",
      "const logger = require('dw/system/Logger').getLogger('giftPack', 'checkout');",
      "function pack(id) {",
      "    logger.error('no pack {0}', id);",
      "}",
      "",
    ].join("\n"),
    lines: [],
  },
  {
    guideline: "no-new-cartridges",
    file: "cartridges/app_shop_gifts/cartridge/app_shop_gifts.properties",
    source: [
      "## cartridge.properties for cartridge app_shop_gifts",
      "demandware.cartridges.app_shop_gifts.multipleLanguageStorefront=true",
      "demandware.cartridges.app_shop_gifts.id=app_shop_gifts",
      "",
    ].join("\n"),
    lines: [3],
  },
  {
    guideline: "no-new-cartridges",
    file: "cartridges/app_shop_core/cartridge/app_shop_core.properties",
    source: "demandware.cartridges.app_shop_core.multipleLanguageStorefront=true\n",
    lines: [],
  },
  {
    guideline: "test-ids-on-page-objects",
    file: "tests/specs/notes.spec.ts",
    source: [
      'import { test } from "@playwright/test";',
      'test("adds a note", async ({ page }) => {',
      '  await page.getByTestId("notes-add").click();',
      "});",
      "",
    ].join("\n"),
    lines: [3],
  },
  {
    guideline: "test-ids-on-page-objects",
    file: "tests/pages/notes-page.ts",
    source: [
      'import type { Page } from "@playwright/test";',
      "export class NotesPage {",
      '  readonly add = this.page.getByTestId("notes-add");',
      "  constructor(private readonly page: Page) {}",
      "}",
      "",
    ].join("\n"),
    lines: [],
  },
];

describe.runIf(existsSync(command))(`the shipped rules on semgrep ${SEMGREP_PIN}`, () => {
  const byId = new Map(shipped().map((guideline) => [guideline.id, guideline]));
  for (const row of ROWS) {
    const label =
      row.lines.length > 0 ? `flags lines ${row.lines.join(", ")}` : "passes the clean form";
    it(`${row.guideline} ${label} of ${row.file}`, async () => {
      const guideline = byId.get(row.guideline);
      if (guideline === undefined) throw new Error(`no shipped guideline ${row.guideline}`);
      const run = await semgrepRunner({ command, timeoutMs: 60_000 })(
        combinedRules([guideline]).config,
        new Map([[row.file, row.source]]),
      );
      if (!run.ok) throw new Error(run.reason);
      expect(run.hits.map((hit) => hit.startLine)).toEqual(row.lines);
    });
  }
});
