export function escape(text) {
  return String(text).replace(/</g, "&lt;");
}
