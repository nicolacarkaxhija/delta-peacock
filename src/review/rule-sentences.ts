import type { Guideline } from "../domain/guideline.js";

/** A bullet or a number that opens a list item, at any indent, so a nested item stays an item. */
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d+[.)])(?:\s+|$)/;

/** A heading line; its hashes give its level. */
const HEADING = /^ {0,3}(#{1,6})(?:\s|$)/;

/** A line that opens or closes fenced code. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** A block quote line. */
const QUOTE = /^ {0,3}>/;

/** A line indented as code. */
const INDENTED = /^(?: {4,}|\t)/;

/** A thematic break: three or more of one of `-`, `*` or `_`, spaces allowed between. */
const BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/** These abbreviations never end a sentence. */
const INNER_ABBREVIATION = /\b(?:e\.g|i\.e|[Vv]s)\./g;

/** Ends a sentence only before a capital, a digit, a backtick or a quote; no case folding, which would let the capital check match any letter. */
const CLOSING_ABBREVIATION = /\b[Ee]tc\.(?!\s+[\p{Lu}\d`"'“‘])/gu;

/** Stands in for an abbreviation's dot while a block is split into sentences. */
const KEPT_DOT = "\u0000";

/** A sentence ends at `.`, `!` or `?` and any closing quotes or brackets after it, then a space. */
const SENTENCE_END = /(?<=[.!?]["'”’)\]]*)\s+/;

/** The words of an example label, with or without "example" or a parenthesis after them. */
const LABEL = String.raw`(?:good|bad|correct|incorrect|wrong|right|example|do|don['’]t)(?:\s+example)?\s*(?:\([^)]*\))?\s*`;

/** Text that opens with a label and a colon. */
const LABELLED = new RegExp(`^${LABEL}:`, "i");

/** Text that is a label and nothing more, with or without a colon. */
const LABEL_ONLY = new RegExp(`^${LABEL}:?$`, "i");

/** A block of the guideline body; a heading carries its level. */
interface Block {
  kind: "paragraph" | "item" | "heading";
  text: string;
  level?: number;
}

/** Spacing collapsed, emphasis and code marks dropped where they touch a word boundary, wrapping quotes gone. */
const plain = (text: string): string =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/(^|\s)[*_`]+/g, "$1")
    .replace(/[*_`]+(?=\s|$|[.,;:!?"')\]])/g, "")
    .replace(/^["'“‘]+|["'”’]+$/g, "")
    .trim();

/** A unit as a quote must match it: without a list marker or its closing marks and quotes. */
export const unitKey = (text: string): string =>
  plain(text.replace(LIST_ITEM, ""))
    .replace(/[.!?:;"'”’]+$/, "")
    .trim();

/** The body without its HTML comments, a comment\'s lines kept blank so blocks still end there. */
const withoutComments = (body: string): string =>
  body.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\n]/g, ""));

/** The blocks of a markdown body; fenced and indented code, block quotes and breaks yield none. */
export function blocksOf(body: string): Block[] {
  const blocks: Block[] = [];
  let open: Block | undefined;
  let fence: string | undefined;
  let quoted = false;
  // a list stays open across blank lines until another kind of block starts
  let listOpen = false;
  const close = (): void => {
    if (open !== undefined) blocks.push(open);
    open = undefined;
  };
  for (const line of withoutComments(body).split("\n")) {
    if (fence !== undefined) {
      const end = FENCE.exec(line)?.[1];
      if (end?.startsWith(fence.charAt(0)) === true && end.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    const opened = FENCE.exec(line)?.[1];
    if (opened !== undefined) {
      close();
      listOpen = false;
      fence = opened;
      continue;
    }
    if (line.trim() === "") {
      close();
      quoted = false;
      continue;
    }
    if (BREAK.test(line)) {
      close();
      quoted = false;
      listOpen = false;
      continue;
    }
    if (QUOTE.test(line) || quoted) {
      // a quote runs to the next blank line, lazy lines included
      close();
      quoted = true;
      listOpen = false;
      continue;
    }
    const heading = HEADING.exec(line)?.[1];
    if (heading !== undefined) {
      close();
      listOpen = false;
      blocks.push({
        kind: "heading",
        level: heading.length,
        text: line.replace(/^ {0,3}#{1,6}\s*/, "").replace(/\s#+\s*$/, ""),
      });
      continue;
    }
    // an indented marker line is a nested item under an item or in an open list, otherwise code or a wrap
    const nested = open?.kind === "item" || (open === undefined && listOpen);
    if (LIST_ITEM.test(line) && (!INDENTED.test(line) || nested)) {
      close();
      open = { kind: "item", text: line.trim() };
      listOpen = true;
      continue;
    }
    if (open !== undefined) {
      // a soft wrap continues the paragraph or the item it is in, whatever it starts with
      open.text = `${open.text} ${line.trim()}`;
      continue;
    }
    if (INDENTED.test(line)) continue;
    listOpen = false;
    open = { kind: "paragraph", text: line.trim() };
  }
  close();
  return blocks;
}

/** The sentences of a block, split where a sentence ends and never at an abbreviation inside one. */
function sentencesOf(text: string): string[] {
  return text
    .replace(INNER_ABBREVIATION, (match) => match.replaceAll(".", KEPT_DOT))
    .replace(CLOSING_ABBREVIATION, (match) => match.replaceAll(".", KEPT_DOT))
    .split(SENTENCE_END)
    .map((sentence) => sentence.replaceAll(KEPT_DOT, "."));
}

/** A block's text as a label check reads it: no list marker, no emphasis. */
const labelText = (text: string): string => plain(text.replace(LIST_ITEM, ""));

/** The units of one block: the sentences before the first that opens with a label and a colon. */
function unitsOf(block: Block): string[] {
  const sentences = sentencesOf(block.text);
  const label = sentences.findIndex(
    (sentence, index) =>
      LABELLED.test(labelText(sentence)) || (index === 0 && LABEL_ONLY.test(labelText(sentence))),
  );
  const kept = label === -1 ? sentences : sentences.slice(0, label);
  if (kept.length === 0) return [];
  return block.kind === "paragraph" ? kept : [kept.join(" ")];
}

/** The citable units of a guideline: its title, then each block's units, skipping what an example label covers. */
export function ruleUnits(guideline: Pick<Guideline, "title" | "body">): string[] {
  const units: string[] = [guideline.title];
  let section: number | undefined;
  let nextSkipped = false;
  for (const block of blocksOf(guideline.body)) {
    const level = block.level;
    if (section !== undefined && level !== undefined && level <= section) section = undefined;
    const labelOnly = LABEL_ONLY.test(labelText(block.text));
    if (labelOnly && level !== undefined) section = level;
    const skipped = section !== undefined || nextSkipped;
    // a block that is only a label covers the block after it
    nextSkipped = labelOnly && level === undefined;
    if (!skipped) units.push(...unitsOf(block));
  }
  return units.map(unitKey).filter((unit) => unit !== "");
}

/** True when the quote is a whole citable unit of the guideline and not one of its exclusion sentences. */
export function quotesRuleSentence(
  quote: string | undefined,
  guideline: Pick<Guideline, "title" | "body" | "exclusions">,
): boolean {
  if (quote === undefined) return false;
  const wanted = unitKey(quote);
  const excluded = new Set((guideline.exclusions ?? []).map(unitKey));
  return !excluded.has(wanted) && ruleUnits(guideline).includes(wanted);
}
