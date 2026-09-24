import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOURS = path.join(ROOT, ".tours");

interface Tour {
  title: string;
  steps: { file: string; pattern: string; description: string }[];
}

const tours = readdirSync(TOURS)
  .filter((name) => name.endsWith(".tour"))
  .map((name) => [name, JSON.parse(readFileSync(path.join(TOURS, name), "utf8")) as Tour] as const);

describe("code tours stay anchored to real code", () => {
  it("ships at least one tour", () => {
    expect(tours.length).toBeGreaterThan(0);
  });

  it.each(tours)("%s: every step's pattern matches exactly one line of its file", (_, tour) => {
    expect(tour.steps.length).toBeGreaterThan(0);
    for (const step of tour.steps) {
      const file = path.join(ROOT, step.file);
      expect(existsSync(file), step.file).toBe(true);
      const pattern = new RegExp(step.pattern);
      const hits = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => pattern.test(line));
      expect(hits, `${step.file}: ${step.pattern}`).toHaveLength(1);
      expect(step.description.length).toBeGreaterThan(0);
    }
  });
});
