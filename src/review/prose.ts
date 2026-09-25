/** Openers that restate the citation instead of saying something. */
const FILLER =
  /^(?:according to|as per|per|based on|as stated in|in line with)\s+(?:the\s+|this\s+)?(?:team's\s+)?(?:guidelines?|rules?)(?:\s+[`'"]?[\w.-]+[`'"]?)?\s*[,:]\s*/i;

const DASH = /\s*(?:—|–|\s--\s|\s-\s)\s*/g;

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** Outside code spans only, so `a - b` in quoted code survives. */
function outsideCode(text: string, rewrite: (plain: string) => string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part) => (part.startsWith("`") && part.endsWith("`") ? part : rewrite(part)))
    .join("");
}

/** A finding title: no dash as punctuation, no trailing guideline id after one. */
export function plainTitle(title: string, guidelineId?: string): string {
  let text = title.trim();
  if (guidelineId !== undefined) {
    const escaped = guidelineId.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
    text = text.replace(new RegExp(`\\s*(?:—|–|--|-|:|\\()\\s*\`?${escaped}\`?\\)?$`), "");
  }
  text = text.replace(FILLER, "");
  return capitalize(outsideCode(text, (plain) => plain.replace(DASH, ": ")).trim());
}

/** A finding body: no citation preamble, no dash as punctuation. */
export function plainBody(body: string): string {
  const text = body.trim().replace(FILLER, "");
  return capitalize(outsideCode(text, (plain) => plain.replace(DASH, ", ")));
}
