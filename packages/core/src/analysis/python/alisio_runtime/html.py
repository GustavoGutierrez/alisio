"""Self-contained HTML pages. The Alisio viewer blocks network access: inline every asset."""

import html as _html
import sys
from pathlib import Path
from typing import Optional

from . import outputs


def _asset(name: str) -> str:
    """A text asset next to this file, shared with the TypeScript renderer ("" and a warning if missing)."""
    try:
        return Path(__file__).with_name(name).read_text(encoding="utf-8")
    except OSError:
        print(f"alisio_runtime.html: {name} is missing: the page will be unstyled", file=sys.stderr)
        return ""


_CSS = _asset("html-base.css")


def escape(text: object) -> str:
    return _html.escape(str(text), quote=True)


def table(rows, headers=None) -> str:
    """An HTML table from an iterable of rows (values are escaped)."""
    head = ""
    if headers:
        head = "<thead><tr>" + "".join(f"<th>{escape(h)}</th>" for h in headers) + "</tr></thead>"
    body = "".join("<tr>" + "".join(f"<td>{escape(c)}</td>" for c in row) + "</tr>" for row in rows)
    return f"<table>{head}<tbody>{body}</tbody></table>"


def page(title: str, body: str, css: Optional[str] = None, lang: str = "en") -> str:
    """A complete HTML document; ``body`` is trusted HTML written by the script."""
    style = _CSS + (css or "")
    return (
        f"<!doctype html>\n<html lang=\"{escape(lang)}\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        f"<title>{escape(title)}</title><style>{style}</style></head>"
        f"<body>{body}</body></html>\n"
    )


def write(name: str, title: str, body: str, css: Optional[str] = None, lang: str = "en") -> Path:
    """Writes a page to the output folder and returns its path."""
    target = outputs.path(name)
    target.write_text(page(title, body, css, lang), encoding="utf-8")
    return target


def inline_plotly() -> str:
    """A <script> with the plotly.js bundled in the ``plotly`` package (needs the analysis extras)."""
    try:
        from plotly.offline import get_plotlyjs  # type: ignore
    except ImportError as error:
        raise ImportError(
            "plotly is not installed; run `alisio analysis setup --extras analysis` or use alisio_runtime.svg"
        ) from error
    return f"<script>{get_plotlyjs()}</script>"
