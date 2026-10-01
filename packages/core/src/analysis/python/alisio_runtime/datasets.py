"""Read-only access to the datasets Alisio prepared (one SQLite file each) and any .sqlite input.

``open("sales")`` returns a read-only ``sqlite3`` connection to ``input/sales.sqlite``; the data
is in the table ``data`` (CSV, TSV, JSON, JSONL) or ``s_<sheet>`` (XLSX). Values are stored
without loss: columns have no declared type, numbers are numbers and everything else (``007``,
``1,234``, ``N/A``) is the exact text. ``columns("sales")`` lists the columns with the type
hints and statistics computed at ingestion. Standard library only; with the optional extras,
``pandas.read_sql_query("SELECT * FROM data", open("sales"))`` works on the same connection.
"""

import json
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from . import input_dir

__all__ = ["connect", "open", "tables", "columns", "inputs"]


def _resolve(name: Union[str, Path]) -> Path:
    target = Path(name)
    if not target.is_absolute():
        target = input_dir() / target
    if not target.exists() and target.suffix != ".sqlite":
        alt = target.with_name(target.name + ".sqlite")
        if alt.exists():
            target = alt
    return target.resolve()


def connect(path: Union[str, Path]) -> sqlite3.Connection:
    """Opens a SQLite file read-only (``mode=ro``); writes raise ``sqlite3.OperationalError``."""
    return sqlite3.connect(_resolve(path).as_uri() + "?mode=ro&immutable=1", uri=True)


def open(name: Union[str, Path]) -> sqlite3.Connection:  # noqa: A001 - mirrors the documented API
    """The dataset ``name`` (``input/<name>.sqlite``) as a read-only connection."""
    return connect(name)


def tables(name: Union[str, Path]) -> List[Dict[str, Any]]:
    """Sheets of a dataset: ``[{"name", "table", "rows", "columns"}]``."""
    with connect(name) as db:
        rows = db.execute(
            "SELECT name, table_name, rows, columns FROM _alisio_sheets ORDER BY ordinal"
        ).fetchall()
    return [{"name": r[0], "table": r[1], "rows": r[2], "columns": r[3]} for r in rows]


def columns(name: Union[str, Path], table: Optional[str] = None) -> List[Dict[str, Any]]:
    """Columns with type hint and statistics (``nulls``, ``distinct``, ``min``, ``max``, ``mean``,
    ``text_fallbacks``, ``top``); ``table`` defaults to the first sheet."""
    with connect(name) as db:
        if table is None:
            first = db.execute("SELECT table_name FROM _alisio_sheets ORDER BY ordinal LIMIT 1").fetchone()
            if first is None:
                return []
            table = first[0]
        rows = db.execute(
            "SELECT name, label, inferred_type, nulls, distinct_count, distinct_exact, min, max, mean,"
            " text_fallbacks, top_values FROM _alisio_columns WHERE table_name=? ORDER BY ordinal",
            (table,),
        ).fetchall()
    keys = ["name", "label", "type", "nulls", "distinct", "distinct_exact", "min", "max", "mean",
            "text_fallbacks", "top"]
    result = []
    for row in rows:
        item = dict(zip(keys, row))
        item["top"] = json.loads(item["top"] or "[]")
        result.append(item)
    return result


def inputs() -> List[Dict[str, Any]]:
    """What python_run placed in the input folder (``input/inputs.json``)."""
    listing = input_dir() / "inputs.json"
    if not listing.exists():
        return []
    return json.loads(listing.read_text(encoding="utf-8"))
