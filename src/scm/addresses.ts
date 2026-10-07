/** A repository path for a web address; parentheses encoded so a Markdown link keeps its end. */
export function encodeFilePath(file: string): string {
  return encodeURI(file).replaceAll("(", "%28").replaceAll(")", "%29");
}
