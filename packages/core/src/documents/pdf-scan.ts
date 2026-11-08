/**
 * Minimal dependency-free PDF scanner (spec 026 D-25): page count, embedded font names, tagging,
 * outline, named destinations, links and per-page text-operator counts. Handles classic xref,
 * XRef streams, object streams and Flate with PNG predictors (Skia and pydyf output). Node zlib only.
 */
// @ts-nocheck (compact scanner kept close to the verified Phase 0 prototype; typed at its boundary)
import { inflateSync } from "node:zlib";

class Ref {
  n: number;
  g: number;
  constructor(n: number, g: number) {
    this.n = n;
    this.g = g;
  }
}
class Name {
  s: string;
  constructor(s: string) {
    this.s = s;
  }
}
const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = "()<>[]{}/%";
export class Pdf {
  [k: string]: any;
  static Sub: any;
  constructor(buf: Buffer) {
    this.b = buf;
    this.s = buf.toString("latin1");
    this.xref = new Map();
    this.cache = new Map();
    this.os = new Map();
    this.trailer = null;
    this.readXref();
  }
  skip(i: any): any {
    const s = this.s;
    for (;;) {
      const c = s.charCodeAt(i);
      if (WS.has(c)) i++;
      else if (c === 37) {
        while (i < s.length && s[i] !== "\n" && s[i] !== "\r") i++;
      } else return i;
    }
  }
  val(i: any): any {
    const s = this.s;
    i = this.skip(i);
    const c = s[i];
    if (s.startsWith("<<", i)) {
      const d = {};
      i += 2;
      for (;;) {
        i = this.skip(i);
        if (s.startsWith(">>", i)) return [d, i + 2];
        const [k, j] = this.val(i);
        const [v, j2] = this.val(j);
        d[k.s] = v;
        i = j2;
      }
    }
    if (c === "[") {
      const a = [];
      i++;
      for (;;) {
        i = this.skip(i);
        if (s[i] === "]") return [a, i + 1];
        const [v, j] = this.val(i);
        a.push(v);
        i = j;
      }
    }
    if (c === "/") {
      let j = i + 1;
      while (j < s.length && !WS.has(s.charCodeAt(j)) && !DELIM.includes(s[j])) j++;
      return [
        new Name(
          s
            .slice(i + 1, j)
            .replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))),
        ),
        j,
      ];
    }
    if (c === "(") {
      let depth = 1,
        j = i + 1,
        out = "";
      while (depth) {
        const ch = s[j++];
        if (ch === "\\") {
          const n = s[j++];
          if (n === "n") out += "\n";
          else if (n === "r") out += "\r";
          else if (n === "t") out += "\t";
          else if (/[0-7]/.test(n)) {
            let o = n;
            while (o.length < 3 && /[0-7]/.test(s[j])) o += s[j++];
            out += String.fromCharCode(parseInt(o, 8));
          } else if (n !== "\n" && n !== "\r") out += n;
        } else if (ch === "(") {
          depth++;
          out += ch;
        } else if (ch === ")") {
          if (--depth) out += ch;
        } else out += ch;
      }
      return [out, j];
    }
    if (c === "<") {
      const j = s.indexOf(">", i);
      return [
        Buffer.from(
          s
            .slice(i + 1, j)
            .replace(/\s/g, "")
            .padEnd(2 * Math.ceil((j - i - 1) / 2), "0"),
          "hex",
        ).toString("latin1"),
        j + 1,
      ];
    }
    const m = /^(?:(\d+)\s+(\d+)\s+R(?![\w])|([+-]?\d*\.?\d+)|(true|false|null))/.exec(
      s.slice(i, i + 40),
    );
    if (!m) throw new Error("parse error at " + i + ": " + s.slice(i, i + 20));
    if (m[1] !== undefined) return [new Ref(+m[1], +m[2]), i + m[0].length];
    if (m[3] !== undefined) return [parseFloat(m[3]), i + m[0].length];
    return [m[4] === "true" ? true : m[4] === "false" ? false : null, i + m[0].length];
  }
  readXref(): void {
    let i = this.s.lastIndexOf("startxref");
    if (i < 0) throw new Error("no startxref");
    let off = parseInt(this.s.slice(i + 9, i + 40).trim(), 10);
    const seen = new Set();
    while (off != null && !seen.has(off)) {
      seen.add(off);
      let p = this.skip(off);
      if (this.s.startsWith("xref", p)) {
        p = this.skip(p + 4);
        for (;;) {
          const m = /^(\d+)\s+(\d+)\s*/.exec(this.s.slice(p, p + 40));
          if (!m) break;
          p += m[0].length;
          let first = +m[1];
          for (let k = 0; k < +m[2]; k++, p += 20) {
            const e = /^(\d{10}) (\d{5}) ([nf])/.exec(this.s.slice(p, p + 20));
            if (e && e[3] === "n" && !this.xref.has(first + k))
              this.xref.set(first + k, { t: 1, off: +e[1] });
          }
          p = this.skip(p);
          if (this.s.startsWith("trailer", p)) break;
        }
        const [tr] = this.val(p + 7);
        this.trailer ??= tr;
        off = tr.Prev;
        if (tr.XRefStm) this.readXrefStream(tr.XRefStm);
      } else {
        const tr = this.readXrefStream(off);
        this.trailer ??= tr;
        off = tr.Prev;
      }
    }
  }
  readXrefStream(off: any): any {
    const o = this.objAt(off);
    const d = o.dict;
    const data = this.streamData(o);
    const [w0, w1, w2] = d.W;
    const idx = d.Index ?? [0, d.Size];
    let p = 0;
    for (let k = 0; k < idx.length; k += 2)
      for (let n = 0; n < idx[k + 1]; n++) {
        const rd = (w) => {
          let v = 0;
          for (let q = 0; q < w; q++) v = v * 256 + data[p++];
          return v;
        };
        const t = w0 ? rd(w0) : 1,
          a = rd(w1),
          b2 = rd(w2);
        const num = idx[k] + n;
        if (!this.xref.has(num)) {
          if (t === 1) this.xref.set(num, { t: 1, off: a });
          else if (t === 2) this.xref.set(num, { t: 2, stm: a, idx: b2 });
        }
      }
    return d;
  }
  objAt(off: any): any {
    const m = /^(\d+)\s+(\d+)\s+obj/.exec(this.s.slice(off, off + 30));
    let [v, j] = this.val(off + m[0].length);
    const o = { num: +m[1], value: v, dict: v };
    j = this.skip(j);
    if (this.s.startsWith("stream", j)) {
      j += 6;
      if (this.s[j] === "\r") j++;
      if (this.s[j] === "\n") j++;
      o.streamStart = j;
    }
    return o;
  }
  streamData(o: any): any {
    const len = this.deref(o.dict.Length);
    let raw = this.b.subarray(o.streamStart, o.streamStart + len);
    const f = this.deref(o.dict.Filter);
    const filters = f == null ? [] : Array.isArray(f) ? f.map((x) => this.deref(x).s) : [f.s];
    for (const fl of filters) {
      if (fl === "FlateDecode") {
        raw = inflateSync(raw);
        const dp = this.deref(o.dict.DecodeParms);
        if (dp && dp.Predictor >= 10) {
          const cols = dp.Columns ?? 1,
            rowLen = cols + 1,
            rows = raw.length / rowLen,
            out = Buffer.alloc(rows * cols);
          for (let r = 0; r < rows; r++) {
            const ft = raw[r * rowLen];
            for (let c = 0; c < cols; c++) {
              const x = raw[r * rowLen + 1 + c],
                a = c ? out[r * cols + c - 1] : 0,
                up = r ? out[(r - 1) * cols + c] : 0;
              out[r * cols + c] =
                ft === 0
                  ? x
                  : ft === 1
                    ? (x + a) & 255
                    : ft === 2
                      ? (x + up) & 255
                      : (x + ((a + up) >> 1)) & 255;
            }
          }
          raw = out;
        }
      } else throw new Error("unsupported filter " + fl);
    }
    return raw;
  }
  get(n: any): any {
    if (this.cache.has(n)) return this.cache.get(n);
    const e = this.xref.get(n);
    if (!e) return null;
    let o;
    if (e.t === 1) o = this.objAt(e.off);
    else {
      let st = this.os.get(e.stm);
      if (!st) {
        const so = this.objAt(this.xref.get(e.stm).off);
        const data = this.streamData(so).toString("latin1");
        const N = so.dict.N,
          first = so.dict.First;
        const hdr = data.slice(0, first).trim().split(/\s+/).map(Number);
        st = { data, first, pairs: [] };
        for (let k = 0; k < N; k++) st.pairs.push([hdr[2 * k], hdr[2 * k + 1]]);
        this.os.set(e.stm, st);
      }
      const [, ofs] = st.pairs[e.idx];
      const sub = new Pdf.Sub(st.data, st.first + ofs, this);
      const [v] = sub.val(st.first + ofs);
      o = { num: n, value: v, dict: v };
    }
    this.cache.set(n, o);
    return o;
  }
  deref(v: any): any {
    let k = 0;
    while (v instanceof Ref && k++ < 20) {
      const o = this.get(v.n);
      v = o ? o.value : null;
    }
    return v;
  }
  dict(v: any): any {
    return this.deref(v);
  }
}
Pdf.Sub = class {
  [k: string]: any;
  constructor(str: string, _pos: number, pdf: any) {
    this.s = str;
    this.skip = pdf.skip;
    this.val = pdf.val;
  }
};
Pdf.Sub.prototype.skip = Pdf.prototype.skip;
Pdf.Sub.prototype.val = Pdf.prototype.val;
const text16 = (s: any) =>
  typeof s === "string"
    ? s.startsWith("\xfe\xff")
      ? Buffer.from(s.slice(2), "latin1").swap16().toString("utf16le")
      : s
    : "";
