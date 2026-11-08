/** System-prompt rule of the document tools (spec 026 D14, §5.10): at most 300 characters. */
export const DOCUMENT_RULE_MAX_CHARS = 300;

export function buildDocumentRule(input: { documents: boolean }): string {
  if (!input.documents) return "";
  const text = [
    "# Documents",
    "- Designed PDFs, printable documents, Markdown to PDF: `document_create` (call `document_themes` first). Write content only (Markdown or DocumentSpec), never HTML/CSS.",
    "- When an active plugin tool is made for the task (exams, theses), use it instead.",
  ].join("\n");
  return text.length <= DOCUMENT_RULE_MAX_CHARS ? text : text.slice(0, DOCUMENT_RULE_MAX_CHARS);
}
