/** Builds small .xlsx workbooks for the XLSX tests with Alisio's own ZIP writer. */
import { PassThrough } from "node:stream";
import { writeZip } from "../packages/core/src/runtime/zip.ts";

export type Cell =
  | string
  | number
  | boolean
  | null
  | { date: number }
  | { formula: string; value: number | string }
  | { inline: string };

export interface Sheet {
  name: string;
  rows: Cell[][];
}

const esc = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const column = (index: number) => {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
};

export async function buildXlsx(
  sheets: Sheet[],
  options: { date1904?: boolean; extraParts?: Array<{ name: string; data: Uint8Array }> } = {},
): Promise<Buffer> {
  const strings: string[] = [];
  const stringId = (text: string) => {
    let id = strings.indexOf(text);
    if (id < 0) {
      strings.push(text);
      id = strings.length - 1;
    }
    return id;
  };
  const sheetXml = sheets.map((sheet) => {
    const rows = sheet.rows
      .map((row, r) => {
        const cells = row
          .map((cell, c) => {
            const ref = `${column(c)}${r + 1}`;
            if (cell === null) return "";
            if (typeof cell === "string") return `<c r="${ref}" t="s"><v>${stringId(cell)}</v></c>`;
            if (typeof cell === "number") return `<c r="${ref}"><v>${cell}</v></c>`;
            if (typeof cell === "boolean") return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`;
            if ("date" in cell) return `<c r="${ref}" s="1"><v>${cell.date}</v></c>`;
            if ("inline" in cell)
              return `<c r="${ref}" t="inlineStr"><is><t>${esc(cell.inline)}</t></is></c>`;
            return typeof cell.value === "number"
              ? `<c r="${ref}"><f>${esc(cell.formula)}</f><v>${cell.value}</v></c>`
              : `<c r="${ref}" t="str"><f>${esc(cell.formula)}</f><v>${esc(cell.value)}</v></c>`;
          })
          .join("");
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join("");
    const width = Math.max(1, ...sheet.rows.map((row) => row.length));
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${column(width - 1)}${sheet.rows.length}"/><sheetData>${rows}</sheetData></worksheet>`;
  });
  const entries = [
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
      ),
    },
    {
      name: "xl/workbook.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr${options.date1904 ? ' date1904="1"' : ""}/><sheets>${sheets
          .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
          .join("")}</sheets></workbook>`,
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join("")}</Relationships>`,
      ),
    },
    {
      name: "xl/styles.xml",
      data: Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
      ),
    },
    ...sheetXml.map((xml, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: Buffer.from(xml),
    })),
    {
      name: "xl/sharedStrings.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings
          .map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`)
          .join("")}</sst>`,
      ),
    },
    ...(options.extraParts ?? []),
  ];
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on("data", (chunk: Buffer) => chunks.push(chunk));
  await writeZip(entries, sink);
  sink.end();
  return Buffer.concat(chunks);
}
