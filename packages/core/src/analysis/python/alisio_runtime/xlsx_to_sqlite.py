"""Converts an .xlsx workbook into Alisio's dataset SQLite file (standard library only).

Usage: python -m alisio_runtime.xlsx_to_sqlite INPUT.xlsx OUTPUT.sqlite
           [--max-rows N] [--max-columns N] [--max-cell-chars N]

Writes one table ``s_<sheet>`` per worksheet plus ``_alisio_sheets`` and ``_alisio_columns``
(name and label only: Alisio's host computes types and statistics afterwards, so the result is
identical to a CSV export of the same sheet). Cell values follow the same lossless rules as the
Node ingestion: a cell becomes a number only when its text is a plain number (no leading zeros or
separators, safe integer range); everything else keeps its exact text. Dates become ISO 8601
text, booleans ``TRUE``/``FALSE``, formulas keep their cached value, merged cells keep the value
of their top-left cell. Rows with no values are skipped. Errors exit with status 2 and one line
``alisio-xlsx: <reason>`` on stderr.
"""

import math
import re
import sqlite3
import sys
import unicodedata
import zipfile
from datetime import datetime, timedelta
from xml.etree import ElementTree as ET

MAX_UNCOMPRESSED = 1024 * 1024 * 1024  # 1 GiB
MAX_RATIO = 100  # uncompressed : compressed
BATCH_ROWS = 5000
RESERVED = ("rowid", "oid", "_rowid_")

_NUMBER = re.compile(r"-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?")
_INTEGER = re.compile(r"-?(?:0|[1-9]\d*)")
_REF = re.compile(r"([A-Z]+)(\d+)")
_DIMENSION = re.compile(r"^[A-Z]+\d+:([A-Z]+)\d+$")

META_SCHEMA = """
CREATE TABLE IF NOT EXISTS _alisio_meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS _alisio_sheets(ordinal INTEGER PRIMARY KEY, name TEXT NOT NULL,
  table_name TEXT NOT NULL, rows INTEGER NOT NULL, columns INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS _alisio_columns(table_name TEXT NOT NULL, ordinal INTEGER NOT NULL,
  name TEXT NOT NULL, label TEXT NOT NULL, inferred_type TEXT NOT NULL,
  nulls INTEGER, distinct_count INTEGER, distinct_exact INTEGER,
  min TEXT, max TEXT, mean REAL, text_fallbacks INTEGER, top_values TEXT,
  PRIMARY KEY(table_name, ordinal));
"""


class XlsxError(Exception):
    """A problem with the workbook that the user can understand."""


def convert_text(text):
    """The lossless cell conversion shared with the Node ingestion (see infer.ts)."""
    if text == "":
        return None
    if _NUMBER.fullmatch(text) is None:
        return text
    if _INTEGER.fullmatch(text) is not None:
        if text == "-0":
            return text
        n = int(text)
        return n if abs(n) <= 9007199254740991 else text
    value = float(text)
    return value if math.isfinite(value) else text


def sanitize(label, fallback):
    text = unicodedata.normalize("NFKD", label)
    text = "".join(c for c in text if not "̀" <= c <= "ͯ").lower()
    text = re.sub(r"[^a-z0-9]+", "_", text).strip("_")[:48]
    if not text:
        return fallback
    return "_" + text if text[0].isdigit() else text


def unique(name, taken):
    candidate, n = name, 2
    while candidate in taken:
        candidate = f"{name}_{n}"
        n += 1
    taken.add(candidate)
    return candidate


def looks_like_data(cells):
    non_empty = [c for c in cells if c is not None and c != ""]
    return bool(non_empty) and all(_NUMBER.fullmatch(c) is not None for c in non_empty)


def _local(tag):
    return tag.rsplit("}", 1)[-1]


def _column_index(letters):
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n - 1


