import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

interface Frame {
  kind: "{" | "[" | "(";
  /** Named object keys from the root to this frame; anonymous frames add none. */
  path: string[];
  keys: string[];
  /** Keys whose value is a plain string literal, with that string. */
  strings: Map<string, string>;
}

interface Scan {
  keys: Map<string, string[]>;
  strings: Map<string, Map<string, string>>;
}

const SAFE_KEY = /^[A-Za-z0-9_.:-]{1,60}$/;

/** Index just past a quoted string or template literal starting at `start`. */
function skipQuoted(text: string, start: number): number {
  const quote = text[start];
  for (let at = start + 1; at < text.length; at += 1) {
    if (text[at] === "\\") at += 1;
    else if (text[at] === quote) return at + 1;
  }
  return text.length;
}

/**
 * The keys of every object literal in a JS, TS or JSON config, by the dotted
 * path of named keys leading to it. The file is read as text and never run.
 */
export function objectKeysByPath(source: string): Map<string, string[]> {
  return scanObjects(source).keys;
}

/** Every object literal's keys, and the keys holding a plain string, by dotted path. */
function scanObjects(source: string): Scan {
  const found = new Map<string, string[]>();
  const strings = new Map<string, Map<string, string>>();
  const stack: Frame[] = [{ kind: "(", path: [], keys: [], strings: new Map() }];
  // the last token, and whether a key may start here (after `{` or `,`)
  let keyPosition = false;
  let candidate: string | undefined;
  let pendingKey: string | undefined;
  let at = 0;
  const close = () => {
    const frame = stack.pop();
    if (frame?.kind === "{" && frame.path.length > 0) {
      const dotted = frame.path.join(".");
      found.set(dotted, [...(found.get(dotted) ?? []), ...frame.keys]);
      strings.set(dotted, new Map([...(strings.get(dotted) ?? []), ...frame.strings]));
    }
  };
  while (at < source.length) {
    const char = source.charAt(at);
    const next = source.charAt(at + 1);
    if (/\s/.test(char)) {
      at += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", at);
      at = end === -1 ? source.length : end;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", at + 2);
      at = end === -1 ? source.length : end + 2;
      continue;
    }
    const top = stack.at(-1);
    if (char === "'" || char === '"' || char === "`") {
      const end = skipQuoted(source, at);
      // a string right after `key:` is that key's value
      if (pendingKey !== undefined && top?.kind === "{" && char !== "`") {
        top.strings.set(pendingKey, source.slice(at + 1, end - 1));
      }
      candidate = keyPosition && char !== "`" ? source.slice(at + 1, end - 1) : undefined;
      keyPosition = false;
      pendingKey = undefined;
      at = end;
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(at, at + 80))?.[0];
    if (word !== undefined) {
      candidate = keyPosition ? word : undefined;
      keyPosition = false;
      pendingKey = undefined;
      at += word.length;
      continue;
    }
    if (char === ":" && candidate !== undefined && top?.kind === "{") {
      top.keys.push(candidate);
      pendingKey = candidate;
      candidate = undefined;
      at += 1;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      const parent = stack.at(-1)?.path ?? [];
      const named = char === "{" && pendingKey !== undefined ? [...parent, pendingKey] : parent;
      stack.push({ kind: char, path: named, keys: [], strings: new Map() });
      keyPosition = char === "{";
    } else if (char === "}" || char === "]" || char === ")") {
      if (stack.length > 1) close();
      keyPosition = false;
    } else {
      keyPosition = char === "," && stack.at(-1)?.kind === "{";
    }
    candidate = undefined;
    pendingKey = undefined;
    at += 1;
  }
  while (stack.length > 1) close();
  return { keys: found, strings };
}

/** The string values under every path whose tail is `pattern`, by key. */
function stringsAt(scan: Scan, pattern: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const [dotted, map] of scan.strings) {
    if (dotted === pattern || dotted.endsWith(`.${pattern}`)) {
      for (const [key, value] of map) if (SAFE_KEY.test(key)) values.set(key, value);
    }
  }
  return values;
}

