"""Dependency-free, responsive SVG charts to embed in HTML or save as ``.svg`` files.

Every chart is one ``<svg>`` with a ``viewBox`` and no fixed pixel size (it fills its container and
keeps its aspect ratio), a ``<title>``/``<desc>`` for screen readers and ``currentColor`` text, so it
works offline, in print and in light and dark pages. For interactive dashboards prefer
``alisio_runtime.charts`` (Chart.js); use these for static output and as a fallback.

Pie and donut slices come from :func:`pie_slices` (pure geometry, unit tested): never hand-write SVG
arcs, the ``large-arc-flag`` and the 100% slice are easy to get wrong.
"""

import html as _html
import math
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Tuple, Union

# Categorical order of the Alisio chart palette (light surface). The CSS variables --ac-c1..8 (set by
# alisio_runtime.charts) override these, so the same SVG follows a dark page.
PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"]
MAX_SERIES = len(PALETTE)
_OTHER = "#8a8f98"
_FONT = "system-ui, -apple-system, Segoe UI, Roboto, sans-serif"

Series = Union[Sequence[object], Dict[str, Sequence[object]]]


def _esc(text: object) -> str:
    return _html.escape(str(text), quote=True)


def _num(value: float) -> str:
    return f"{value:.2f}".rstrip("0").rstrip(".") or "0"