class _Budget:
    """Counts the bytes read from the archive (headers can lie about their sizes)."""

    def __init__(self, limit):
        self.left = limit

    def wrap(self, handle):
        budget = self

        class Reader:
            def read(self, size=-1):
                data = handle.read(size)
                budget.left -= len(data)
                if budget.left < 0:
                    raise XlsxError("The workbook expands to more than 1 GiB (possible zip bomb)")
                return data

        return Reader()


def _open_xml(archive, name, budget):
    handle = archive.open(name)
    head = handle.read(2048)
    if b"<!DOCTYPE" in head or b"<!ENTITY" in head:
        raise XlsxError(f"{name} declares a DOCTYPE or entities, which are not supported")
    handle.close()
    return budget.wrap(archive.open(name))


def _shared_strings(archive, budget):
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    strings = []
    for _, elem in ET.iterparse(_open_xml(archive, "xl/sharedStrings.xml", budget)):
        if _local(elem.tag) == "si":
            parts = []
            for child in elem:
                tag = _local(child.tag)
                if tag == "t":
                    parts.append(child.text or "")
                elif tag == "r":
                    # Rich text runs; phonetic runs (rPh) hold furigana, not the cell text.
                    parts.extend(t.text or "" for t in child if _local(t.tag) == "t")
            strings.append("".join(parts))
            elem.clear()
    return strings


_BUILTIN_DATE_IDS = set(range(14, 23)) | {27, 28, 29, 30, 31, 32, 33, 34, 35, 36} | {45, 46, 47}
_BUILTIN_DATE_IDS |= set(range(50, 59))


def _is_date_format(code):
    lowered = code.lower()
    if lowered in ("general", "standard"):
        return False
    stripped = re.sub(r'"[^"]*"|\\.|_.|\*.|\[[^\]]*\]', "", lowered)
    return re.search(r"[dmyhs]", stripped) is not None


def _date_styles(archive, budget):
    """Indexes of cell styles (`s`) that format their number as a date or time."""
    if "xl/styles.xml" not in archive.namelist():
        return set()
    custom = {}
    xfs = []
    in_xfs = False
    for event, elem in ET.iterparse(_open_xml(archive, "xl/styles.xml", budget), events=("start", "end")):
        name = _local(elem.tag)
        if event == "start" and name == "cellXfs":
            in_xfs = True
        elif event == "end" and name == "cellXfs":
            in_xfs = False
        elif event == "end" and name == "numFmt":
            custom[int(elem.get("numFmtId", "0"))] = elem.get("formatCode", "")
        elif event == "end" and name == "xf" and in_xfs:
            xfs.append(int(elem.get("numFmtId", "0")))
    result = set()
    for index, fmt in enumerate(xfs):
        if fmt in custom:
            if _is_date_format(custom[fmt]):
                result.add(index)
        elif fmt in _BUILTIN_DATE_IDS:
            result.add(index)
    return result


def serial_to_text(serial, date1904):
    """An Excel serial date as ISO 8601 text (``None`` when it is not a representable date)."""
    if serial < 0 or serial >= 2958466:
        return None
    days = int(math.floor(serial))
    fraction = serial - days
    seconds = int(round(fraction * 86400))
    if seconds >= 86400:
        days += 1
        seconds = 0
    clock = f"{seconds // 3600:02d}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"
    if days == 0 and not date1904:
        return clock
    if date1904:
        base = datetime(1904, 1, 1) + timedelta(days=days)
    elif days == 60:
        return "1900-02-29" + ("T" + clock if seconds else "")
    elif days < 60:
        base = datetime(1899, 12, 31) + timedelta(days=days)
    else:
        base = datetime(1899, 12, 30) + timedelta(days=days)
    date = base.strftime("%Y-%m-%d")
    return f"{date}T{clock}" if seconds else date