export interface PdfScan {
  pages: number;
  tagged: boolean;
  outline: Array<{ depth: number; title: string; page?: number | undefined }>;
  links: Array<{ from: number; name?: string | undefined; page?: number | undefined }>;
  fonts: Array<{ name: string; subtype?: string | undefined; embedded: boolean }>;
  textOpsPerPage: number[];
  producer?: string | undefined;
  destinations: number;
}

export function scan(buf: Buffer): PdfScan {
  const pdf = new Pdf(buf);
  const root = pdf.deref(pdf.trailer.Root);
  const pages = [];
  const objToPage = new Map();
  (function walk(ref, inh) {
    const n = pdf.deref(ref);
    const res = n.Resources ?? inh;
    if (n.Type?.s === "Pages" || n.Kids) for (const k of n.Kids) walk(k, res);
    else {
      objToPage.set(ref.n, pages.length);
      pages.push({ dict: n, res: pdf.deref(res) });
    }
  })(root.Pages, null);
  const fonts = new Map();
  const pageInfo = pages.map((p) => {
    const fd = pdf.deref(p.res?.Font) ?? {};
    for (const f of Object.values(fd)) {
      const fo = pdf.deref(f);
      const name = fo.BaseFont?.s ?? "(none)";
      const desc = pdf.deref(fo.FontDescriptor);
      const kids = pdf.deref(fo.DescendantFonts);
      const d2 = kids ? pdf.deref(kids[0]) : null;
      fonts.set(name.replace(/^[A-Z]{6}\+/, ""), {
        subtype: fo.Subtype?.s,
        embedded:
          !!(
            desc?.FontFile ||
            desc?.FontFile2 ||
            desc?.FontFile3 ||
            (d2 && pdf.deref(d2.FontDescriptor)?.FontFile2)
          ) || fo.Subtype?.s === "Type3",
      });
    }
    const c = pdf.deref(p.dict.Contents);
    const arr = Array.isArray(c) ? c : [p.dict.Contents];
    let textOps = 0;
    for (const r of arr) {
      const o = r instanceof Ref ? pdf.get(r.n) : null;
      if (!o?.streamStart) continue;
      const cs = pdf.streamData(o).toString("latin1");
      textOps += (cs.match(/\](?=\s*TJ)|\)\s*Tj|>\s*Tj|\bTJ\b/g) || []).length;
    }
    return { textOps };
  });
  const dests = new Map();
  const addDest = (name, v) => {
    v = pdf.deref(v);
    if (v && !Array.isArray(v) && v.D) v = pdf.deref(v.D);
    if (Array.isArray(v) && v[0] instanceof Ref && objToPage.has(v[0].n))
      dests.set(name, objToPage.get(v[0].n) + 1);
  };
  const dd = pdf.deref(root.Dests);
  if (dd) for (const [k, v] of Object.entries(dd)) addDest(k, v);
  const nt = pdf.deref(root.Names)?.Dests;
  if (nt)
    (function w(n) {
      n = pdf.deref(n);
      for (let i = 0; n.Names && i < n.Names.length; i += 2) addDest(n.Names[i], n.Names[i + 1]);
      for (const k of n.Kids ?? []) w(k);
    })(nt);
  const links = [];
  pages.forEach((p, i) => {
    for (const a of pdf.deref(p.dict.Annots) ?? []) {
      const ao = pdf.deref(a);
      if (ao.Subtype?.s !== "Link") continue;
      let d = ao.Dest ?? pdf.deref(ao.A)?.D;
      if (d == null) continue;
      d = pdf.deref(d);
      const name = typeof d === "string" ? d : d?.s;
      links.push({
        from: i + 1,
        name,
        page: name
          ? dests.get(name)
          : Array.isArray(d) && d[0] instanceof Ref
            ? objToPage.get(d[0].n) + 1
            : undefined,
      });
    }
  });
  const outline = [];
  const ol = pdf.deref(root.Outlines);
  if (ol?.First)
    (function w(ref, depth) {
      while (ref) {
        const n = pdf.deref(ref);
        let d = pdf.deref(n.Dest);
        const nm = typeof d === "string" ? d : d?.s;
        if (nm) d = dests.get(nm);
        else if (Array.isArray(d) && d[0] instanceof Ref) d = objToPage.get(d[0].n) + 1;
        outline.push({
          depth,
          title: text16(n.Title),
          page: typeof d === "number" ? d : undefined,
        });
        if (n.First) w(n.First, depth + 1);
        ref = n.Next;
      }
    })(ol.First, 0);
  return {
    pages: pages.length,
    tagged: !!root.StructTreeRoot,
    outline,
    destinations: dests.size,
    links,
    fonts: [...fonts].map(([name, f]) => ({ name, ...f })),
    textOpsPerPage: pageInfo.map((p) => p.textOps),
    producer: pdf.deref(pdf.trailer.Info)?.Producer,
  };
}

const BUNDLED = ["inter", "sourceserif4", "jetbrainsmono"];
const flat = (name: string) =>
  name
    .replace(/^[A-Z]{6}\+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** True when an embedded font name belongs to a bundled family (D10); subset prefix stripped. */
export const isBundledFontName = (name: string): boolean =>
  BUNDLED.some((family) => flat(name).startsWith(family));
