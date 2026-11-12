/**
 * A plugin error message made safe to show: absolute paths (POSIX, Windows, `file://` URLs and
 * the home directory) become `<path>`, control characters and line breaks become spaces, and the
 * text is bounded. JSON pointers such as `#/properties/x` and plain words are kept, so the reason
 * (for example an Ajv strict-mode message) stays readable for the person and the creator agent.
 */
import { homedir } from "node:os";

export const PLUGIN_DIAGNOSTIC_CHARS = 500;

export function sanitizePluginDiagnostic(message: string, max = PLUGIN_DIAGNOSTIC_CHARS): string {
  let text = String(message);
  const home = homedir();
  if (home && home.length > 1) text = text.split(home).join("<path>");
  text = text
    .replace(/file:\/\/\/?[^\s"'`)]+/g, "<path>")
    .replace(/(^|[\s"'`(=,[])[A-Za-z]:\\[^\s"'`)]*/g, "$1<path>")
    .replace(/(^|[\s"'`(=,[])\/(?!\/)[^\s"'`)]*/g, "$1<path>")
    .replace(/<path>[^\s"'`)]*/g, "<path>")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