def _workbook(archive, budget):
    """Worksheets in workbook order as (name, part path) and whether dates use the 1904 epoch."""
    date1904 = False
    sheets = []
    for _, elem in ET.iterparse(_open_xml(archive, "xl/workbook.xml", budget)):
        name = _local(elem.tag)
        if name == "workbookPr" and elem.get("date1904") in ("1", "true"):
            date1904 = True
        elif name == "sheet":
            rid = next((v for k, v in elem.attrib.items() if _local(k) == "id"), None)
            sheets.append((elem.get("name", ""), rid))
    targets = {}
    rels = "xl/_rels/workbook.xml.rels"
    if rels in archive.namelist():
        for _, elem in ET.iterparse(_open_xml(archive, rels, budget)):
            if _local(elem.tag) == "Relationship" and elem.get("Type", "").endswith("/worksheet"):
                target = elem.get("Target", "")
                targets[elem.get("Id")] = target[1:] if target.startswith("/") else "xl/" + target
    result = [(name, targets[rid]) for name, rid in sheets if rid in targets]
    if not result:
        raise XlsxError("The workbook has no worksheets")
    return result, date1904


def _rows(archive, part, budget, strings, date_styles, date1904, max_cell_chars):
    """Yields (width_hint, row) where row is a dict column -> cell text, one per non-empty row."""
    width = None
    for event, elem in ET.iterparse(_open_xml(archive, part, budget), events=("start", "end")):
        name = _local(elem.tag)
        if event == "start":
            if name == "dimension":
                match = _DIMENSION.match(elem.get("ref", ""))
                if match:
                    width = _column_index(match.group(1)) + 1
            continue
        if name != "row":
            continue
        cells = {}
        position = 0
        for c in elem:
            if _local(c.tag) != "c":
                continue
            ref = _REF.match(c.get("r", ""))
            index = _column_index(ref.group(1)) if ref else position
            position = index + 1
            kind = c.get("t", "n")
            value = None
            text = None
            for child in c:
                tag = _local(child.tag)
                if tag == "v":
                    value = child.text
                elif tag == "is":
                    text = "".join(t.text or "" for t in child.iter() if _local(t.tag) == "t")
            if kind == "inlineStr":
                cell = text
            elif kind == "s":
                cell = strings[int(value)] if value not in (None, "") else None
            elif kind == "b":
                cell = None if value in (None, "") else ("TRUE" if value.strip() in ("1", "true") else "FALSE")
            elif kind in ("str", "e", "d"):
                cell = value
            else:
                cell = value
                if cell not in (None, "") and int(c.get("s", "0") or 0) in date_styles:
                    try:
                        converted = serial_to_text(float(cell), date1904)
                    except ValueError:
                        converted = None
                    if converted is not None:
                        cell = converted
            if cell is None or cell == "":
                continue
            if len(cell) > max_cell_chars:
                raise XlsxError(f"A cell in row {elem.get('r', '?')} exceeds {max_cell_chars} characters")
            cells[index] = cell
        elem.clear()
        if cells:
            yield width, cells


def convert(source, target, max_rows=5_000_000, max_columns=1000, max_cell_chars=1024 * 1024):
    try:
        archive = zipfile.ZipFile(source)
    except (zipfile.BadZipFile, OSError) as error:
        raise XlsxError(f"Not a valid .xlsx file: {error}") from error
    with archive:
        infos = archive.infolist()
        total = sum(i.file_size for i in infos)
        packed = max(1, sum(i.compress_size for i in infos))
        if total > MAX_UNCOMPRESSED:
            raise XlsxError("The workbook expands to more than 1 GiB (possible zip bomb)")
        if total > 64 * 1024 * 1024 and total / packed > MAX_RATIO:
            raise XlsxError("The workbook compresses more than 100:1 (possible zip bomb)")
        budget = _Budget(MAX_UNCOMPRESSED)
        sheets, date1904 = _workbook(archive, budget)
        strings = _shared_strings(archive, budget)
        date_styles = _date_styles(archive, budget)
        db = sqlite3.connect(target)
        try:
            db.execute("PRAGMA journal_mode=OFF")
            db.execute("PRAGMA synchronous=OFF")
            db.executescript(META_SCHEMA)
            taken_tables = set()
            for ordinal, (sheet_name, part) in enumerate(sheets, start=1):
                table = unique("s_" + sanitize(sheet_name, f"sheet_{ordinal}"), taken_tables)
                _write_sheet(db, archive, part, budget, strings, date_styles, date1904,
                             ordinal, sheet_name, table, max_rows, max_columns, max_cell_chars)
            db.commit()
        finally:
            db.close()