/** Keys under every path whose tail matches `pattern`; `*` stands for any one key. */
export function keysAt(index: ReadonlyMap<string, string[]>, pattern: string): string[] {
  const wanted = pattern.split(".");
  const keys = new Set<string>();
  for (const [dotted, list] of index) {
    const segments = dotted.split(".");
    if (segments.length < wanted.length) continue;
    const tail = segments.slice(segments.length - wanted.length);
    if (tail.every((segment, index_) => wanted[index_] === "*" || wanted[index_] === segment)) {
      for (const key of list) if (SAFE_KEY.test(key)) keys.add(key);
    }
  }
  return [...keys];
}

export interface DeclaredTags {
  /** The config file they came from, repository relative. */
  source: string;
  features: string[];
  axis: string[];
  /** What each feature tag covers, as the config describes it; absent when it says nothing. */
  descriptions?: Record<string, string>;
}

/** Axis name in a tag, and the config path whose keys are its values. */
const AXES: readonly [string, string][] = [
  ["site", "sites"],
  ["env", "environments"],
  ["device", "devices"],
  ["locale", "sites.*.locales"],
];

/**
 * The tags a test-runner suite declares: `tags.features` keys as feature tags,
 * and `@<axis>:<value>` plus `@not-<axis>:<value>` for every site, environment,
 * device and locale. Undefined when the file is absent or declares none.
 */
export function declaredTags(source: string, file: string): DeclaredTags | undefined {
  const scan = scanObjects(source);
  const index = scan.keys;
  const features = keysAt(index, "tags.features").map((key) => `@${key}`);
  const axis = AXES.flatMap(([name, keyPath]) =>
    keysAt(index, keyPath).flatMap((value) => [`@${name}:${value}`, `@not-${name}:${value}`]),
  );
  if (keysAt(index, "sites.*.locales").length > 0) axis.push("@locales");
  if (features.length === 0 && axis.length === 0) return undefined;
  const described = [...stringsAt(scan, "tags.features")].filter(([key]) =>
    features.includes(`@${key}`),
  );
  return {
    source: file,
    features,
    axis,
    ...(described.length > 0
      ? { descriptions: Object.fromEntries(described.map(([key, text]) => [`@${key}`, text])) }
      : {}),
  };
}

/** Reads the reviewed repository's own config; undefined when there is none. */
export function readDeclaredTags(cwd: string, file: string): DeclaredTags | undefined {
  if (file === "") return undefined;
  const full = path.resolve(cwd, file);
  if (!existsSync(full)) return undefined;
  try {
    return declaredTags(readFileSync(full, "utf8"), file);
  } catch {
    return undefined;
  }
}

/**
 * The prompt block naming the only tags a suggestion may use, each feature with
 * what it covers: without that, a model offered any declared tag as the fit.
 */
export function declaredTagsBlock(tags: DeclaredTags): string {
  const descriptions = tags.descriptions ?? {};
  const features =
    tags.features.length === 0
      ? ["Feature tags: none"]
      : [
          "Feature tags, each with what it covers:",
          ...tags.features.map((tag) => {
            const text = descriptions[tag];
            return text !== undefined ? `- ${tag}: ${text}` : `- ${tag}`;
          }),
        ];
  return [
    `## Tags declared in ${tags.source}`,
    "",
    ...features,
    `Axis tags: ${tags.axis.length > 0 ? tags.axis.join(", ") : "none"}`,
    "No other tag exists in this repository: never suggest one, and a test that fits none of the feature tags owes none.",
    "A finding about a missing feature tag names the one declared tag whose description covers what the test checks; when no description covers it, there is no finding. Never offer a list of candidate tags.",
    "A tag covers a test when its description names the feature the test asserts on; a page the test only opens on the way does not make that page's tag fit.",
  ].join("\n");
}
