"""Self-contained HTML pages. The Alisio viewer blocks network access: inline every asset."""

import html as _html
from pathlib import Path
from typing import Optional

from . import outputs

_CSS = """
:root { color-scheme: light; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
body { margin: 0; padding: 24px; background: #fff; color: #1b1f24; line-height: 1.5; }
h1, h2, h3 { line-height: 1.25; }
table { border-collapse: collapse; margin: 12px 0; }
th, td { border: 1px solid #d0d7de; padding: 6px 10px; text-align: left; }
th { background: #f6f8fa; }
.grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
.card { border: 1px solid #d0d7de; border-radius: 8px; padding: 16px; }
"""


def escape(text: object) -> str:
    return _html.escape(str(text), quote=True)


def table(rows, headers=None) -> str:
    """An HTML table from an iterable of rows (values are escaped)."""
    head = ""
    if headers:
        head = "<thead><tr>" + "".join(f"<th>{escape(h)}</th>" for h in headers) + "</tr></thead>"
    body = "".join("<tr>" + "".join(f"<td>{escape(c)}</td>" for c in row) + "</tr>" for row in rows)
    return f"<table>{head}<tbody>{body}</tbody></table>"


def page(title: str, body: str, css: Optional[str] = None) -> str:
    """A complete HTML document; ``body`` is trusted HTML written by the script."""
    style = _CSS + (css or "")
    return (
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
        f"<title>{escape(title)}</title><style>{style}</style></head>"
        f"<body>{body}</body></html>\n"
    )


def write(name: str, title: str, body: str, css: Optional[str] = None) -> Path:
    """Writes a page to the output folder and returns its path."""
    target = outputs.path(name)
    target.write_text(page(title, body, css), encoding="utf-8")
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