def _write_sheet(db, archive, part, budget, strings, date_styles, date1904,
                 ordinal, sheet_name, table, max_rows, max_columns, max_cell_chars):
    rows = _rows(archive, part, budget, strings, date_styles, date1904, max_cell_chars)
    pending = []
    width = 0
    count = 0
    insert = None
    db.execute("BEGIN")
    for hint, cells in rows:
        if insert is None:
            width = max(hint or 0, max(cells) + 1)
            if width > max_columns:
                raise XlsxError(f"Sheet {sheet_name!r} has {width} columns; the limit is {max_columns}")
            first = [cells.get(i) for i in range(width)]
            header = not looks_like_data(first)
            labels = [(first[i] if header and first[i] else f"column_{i + 1}") for i in range(width)]
            taken = set(RESERVED)
            names = [unique(sanitize(label, f"column_{i + 1}"), taken) for i, label in enumerate(labels)]
            quoted = ", ".join('"' + n.replace('"', '""') + '"' for n in names)
            db.execute(f'CREATE TABLE "{table}"({quoted})')
            db.execute("INSERT INTO _alisio_sheets(ordinal,name,table_name,rows,columns) VALUES(?,?,?,0,?)",
                       (ordinal, sheet_name, table, width))
            db.executemany(
                "INSERT INTO _alisio_columns(table_name,ordinal,name,label,inferred_type) VALUES(?,?,?,?,'text')",
                [(table, i + 1, names[i], labels[i]) for i in range(width)])
            insert = f'INSERT INTO "{table}" VALUES ({",".join("?" * width)})'
            if header:
                continue
        count += 1
        if count > max_rows:
            raise XlsxError(f"Sheet {sheet_name!r} has more than {max_rows} rows")
        pending.append([convert_text(cells[i]) if i in cells else None for i in range(width)])
        if len(pending) >= BATCH_ROWS:
            db.executemany(insert, pending)
            pending = []
    if insert is None:
        # An empty sheet: keep it listed with no columns of its own (nothing to query).
        db.execute(f'CREATE TABLE "{table}"("column_1")')
        db.execute("INSERT INTO _alisio_sheets(ordinal,name,table_name,rows,columns) VALUES(?,?,?,0,1)",
                   (ordinal, sheet_name, table))
        db.execute("INSERT INTO _alisio_columns(table_name,ordinal,name,label,inferred_type) VALUES(?,1,'column_1','column_1','text')",
                   (table,))
    elif pending:
        db.executemany(insert, pending)
    db.execute("COMMIT")


def main(argv):
    args = list(argv)
    limits = {"max_rows": 5_000_000, "max_columns": 1000, "max_cell_chars": 1024 * 1024}
    positional = []
    i = 0
    while i < len(args):
        if args[i] in ("--max-rows", "--max-columns", "--max-cell-chars"):
            limits[args[i][2:].replace("-", "_")] = int(args[i + 1])
            i += 2
        else:
            positional.append(args[i])
            i += 1
    if len(positional) != 2:
        print("alisio-xlsx: usage: xlsx_to_sqlite INPUT.xlsx OUTPUT.sqlite", file=sys.stderr)
        return 2
    try:
        convert(positional[0], positional[1], **limits)
    except XlsxError as error:
        print(f"alisio-xlsx: {error}", file=sys.stderr)
        return 2
    except (ET.ParseError, KeyError, zipfile.BadZipFile) as error:
        print(f"alisio-xlsx: The workbook is damaged or unsupported ({type(error).__name__}: {error})", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
