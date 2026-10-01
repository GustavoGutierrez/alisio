"""Dependency-free SVG charts (bar, line, scatter) to embed in HTML or save as .svg files."""

import html as _html
from typing import Iterable, List, Optional, Sequence

_PALETTE = ["#2f6fdb", "#e0692b", "#2a9d63", "#c2417b", "#7a5bd6", "#a8862b"]


def _esc(text: object) -> str:
    return _html.escape(str(text), quote=True)


def _num(value: float) -> str:
    return f"{value:.2f}".rstrip("0").rstrip(".")


def _scale(values: Sequence[float]):
    low = min(0.0, min(values)) if values else 0.0
    high = max(values) if values else 1.0
    if high == low:
        high = low + 1.0
    return low, high


def _frame(width: int, height: int, title: Optional[str], body: List[str]) -> str:
    heading = f'<text x="{width / 2}" y="20" text-anchor="middle" font-size="14" font-weight="600">{_esc(title)}</text>' if title else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" font-family="system-ui, sans-serif" role="img">'
        f'<rect width="100%" height="100%" fill="#ffffff"/>{heading}{"".join(body)}</svg>'
    )


def _axes(left: int, top: int, right: int, bottom: int, low: float, high: float) -> List[str]:
    parts = [
        f'<line x1="{left}" y1="{bottom}" x2="{right}" y2="{bottom}" stroke="#57606a"/>',
        f'<line x1="{left}" y1="{top}" x2="{left}" y2="{bottom}" stroke="#57606a"/>',
    ]
    for i in range(5):
        value = low + (high - low) * i / 4
        y = bottom - (bottom - top) * i / 4
        parts.append(f'<text x="{left - 6}" y="{y + 4}" text-anchor="end" font-size="10" fill="#57606a">{_esc(_num(value))}</text>')
        parts.append(f'<line x1="{left}" y1="{y}" x2="{right}" y2="{y}" stroke="#eaeef2"/>')
    return parts


def bar(labels: Iterable[object], values: Iterable[float], title: Optional[str] = None, width: int = 640, height: int = 360) -> str:
    labels = [str(l) for l in labels]
    values = [float(v) for v in values]
    left, top, right, bottom = 56, 36, width - 16, height - 48
    low, high = _scale(values)
    parts = _axes(left, top, right, bottom, low, high)
    step = (right - left) / max(1, len(values))
    zero = bottom - (bottom - top) * (0 - low) / (high - low)
    for i, (label, value) in enumerate(zip(labels, values)):
        x = left + step * i + step * 0.15
        y = bottom - (bottom - top) * (value - low) / (high - low)
        parts.append(f'<rect x="{_num(x)}" y="{_num(min(y, zero))}" width="{_num(step * 0.7)}" height="{_num(abs(zero - y))}" fill="{_PALETTE[0]}"><title>{_esc(label)}: {_esc(_num(value))}</title></rect>')
        parts.append(f'<text x="{_num(x + step * 0.35)}" y="{bottom + 16}" text-anchor="middle" font-size="10">{_esc(label)}</text>')
    return _frame(width, height, title, parts)


def _xy(xs, ys, title, width, height, connect: bool) -> str:
    xs = [float(x) for x in xs]
    ys = [float(y) for y in ys]
    left, top, right, bottom = 56, 36, width - 16, height - 40
    low, high = _scale(ys)
    xlow, xhigh = (min(xs), max(xs)) if xs else (0.0, 1.0)
    if xhigh == xlow:
        xhigh = xlow + 1.0
    parts = _axes(left, top, right, bottom, low, high)
    points = [(left + (right - left) * (x - xlow) / (xhigh - xlow), bottom - (bottom - top) * (y - low) / (high - low)) for x, y in zip(xs, ys)]
    if connect and points:
        path = " ".join(f"{_num(x)},{_num(y)}" for x, y in points)
        parts.append(f'<polyline points="{path}" fill="none" stroke="{_PALETTE[0]}" stroke-width="2"/>')
    for (x, y), xv, yv in zip(points, xs, ys):
        parts.append(f'<circle cx="{_num(x)}" cy="{_num(y)}" r="3" fill="{_PALETTE[1] if not connect else _PALETTE[0]}"><title>{_esc(_num(xv))}, {_esc(_num(yv))}</title></circle>')
    parts.append(f'<text x="{left}" y="{bottom + 16}" font-size="10">{_esc(_num(xlow))}</text>')
    parts.append(f'<text x="{right}" y="{bottom + 16}" text-anchor="end" font-size="10">{_esc(_num(xhigh))}</text>')
    return _frame(width, height, title, parts)


def line(xs: Iterable[float], ys: Iterable[float], title: Optional[str] = None, width: int = 640, height: int = 360) -> str:
    return _xy(list(xs), list(ys), title, width, height, True)


def scatter(xs: Iterable[float], ys: Iterable[float], title: Optional[str] = None, width: int = 640, height: int = 360) -> str:
    return _xy(list(xs), list(ys), title, width, height, False)