def _finite(value: object) -> Optional[float]:
    """A finite float, or None for anything else (None, NaN, text that is not a number)."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(str(value).replace(",", "")) if isinstance(value, str) else float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def fmt_value(value: float) -> str:
    """Compact human number: 1234 -> 1.23k, 2500000 -> 2.5M, 0.5 -> 0.5."""
    magnitude = abs(value)
    for limit, suffix in ((1e9, "B"), (1e6, "M"), (1e3, "k")):
        if magnitude >= limit:
            return f"{_num(value / limit)}{suffix}"
    return _num(value)


def _fill(index: int) -> str:
    slot = index % MAX_SERIES
    return f"fill:var(--ac-c{slot + 1},{PALETTE[slot]})"


def _stroke(index: int) -> str:
    slot = index % MAX_SERIES
    return f"stroke:var(--ac-c{slot + 1},{PALETTE[slot]})"


def _truncate(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: max(1, limit - 1)] + "…"


def nice_ticks(low: float, high: float, count: int = 5) -> List[float]:
    """Round tick values covering ``[low, high]`` (about ``count`` of them)."""
    if not high > low:
        high = low + 1.0
    raw = (high - low) / max(1, count - 1)
    magnitude = 10 ** math.floor(math.log10(raw))
    residual = raw / magnitude
    step = (1 if residual <= 1 else 2 if residual <= 2 else 5 if residual <= 5 else 10) * magnitude
    first = math.floor(low / step + 1e-9)
    last = math.ceil(high / step - 1e-9)
    return [round(i * step, 10) for i in range(first, last + 1)]


def _series(values: Series, count: Optional[int] = None) -> List[Tuple[Optional[str], List[Optional[float]]]]:
    """Normalises ``values`` (a sequence or ``{name: sequence}``) to ``[(name, [float | None])]``."""
    if isinstance(values, dict):
        items = [(str(name), list(data)) for name, data in values.items()]
    else:
        items = [(None, list(values))]
    if len(items) > MAX_SERIES:
        raise ValueError(f"{len(items)} series: at most {MAX_SERIES} are readable; group the rest as 'Other' or split the chart")
    return [(name, [_finite(v) for v in data]) for name, data in items]


# ---------------------------------------------------------------------------- pie geometry


def pie_slices(values: Iterable[object], start: float = -90.0) -> List[Dict[str, object]]:
    """Angles of a pie. Pure and deterministic.

    Angles are degrees, clockwise, measured from the +x axis (``start=-90`` is 12 o'clock). Values
    that are not positive finite numbers get no slice. Returns one dict per positive value:
    ``index``, ``value``, ``fraction`` (0..1), ``percent``, ``start``, ``end``, ``sweep``,
    ``large_arc`` (1 only when ``sweep > 180``) and ``full`` (the only visible slice: a full circle).
    An empty list means there is nothing to draw (no positive total). Slice ends come from cumulative
    sums, so rounding never accumulates and the last one ends exactly at ``start + 360``.
    """
    cleaned = [(_finite(v) or 0.0) for v in values]
    cleaned = [v if v > 0 else 0.0 for v in cleaned]
    total = sum(cleaned)
    if total <= 0:
        return []
    last = max(i for i, v in enumerate(cleaned) if v > 0)
    slices: List[Dict[str, object]] = []
    seen = 0.0
    for index, value in enumerate(cleaned):
        if value <= 0:
            continue
        begin = start + 360.0 * seen / total
        seen += value
        finish = start + 360.0 if index == last else start + 360.0 * seen / total
        sweep = finish - begin
        slices.append(
            {
                "index": index,
                "value": value,
                "fraction": value / total,
                "percent": 100.0 * value / total,
                "start": begin,
                "end": finish,
                "sweep": sweep,
                "large_arc": 1 if sweep > 180.0 else 0,
                "full": sweep >= 359.999,
            }
        )
    return slices


def _point(cx: float, cy: float, radius: float, angle: float) -> Tuple[float, float]:
    rad = math.radians(angle)
    return cx + radius * math.cos(rad), cy + radius * math.sin(rad)


def arc_path(cx: float, cy: float, radius: float, start: float, end: float, inner: float = 0.0) -> str:
    """The ``d`` of one pie (``inner=0``) or donut slice from ``start`` to ``end`` degrees.

    A sweep of 360 (a 100% slice) is drawn as a whole disc or ring: a single arc whose start and end
    coincide draws nothing. Use ``fill-rule="evenodd"`` for the ring (``pie``/``donut`` do).
    """
    sweep = end - start
    if sweep >= 359.999:
        disc = (
            f"M{_num(cx - radius)},{_num(cy)}A{_num(radius)},{_num(radius)} 0 1 1 {_num(cx + radius)},{_num(cy)}"
            f"A{_num(radius)},{_num(radius)} 0 1 1 {_num(cx - radius)},{_num(cy)}Z"
        )
        if inner <= 0:
            return disc
        return (
            disc
            + f"M{_num(cx - inner)},{_num(cy)}A{_num(inner)},{_num(inner)} 0 1 0 {_num(cx + inner)},{_num(cy)}"
            f"A{_num(inner)},{_num(inner)} 0 1 0 {_num(cx - inner)},{_num(cy)}Z"
        )
    large = 1 if sweep > 180.0 else 0
    x0, y0 = _point(cx, cy, radius, start)
    x1, y1 = _point(cx, cy, radius, end)
    if inner <= 0:
        return (
            f"M{_num(cx)},{_num(cy)}L{_num(x0)},{_num(y0)}"
            f"A{_num(radius)},{_num(radius)} 0 {large} 1 {_num(x1)},{_num(y1)}Z"
        )
    ix0, iy0 = _point(cx, cy, inner, start)
    ix1, iy1 = _point(cx, cy, inner, end)
    return (
        f"M{_num(x0)},{_num(y0)}A{_num(radius)},{_num(radius)} 0 {large} 1 {_num(x1)},{_num(y1)}"
        f"L{_num(ix1)},{_num(iy1)}A{_num(inner)},{_num(inner)} 0 {large} 0 {_num(ix0)},{_num(iy0)}Z"
    )


def group_small(
    labels: Iterable[object],
    values: Iterable[object],
    max_slices: int = MAX_SERIES,
    min_fraction: float = 0.02,
    other: str = "Other",
) -> Tuple[List[str], List[float]]:
    """Keeps the largest categories and folds the rest (and any below ``min_fraction``) into one.

    Drops non-positive and non-numeric values. Returns ``(labels, values)`` sorted as given, with the
    folded categories summed into ``other`` as the last entry.
    """
    pairs = [(str(label), _finite(value) or 0.0) for label, value in zip(labels, values)]
    pairs = [(label, value) for label, value in pairs if value > 0]
    total = sum(value for _, value in pairs)
    if total <= 0:
        return [], []
    over = len(pairs) > max_slices
    ranked = sorted(range(len(pairs)), key=lambda i: -pairs[i][1])
    candidates = set(ranked[: max_slices - 1]) if over else set(range(len(pairs)))
    keep = {i for i in candidates if pairs[i][1] / total >= min_fraction}
    if not over and len(pairs) - len(keep) == 1:
        keep = set(range(len(pairs)))  # a lone small slice keeps its own name
    kept = [pairs[i] for i in range(len(pairs)) if i in keep]
    folded = sum(pairs[i][1] for i in range(len(pairs)) if i not in keep)
    if folded > 0:
        kept.append((other, folded))
    return [label for label, _ in kept], [value for _, value in kept]


# ---------------------------------------------------------------------------- shared frame


def _frame(width: float, height: float, title: Optional[str], desc: str, body: List[str], max_width: Optional[int]) -> str:
    cap = f";max-width:{int(max_width)}px" if max_width else ""
    label = title or desc
    head = f"<title>{_esc(label)}</title><desc>{_esc(desc)}</desc>"
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {_num(width)} {_num(height)}" '
        f'preserveAspectRatio="xMidYMid meet" role="img" font-family="{_FONT}" fill="currentColor" '
        f'style="display:block;width:100%;height:auto{cap}">{head}{"".join(body)}</svg>'
    )


def _title(title: Optional[str], width: float) -> List[str]:
    if not title:
        return []
    return [f'<text x="{_num(width / 2)}" y="18" text-anchor="middle" font-size="15" font-weight="600">{_esc(title)}</text>']


def _legend(names: Sequence[str], width: float, y: float) -> Tuple[List[str], float]:
    """A wrapped row legend (swatch + name); returns its parts and height."""
    parts: List[str] = []
    x, row = 12.0, 0
    for index, name in enumerate(names):
        label = _truncate(name, 24)
        need = 22 + 6.6 * len(label)
        if x + need > width - 8 and x > 12:
            x, row = 12.0, row + 1
        top = y + row * 20
        parts.append(f'<rect x="{_num(x)}" y="{_num(top)}" width="12" height="12" rx="2" style="{_fill(index)}"/>')
        parts.append(f'<text x="{_num(x + 17)}" y="{_num(top + 10.5)}" font-size="12">{_esc(label)}</text>')
        x += need + 8
    return parts, (row + 1) * 20


def _desc(kind: str, names: Sequence[str], values: Sequence[Optional[float]], fmt: Callable[[float], str]) -> str:
    pairs = [f"{n}: {fmt(v)}" for n, v in zip(names, values) if v is not None][:12]
    return f"{kind}. " + "; ".join(pairs) if pairs else kind


def _empty(width: float, height: float, title: Optional[str], message: str, max_width: Optional[int]) -> str:
    body = _title(title, width) + [
        f'<text x="{_num(width / 2)}" y="{_num(height / 2)}" text-anchor="middle" font-size="13" opacity="0.7">{_esc(message)}</text>'
    ]
    return _frame(width, height, title, message, body, max_width)


# ---------------------------------------------------------------------------- pie / donut


def _pie(
    labels: Iterable[object],
    values: Iterable[object],
    title: Optional[str],
    width: int,
    height: int,
    donut: bool,
    fmt: Optional[Callable[[float], str]],
    max_slices: int,
    max_width: Optional[int],
    center_text: Optional[str],
) -> str:
    fmt = fmt or fmt_value
    names, nums = group_small(labels, values, max_slices=max_slices)
    slices = pie_slices(nums)
    if not slices:
        return _empty(width, height, title, "No data", max_width)
    top = 30 if title else 8
    radius = min((height - top - 8) / 2, width * 0.34)
    cx, cy = 8 + radius + 4, top + (height - top) / 2
    inner = radius * 0.58 if donut else 0.0
    body = _title(title, width)
    for s in slices:
        i = int(s["index"])  # type: ignore[call-overload]
        d = arc_path(cx, cy, radius, float(s["start"]), float(s["end"]), inner)  # type: ignore[arg-type]
        other = names[i] == "Other" and i == len(names) - 1 and len(names) > 1
        color = f"fill:{_OTHER}" if other else _fill(i)
        body.append(
            f'<path d="{d}" fill-rule="evenodd" style="{color};stroke:var(--ac-surface,#fff);stroke-width:2">'
            f"<title>{_esc(names[i])}: {_esc(fmt(nums[i]))} ({s['percent']:.1f}%)</title></path>"
        )
        if s["percent"] >= 6 and not s["full"]:  # type: ignore[operator]
            mid = (float(s["start"]) + float(s["end"])) / 2  # type: ignore[arg-type]
            lx, ly = _point(cx, cy, (radius + inner) / 2 if donut else radius * 0.62, mid)
            body.append(
                f'<text x="{_num(lx)}" y="{_num(ly + 4)}" text-anchor="middle" font-size="12" font-weight="600" '
                f'fill="#fff" style="paint-order:stroke;stroke:rgba(0,0,0,.35);stroke-width:2px">{s["percent"]:.1f}%</text>'
            )
    if donut and center_text:
        body.append(f'<text x="{_num(cx)}" y="{_num(cy + 5)}" text-anchor="middle" font-size="15" font-weight="600">{_esc(center_text)}</text>')
    lx = cx + radius + 28
    row = min(24.0, (height - top - 8) / max(1, len(names)))
    ly = cy - row * len(names) / 2
    for i, name in enumerate(names):
        y = ly + i * row
        other = name == "Other" and i == len(names) - 1 and len(names) > 1
        color = f"fill:{_OTHER}" if other else _fill(i)
        pct = 100.0 * nums[i] / sum(nums)
        body.append(f'<rect x="{_num(lx)}" y="{_num(y)}" width="12" height="12" rx="2" style="{color}"/>')
        body.append(f'<text x="{_num(lx + 18)}" y="{_num(y + 10.5)}" font-size="12.5">{_esc(_truncate(name, 20))}</text>')
        body.append(f'<text x="{_num(width - 8)}" y="{_num(y + 10.5)}" text-anchor="end" font-size="12.5" opacity="0.75">{pct:.1f}%</text>')
    desc = _desc("Pie chart" if not donut else "Donut chart", names, nums, fmt)
    return _frame(width, height, title, desc, body, max_width)


def pie(
    labels: Iterable[object],
    values: Iterable[object],
    title: Optional[str] = None,
    width: int = 480,
    height: int = 260,
    fmt: Optional[Callable[[float], str]] = None,
    max_slices: int = 6,
    max_width: Optional[int] = None,
) -> str:
    """A pie with a legend that lists each share. More than ``max_slices`` categories (and shares
    under 2%) fold into "Other"; use ``donut`` or ``hbar`` instead when there are many."""
    return _pie(labels, values, title, width, height, False, fmt, max_slices, max_width, None)


def donut(
    labels: Iterable[object],
    values: Iterable[object],
    title: Optional[str] = None,
    width: int = 480,
    height: int = 260,
    fmt: Optional[Callable[[float], str]] = None,
    max_slices: int = 8,
    max_width: Optional[int] = None,
    center_text: Optional[str] = None,
) -> str:
    """Like ``pie`` with a hole; ``center_text`` (for example the total) is written in it."""
    return _pie(labels, values, title, width, height, True, fmt, max_slices, max_width, center_text)


# ---------------------------------------------------------------------------- cartesian


def _value_axis_vertical(left: float, right: float, top: float, bottom: float, ticks: Sequence[float], fmt: Callable[[float], str]) -> List[str]:
    low, high = ticks[0], ticks[-1]
    parts = []
    for tick in ticks:
        y = bottom - (bottom - top) * (tick - low) / (high - low)
        parts.append(f'<line x1="{_num(left)}" y1="{_num(y)}" x2="{_num(right)}" y2="{_num(y)}" stroke="currentColor" stroke-opacity="{0.35 if tick == 0 else 0.12}"/>')
        parts.append(f'<text x="{_num(left - 6)}" y="{_num(y + 4)}" text-anchor="end" font-size="11.5" opacity="0.75">{_esc(fmt(tick))}</text>')
    return parts


def _tick_width(ticks: Sequence[float], fmt: Callable[[float], str]) -> float:
    return 12 + 6.4 * max((len(fmt(t)) for t in ticks), default=3)


def _bar_vertical(labels, values, title, width, height, stacked, fmt, value_labels, max_width) -> str:
    fmt = fmt or fmt_value
    labels = [str(label) for label in labels]
    series = _series(values)
    count = len(labels)
    if not count or not any(v is not None for _, data in series for v in data):
        return _empty(width, height, title, "No data", max_width)
    series = [(name, (data + [None] * count)[:count]) for name, data in series]
    names = [name or "" for name, _ in series]
    multi = len(series) > 1
    if stacked:
        pos = [sum(max(0.0, d[i] or 0.0) for _, d in series) for i in range(count)]
        neg = [sum(min(0.0, d[i] or 0.0) for _, d in series) for i in range(count)]
        low, high = min(0.0, min(neg)), max(0.0, max(pos))
    else:
        flat = [v for _, d in series for v in d if v is not None]
        low, high = min(0.0, min(flat)), max(0.0, max(flat))
    ticks = nice_ticks(low, high)
    body = _title(title, width)
    top = 30 if title else 12
    if multi:
        legend, used = _legend(names, width, top)
        body += legend
        top += used + 6
    rotate = count > 6 and max(len(label) for label in labels) > 6
    bottom = height - (58 if rotate else 30)
    left = _tick_width(ticks, fmt)
    right = width - 10
    body += _value_axis_vertical(left, right, top, bottom, ticks, fmt)
    low, high = ticks[0], ticks[-1]

    def y_of(value: float) -> float:
        return bottom - (bottom - top) * (value - low) / (high - low)

    step = (right - left) / count
    group = step * 0.72
    bar_w = group if stacked else group / len(series)
    show_values = value_labels and not stacked and count * len(series) <= 16
    for i, label in enumerate(labels):
        gx = left + step * i + (step - group) / 2
        up = down = 0.0
        for k, (name, data) in enumerate(series):
            value = data[i]
            if value is None:
                continue
            if stacked:
                x = gx
                if value >= 0:
                    y0, y1 = y_of(up), y_of(up + value)
                    up += value
                else:
                    y0, y1 = y_of(down), y_of(down + value)
                    down += value
            else:
                x = gx + bar_w * k
                y0, y1 = y_of(0), y_of(value)
            h = abs(y0 - y1)
            tip = f"{label}{' / ' + name if multi else ''}: {fmt(value)}"
            body.append(
                f'<rect x="{_num(x + (1 if not stacked and multi else 0))}" y="{_num(min(y0, y1))}" width="{_num(max(0.5, bar_w - (2 if not stacked and multi else 0)))}" '
                f'height="{_num(max(h, 0.5 if value else 0))}" rx="2" style="{_fill(k)}"><title>{_esc(tip)}</title></rect>'
            )
            if show_values:
                ty = y1 - 4 if value >= 0 else y1 + 12
                body.append(f'<text x="{_num(x + bar_w / 2)}" y="{_num(ty)}" text-anchor="middle" font-size="11">{_esc(fmt(value))}</text>')
        cx = left + step * i + step / 2
        text = _esc(_truncate(label, 16))
        if rotate:
            body.append(f'<text x="{_num(cx)}" y="{_num(bottom + 14)}" text-anchor="end" font-size="11.5" transform="rotate(-35 {_num(cx)} {_num(bottom + 14)})">{text}</text>')
        else:
            body.append(f'<text x="{_num(cx)}" y="{_num(bottom + 16)}" text-anchor="middle" font-size="12">{text}</text>')
    desc = "Bar chart" + (" (stacked)" if stacked else "") + ". " + "; ".join(
        f"{label}: " + ", ".join(f"{(n + ' ') if n else ''}{fmt(d[i])}" for n, d in series if d[i] is not None) for i, label in enumerate(labels[:10])
    )
    return _frame(width, height, title, desc, body, max_width)


def bar(
    labels: Iterable[object],
    values: Series,
    title: Optional[str] = None,
    width: int = 480,
    height: int = 300,
    stacked: bool = False,
    fmt: Optional[Callable[[float], str]] = None,
    value_labels: bool = True,
    max_width: Optional[int] = None,
) -> str:
    """Vertical bars. ``values`` is a sequence (one series) or ``{series name: sequence}``: several
    series are drawn grouped, or stacked with ``stacked=True``, with a legend."""
    return _bar_vertical(labels, values, title, width, height, stacked, fmt, value_labels, max_width)


def hbar(
    labels: Iterable[object],
    values: Series,
    title: Optional[str] = None,
    width: int = 480,
    height: Optional[int] = None,
    stacked: bool = False,
    fmt: Optional[Callable[[float], str]] = None,
    value_labels: bool = True,
    max_width: Optional[int] = None,
) -> str:
    """Horizontal bars (best for long labels or many categories). The height follows the number of
    rows unless ``height`` is given. Same ``values`` forms as ``bar``."""
    fmt = fmt or fmt_value
    labels = [str(label) for label in labels]
    series = _series(values)
    count = len(labels)
    if not count or not any(v is not None for _, data in series for v in data):
        return _empty(width, height or 200, title, "No data", max_width)
    series = [(name, (data + [None] * count)[:count]) for name, data in series]
    names = [name or "" for name, _ in series]
    multi = len(series) > 1
    if stacked:
        pos = [sum(max(0.0, d[i] or 0.0) for _, d in series) for i in range(count)]
        neg = [sum(min(0.0, d[i] or 0.0) for _, d in series) for i in range(count)]
        low, high = min(0.0, min(neg)), max(0.0, max(pos))
    else:
        flat = [v for _, d in series for v in d if v is not None]
        low, high = min(0.0, min(flat)), max(0.0, max(flat))
    ticks = nice_ticks(low, high)
    low, high = ticks[0], ticks[-1]
    top = 30 if title else 12
    legend: List[str] = []
    if multi:
        legend, used = _legend(names, width, top)
        top += used + 6
    row = (22 if stacked else 16 * len(series) + 8)
    plot_h = row * count
    bottom = top + plot_h
    total_h = height or bottom + 28
    if height:
        row = (height - 28 - top) / count
        bottom = top + row * count
    label_w = min(150.0, 12 + 6.4 * max(len(_truncate(label, 22)) for label in labels))
    left, right = label_w + 4, width - (44 if value_labels and not stacked else 12)
    body = _title(title, width) + legend
    for tick in ticks:
        x = left + (right - left) * (tick - low) / (high - low)
        body.append(f'<line x1="{_num(x)}" y1="{_num(top)}" x2="{_num(x)}" y2="{_num(bottom)}" stroke="currentColor" stroke-opacity="{0.35 if tick == 0 else 0.12}"/>')
        body.append(f'<text x="{_num(x)}" y="{_num(bottom + 16)}" text-anchor="middle" font-size="11.5" opacity="0.75">{_esc(fmt(tick))}</text>')

    def x_of(value: float) -> float:
        return left + (right - left) * (value - low) / (high - low)

    show_values = value_labels and not stacked
    for i, label in enumerate(labels):
        gy = top + row * i + row * 0.14
        group = row * 0.72
        bar_h = group if stacked else group / len(series)
        body.append(f'<text x="{_num(left - 8)}" y="{_num(top + row * i + row / 2 + 4)}" text-anchor="end" font-size="12">{_esc(_truncate(label, 22))}<title>{_esc(label)}</title></text>')
        up = down = 0.0
        for k, (name, data) in enumerate(series):
            value = data[i]
            if value is None:
                continue
            if stacked:
                y = gy
                if value >= 0:
                    x0, x1 = x_of(up), x_of(up + value)
                    up += value
                else:
                    x0, x1 = x_of(down), x_of(down + value)
                    down += value
            else:
                y = gy + bar_h * k
                x0, x1 = x_of(0), x_of(value)
            tip = f"{label}{' / ' + name if multi else ''}: {fmt(value)}"
            body.append(
                f'<rect x="{_num(min(x0, x1))}" y="{_num(y)}" width="{_num(max(abs(x1 - x0), 0.5 if value else 0))}" '
                f'height="{_num(max(1, bar_h - (2 if multi and not stacked else 0)))}" rx="2" style="{_fill(k)}"><title>{_esc(tip)}</title></rect>'
            )
            if show_values:
                anchor, tx = ("start", x1 + 5) if value >= 0 else ("end", x1 - 5)
                body.append(f'<text x="{_num(tx)}" y="{_num(y + bar_h / 2 + 4)}" text-anchor="{anchor}" font-size="11">{_esc(fmt(value))}</text>')
    desc = "Horizontal bar chart. " + "; ".join(
        f"{label}: " + ", ".join(f"{(n + ' ') if n else ''}{fmt(d[i])}" for n, d in series if d[i] is not None) for i, label in enumerate(labels[:10])
    )
    return _frame(width, total_h, title, desc, body, max_width)


def _xy(xs, ys, title, width, height, connect: bool, area: bool, fmt, max_width) -> str:
    fmt = fmt or fmt_value
    xs = list(xs)
    series = _series(ys)
    numeric_x = all(_finite(x) is not None for x in xs) and bool(xs)
    count = len(xs)
    flat = [v for _, d in series for v in d if v is not None]
    if not count or not flat:
        return _empty(width, height, title, "No data", max_width)
    series = [(name, (d + [None] * count)[:count]) for name, d in series]
    names = [name or "" for name, _ in series]
    multi = len(series) > 1
    low, high = min(flat), max(flat)
    ticks = nice_ticks(min(0.0, low) if area else low, high)
    low, high = ticks[0], ticks[-1]
    top = 30 if title else 12
    body = _title(title, width)
    if multi:
        legend, used = _legend(names, width, top)
        body += legend
        top += used + 6
    bottom = height - 30
    left, right = _tick_width(ticks, fmt), width - 14
    body += _value_axis_vertical(left, right, top, bottom, ticks, fmt)
    if numeric_x:
        xv = [float(_finite(x)) for x in xs]  # type: ignore[arg-type]
        xlow, xhigh = min(xv), max(xv)
        if xhigh == xlow:
            xhigh = xlow + 1.0
        xt = nice_ticks(xlow, xhigh, 6)
        xlow, xhigh = (xt[0], xt[-1]) if not connect else (xlow, xhigh)
        def x_of(i: int) -> float:
            return left + (right - left) * (xv[i] - xlow) / (xhigh - xlow)
        shown = [(x, fmt(x)) for x in (xt if not connect else [t for t in xt if xlow <= t <= xhigh])]
        positions = [(left + (right - left) * (x - xlow) / (xhigh - xlow), text) for x, text in shown]
    else:
        pad = (right - left) / count / 2 if count > 1 else (right - left) / 2
        def x_of(i: int) -> float:
            return left + pad + (right - left - 2 * pad) * (i / (count - 1) if count > 1 else 0.5)
        every = max(1, math.ceil(count / 6))
        positions = [(x_of(i), _truncate(str(xs[i]), 12)) for i in range(0, count, every)]
    for x, text in positions:
        body.append(f'<text x="{_num(x)}" y="{_num(bottom + 16)}" text-anchor="middle" font-size="11.5" opacity="0.8">{_esc(text)}</text>')
    zero_y = bottom - (bottom - top) * (0 - low) / (high - low) if low <= 0 <= high else bottom
    for k, (name, data) in enumerate(series):
        pts = [(x_of(i), bottom - (bottom - top) * (v - low) / (high - low), i, v) for i, v in enumerate(data) if v is not None]
        if connect and len(pts) > 1:
            path = "".join(("M" if j == 0 else "L") + f"{_num(x)},{_num(y)}" for j, (x, y, _, _) in enumerate(pts))
            if area:
                body.append(f'<path d="{path}L{_num(pts[-1][0])},{_num(zero_y)}L{_num(pts[0][0])},{_num(zero_y)}Z" style="{_fill(k)};fill-opacity:.18"/>')
            body.append(f'<path d="{path}" fill="none" style="{_stroke(k)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>')
        if len(pts) <= 40 or not connect:
            for x, y, i, v in pts:
                tip = f"{xs[i]}{' / ' + name if multi else ''}: {fmt(v)}"
                body.append(f'<circle cx="{_num(x)}" cy="{_num(y)}" r="{3 if connect else 3.5}" style="{_fill(k)};stroke:var(--ac-surface,#fff);stroke-width:1.5"><title>{_esc(tip)}</title></circle>')
    desc = ("Area" if area else "Line" if connect else "Scatter") + " chart. " + "; ".join(
        f"{xs[i]}: " + ", ".join(f"{(n + ' ') if n else ''}{fmt(d[i])}" for n, d in series if d[i] is not None) for i in range(min(count, 10))
    )
    return _frame(width, height, title, desc, body, max_width)


def line(
    xs: Iterable[object],
    ys: Series,
    title: Optional[str] = None,
    width: int = 480,
    height: int = 300,
    fmt: Optional[Callable[[float], str]] = None,
    max_width: Optional[int] = None,
) -> str:
    """A line chart. ``xs`` are numbers or labels (dates as text are spaced evenly); ``ys`` is a
    sequence or ``{series name: sequence}``."""
    return _xy(xs, ys, title, width, height, True, False, fmt, max_width)


def area(
    xs: Iterable[object],
    ys: Series,
    title: Optional[str] = None,
    width: int = 480,
    height: int = 300,
    fmt: Optional[Callable[[float], str]] = None,
    max_width: Optional[int] = None,
) -> str:
    """Like ``line`` with the area under each series lightly filled (the axis includes zero)."""
    return _xy(xs, ys, title, width, height, True, True, fmt, max_width)


def scatter(
    xs: Iterable[object],
    ys: Series,
    title: Optional[str] = None,
    width: int = 480,
    height: int = 300,
    fmt: Optional[Callable[[float], str]] = None,
    max_width: Optional[int] = None,
) -> str:
    """Points ``(x, y)``; ``ys`` may be ``{series name: sequence}`` sharing the same ``xs``."""
    return _xy(xs, ys, title, width, height, False, False, fmt, max_width)
