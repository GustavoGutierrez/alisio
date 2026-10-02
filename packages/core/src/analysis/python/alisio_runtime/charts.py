"""Interactive, responsive charts for one self-contained HTML dashboard (Chart.js, bundled).

Chart.js (MIT, ``chart.umd.min.js`` next to this file) is inlined into the page ONCE by ``page`` /
``write``; there is no CDN and no network access, so it works in Alisio's viewer, offline and in the
downloaded file. Every chart function returns an HTML fragment (a ``<figure>`` with a canvas, a
screen-reader label and a data table); put fragments in ``card``/``grid`` and finish with
``write(name, title, body)``.

    from alisio_runtime import charts
    body = charts.grid(
        charts.card("Order status", charts.donut(["Delivered", "In transit"], [81.7, 14.8])),
        charts.card("Sales by seller", charts.bar(sellers, {"Sales": sales, "Profit": profit},
                                                  fmt="currency:USD", locale="en-US")),
    )
    charts.write("dashboard.html", "Sales", charts.kpis(("Orders", "1,204")) + body)

``fmt`` is "number" (default), "integer", "percent" (values are fractions: 0.12 -> 12%), "compact",
"currency:USD" (any ISO code) or a dict of ``Intl.NumberFormat`` options; ``locale`` is a BCP 47 tag
such as "es-CO" (default: the viewer's locale); ``unit`` appends a unit ("kg"). The chart colours are
a fixed-order, colour-blind-safe palette that follows the page's light/dark scheme.
"""

import html as _html
import json
import math
import sys
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple, Union

from . import html as _htmlmod
from . import svg as _svg

MAX_SERIES = _svg.MAX_SERIES
Series = Union[Sequence[object], Dict[str, Sequence[object]]]
Fmt = Union[None, str, Dict[str, object]]

_LIB = Path(__file__).with_name("chart.umd.min.js")

CSS = """
:root{color-scheme:light dark;--ac-surface:#fcfcfb;--ac-card:#fcfcfb;--ac-text:#0b0b0b;--ac-muted:#52514e;--ac-grid:#e4e3df;--ac-border:#d9d8d3;
--ac-c1:#2a78d6;--ac-c2:#eb6834;--ac-c3:#1baf7a;--ac-c4:#eda100;--ac-c5:#e87ba4;--ac-c6:#008300;--ac-c7:#4a3aa7;--ac-c8:#e34948;--ac-other:#8a8f98}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){--ac-surface:#1a1a19;--ac-card:#222221;--ac-text:#ffffff;--ac-muted:#c3c2b7;--ac-grid:#3a3a38;--ac-border:#3a3a38;
--ac-c1:#3987e5;--ac-c2:#d95926;--ac-c3:#199e70;--ac-c4:#c98500;--ac-c5:#d55181;--ac-c6:#008300;--ac-c7:#9085e9;--ac-c8:#e66767;--ac-other:#8a8f98}}
:root[data-theme="dark"]{color-scheme:dark;--ac-surface:#1a1a19;--ac-card:#222221;--ac-text:#ffffff;--ac-muted:#c3c2b7;--ac-grid:#3a3a38;--ac-border:#3a3a38;
--ac-c1:#3987e5;--ac-c2:#d95926;--ac-c3:#199e70;--ac-c4:#c98500;--ac-c5:#d55181;--ac-c6:#008300;--ac-c7:#9085e9;--ac-c8:#e66767;--ac-other:#8a8f98}
body{background:var(--ac-surface);color:var(--ac-text);max-width:1280px;margin:0 auto}
h1{font-size:1.5rem;margin:0 0 16px}
th{background:transparent;color:var(--ac-muted);font-weight:600}th,td{border-color:var(--ac-border)}
.ac-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(100%,var(--ac-min,340px)),1fr));margin:16px 0}
.ac-card{background:var(--ac-card);border:1px solid var(--ac-border);border-radius:10px;padding:16px;min-width:0}
.ac-card h2,.ac-card h3{font-size:1rem;margin:0 0 12px}
.ac-note{color:var(--ac-muted);font-size:.85rem;margin:8px 0 0}
.ac-kpis{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin:0 0 16px}
.ac-kpi{background:var(--ac-card);border:1px solid var(--ac-border);border-radius:10px;padding:12px 16px}
.ac-kpi b{display:block;font-size:1.6rem;line-height:1.2}.ac-kpi span{color:var(--ac-muted);font-size:.85rem}
figure.ac-chart{margin:0}
.ac-title{font-weight:600;margin:0 0 8px}
.ac-box{position:relative;width:100%;height:var(--ac-h,320px);min-height:220px}
.ac-box canvas{max-width:100%}
.ac-pending .ac-box{display:none}
.ac-data{margin-top:8px;font-size:.85rem;color:var(--ac-muted)}
.ac-data summary{cursor:pointer}
.ac-data .ac-scroll{overflow-x:auto}
.ac-data table{margin:8px 0}
.ac-empty{color:var(--ac-muted);padding:24px 0;text-align:center}
@media (max-width:520px){body{padding:12px}.ac-card{padding:12px}}
"""

# Reads every <figure data-ac-chart> spec (JSON) and draws it with Chart.js. No eval, no network.
_BOOT = r"""
(function(){
var doc=document,root=doc.documentElement,figs=[],cleanups=[];
function css(n,f){var v=getComputedStyle(root).getPropertyValue(n).trim();return v||f}
function pal(){var p=[];for(var i=1;i<=8;i++)p.push(css('--ac-c'+i,'#888'));return p}
function lum(hex){var m=/^#?([0-9a-f]{6})$/i.exec(hex||'');if(!m)return .5;var n=parseInt(m[1],16),r=n>>16&255,g=n>>8&255,b=n&255;
 function c(x){x/=255;return x<=.03928?x/12.92:Math.pow((x+.055)/1.055,2.4)}return .2126*c(r)+.7152*c(g)+.0722*c(b)}
function alpha(hex,a){var m=/^#?([0-9a-f]{6})$/i.exec(hex||'');if(!m)return hex;var n=parseInt(m[1],16);return 'rgba('+(n>>16&255)+','+(n>>8&255)+','+(n&255)+','+a+')'}
function mkfmt(f,compact){f=f||{};var o={},k;for(k in (f.options||{}))o[k]=f.options[k];
 if(compact){o.notation='compact';o.maximumFractionDigits=1;delete o.minimumFractionDigits}
 var nf;try{nf=new Intl.NumberFormat(f.locale||undefined,o)}catch(e){nf=new Intl.NumberFormat(undefined)}
 var u=f.unit?' '+f.unit:'';return function(v){return v==null||isNaN(v)?'':nf.format(v)+u}}
var pcts={};function pct(x,l){var k=l||'';if(!pcts[k]){try{pcts[k]=new Intl.NumberFormat(l||undefined,{style:'percent',minimumFractionDigits:1,maximumFractionDigits:1})}catch(e){pcts[k]=new Intl.NumberFormat(undefined,{style:'percent'})}}return pcts[k].format(x)}
function short(s,n){s=String(s);return s.length>n?s.slice(0,n-1)+'…':s}
function labelsPlugin(spec,fmt,ink){return{id:'acLabels',afterDatasetsDraw:function(chart){
 var ctx=chart.ctx,type=spec.kind;ctx.save();ctx.font='600 12px '+Chart.defaults.font.family;ctx.textBaseline='middle';
 chart.data.datasets.forEach(function(ds,i){var meta=chart.getDatasetMeta(i);if(meta.hidden)return;
  meta.data.forEach(function(el,j){if(el.hidden)return;var v=ds.data[j];if(v==null)return;
   if(type==='pie'||type==='donut'){var p=spec.percents[j];if(p<6)return;var pos=el.tooltipPosition();
    ctx.fillStyle=lum(ds.backgroundColor[j])>.42?'#111':'#fff';ctx.textAlign='center';ctx.fillText(pct(p/100,spec.fmt.locale),pos.x,pos.y);return}
   if(!spec.valueLabels||spec.stacked)return;ctx.fillStyle=ink;
   if(type==='hbar'){ctx.textAlign=v>=0?'left':'right';ctx.fillText(fmt(v),el.x+(v>=0?5:-5),el.y)}
   else if(type==='bar'){ctx.textAlign='center';ctx.fillText(fmt(v),el.x,el.y+(v>=0?-9:9))}})});ctx.restore()}}}
function build(fig){
 var spec=JSON.parse(fig.querySelector('script[type="application/json"]').textContent);
 var canvas=fig.querySelector('canvas'),colors=pal(),ink=css('--ac-text','#111'),muted=css('--ac-muted','#555'),grid=css('--ac-grid','#ddd'),surface=css('--ac-surface','#fff');
 var fmt=mkfmt(spec.fmt),axisFmt=mkfmt(spec.fmt,true),lblFmt=spec.series.length>1?axisFmt:fmt,kind=spec.kind,pie=kind==='pie'||kind==='donut';
 var cfg={options:{responsive:true,maintainAspectRatio:false,animation:{duration:matchMedia('(prefers-reduced-motion: reduce)').matches?0:250},
  layout:{padding:{top:kind==='bar'&&spec.valueLabels?14:2,right:kind==='hbar'?40:4}},
  plugins:{legend:{display:pie||spec.series.length>1,position:'bottom',labels:{color:ink,usePointStyle:true,pointStyle:'rectRounded',boxWidth:10,boxHeight:10,padding:14}},
   tooltip:{callbacks:{}}}},plugins:[labelsPlugin(spec,lblFmt,ink)]};
 var o=cfg.options,i;
 Chart.defaults.color=muted;Chart.defaults.font.family='system-ui,-apple-system,"Segoe UI",Roboto,sans-serif';Chart.defaults.font.size=12.5;
 if(pie){var d=spec.series[0].data,bg=d.map(function(_,j){return spec.otherLast&&j===d.length-1?css('--ac-other','#8a8f98'):colors[j%8]});
  cfg.type=kind==='donut'?'doughnut':'pie';cfg.data={labels:spec.labels,datasets:[{data:d,backgroundColor:bg,borderColor:surface,borderWidth:2,hoverOffset:6}]};
  if(kind==='donut')o.cutout='58%';
  o.plugins.legend.labels.generateLabels=function(chart){var base=Chart.overrides.doughnut.plugins.legend.labels.generateLabels(chart);
   base.forEach(function(it,j){it.text=short(it.text,28)+' · '+pct(spec.percents[j]/100,spec.fmt.locale);it.fontColor=ink;it.strokeStyle=surface;it.lineWidth=0});return base};
  o.plugins.tooltip.callbacks.label=function(c){return ' '+c.label+': '+fmt(c.parsed)+' ('+pct(spec.percents[c.dataIndex]/100,spec.fmt.locale)+')'};
  if(kind==='donut'&&spec.center){cfg.plugins.push({id:'acCenter',afterDraw:function(ch){var a=ch.chartArea,c=ch.ctx;c.save();c.fillStyle=ink;c.textAlign='center';c.textBaseline='middle';
   c.font='700 18px '+Chart.defaults.font.family;c.fillText(spec.center,(a.left+a.right)/2,(a.top+a.bottom)/2);c.restore()}})}
 }else{
  var horiz=kind==='hbar',xy=kind==='scatter';
  cfg.type=kind==='hbar'?'bar':kind==='area'?'line':kind;
  cfg.data={labels:spec.labels,datasets:spec.series.map(function(s,j){var c=colors[j%8],ds={label:s.name||'',data:s.data,backgroundColor:c,borderColor:c};
   if(kind==='bar'||kind==='hbar'){ds.borderRadius=4;ds.maxBarThickness=56;ds.borderSkipped=false}
   if(kind==='line'||kind==='area'){ds.borderWidth=2;ds.tension=spec.smooth?.3:0;ds.pointRadius=spec.labels.length>30?0:3;ds.pointHoverRadius=5;ds.pointBackgroundColor=c;ds.pointBorderColor=surface;ds.pointBorderWidth=1.5;ds.spanGaps=false;
    if(kind==='area'){ds.fill=spec.stacked?(j===0?'origin':'-1'):'origin';ds.backgroundColor=alpha(c,.2)}}
   if(xy){ds.pointRadius=4;ds.pointHoverRadius=6;ds.pointBackgroundColor=alpha(c,.8);ds.pointBorderColor=c}
   return ds})};
  if(horiz)o.indexAxis='y';
  var cat={grid:{display:false},border:{color:grid},ticks:{color:muted,autoSkip:true,maxRotation:horiz?0:45,callback:function(v){var w=this.chart.width;return short(this.getLabelForValue(v),horiz?(w<420?15:24):(w<420?10:18))}}};
  var val={beginAtZero:kind!=='line'&&!xy,stacked:!!spec.stacked,grace:spec.valueLabels&&!spec.stacked?'8%':0,grid:{color:grid},border:{display:false},ticks:{color:muted,callback:function(v){return axisFmt(v)}}};
  if(xy){cat={type:'linear',grid:{color:grid},border:{color:grid},ticks:{color:muted,callback:function(v){return axisFmt(v)}}};val.beginAtZero=false}
  if(spec.xTitle)cat.title={display:true,text:spec.xTitle,color:muted};if(spec.yTitle)val.title={display:true,text:spec.yTitle,color:muted};
  if(spec.stacked)cat.stacked=true;
  o.scales=horiz?{y:cat,x:val}:{x:cat,y:val};
  if(kind==='line'||kind==='area'){o.interaction={mode:'index',intersect:false}}
  else if(kind==='bar'||kind==='hbar')o.interaction={mode:'index',intersect:false};
  o.plugins.tooltip.callbacks.label=function(c){var v=horiz?c.parsed.x:xy?c.parsed.y:c.parsed.y,n=c.dataset.label?c.dataset.label+': ':'';
   return ' '+n+(xy?fmt(c.parsed.x)+', ':'')+fmt(v)};
  if(xy)o.plugins.tooltip.callbacks.title=function(){return ''};
 }
 if(fig._chart)fig._chart.destroy();
 fig._chart=new Chart(canvas,cfg);
}
function tables(){doc.querySelectorAll('figure[data-ac-chart] td[data-v]').forEach(function(td){
 var f=td.closest('figure'),spec=f._spec||(f._spec=JSON.parse(f.querySelector('script[type="application/json"]').textContent)),
  n=parseFloat(td.getAttribute('data-v'));if(!isNaN(n))td.textContent=mkfmt(spec.fmt)(n)})}
function draw(){doc.querySelectorAll('figure[data-ac-chart]').forEach(function(fig){
 try{build(fig);fig.classList.remove('ac-pending');var d=fig.querySelector('details');if(d&&!fig._opened){d.removeAttribute('open');fig._opened=1}}
 catch(e){fig.classList.add('ac-pending');if(window.console)console.error('alisio chart failed',e)}})}
function start(){if(typeof Chart==='undefined'){return}tables();draw();
 try{matchMedia('(prefers-color-scheme: dark)').addEventListener('change',draw)}catch(e){}}
if(doc.readyState==='loading')doc.addEventListener('DOMContentLoaded',start);else start();
})();
"""


def _esc(text: object) -> str:
    return _html.escape(str(text), quote=True)


def _json(data: object) -> str:
    # Safe inside <script>: no "</script>" and no HTML comments can appear.
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def _warn(message: str) -> None:
    print(f"alisio_runtime.charts: {message}", file=sys.stderr)


def _number(value: object) -> Optional[float]:
    return _svg._finite(value)


def _fmt_spec(fmt: Fmt, locale: Optional[str], unit: Optional[str], values: Sequence[float]) -> Dict[str, object]:
    options: Dict[str, object]
    if fmt is None or fmt == "number":
        options = {"maximumFractionDigits": 2}
    elif fmt == "integer":
        options = {"maximumFractionDigits": 0}
    elif fmt == "percent":
        options = {"style": "percent", "maximumFractionDigits": 1}
    elif fmt == "compact":
        options = {"notation": "compact", "maximumFractionDigits": 1}
    elif isinstance(fmt, str) and fmt.startswith("currency:"):
        code = fmt.split(":", 1)[1].strip().upper()
        big = max((abs(v) for v in values), default=0) >= 1000
        options = {"style": "currency", "currency": code}
        if big:
            options["maximumFractionDigits"] = 0
    elif isinstance(fmt, dict):
        options = dict(fmt)
    else:
        raise ValueError(f'fmt must be None, "number", "integer", "percent", "compact", "currency:USD" or a dict, not {fmt!r}')
    spec: Dict[str, object] = {"options": options}
    if locale:
        spec["locale"] = locale
    if unit:
        spec["unit"] = unit
    return spec


def _plain(value: float) -> str:
    return f"{value:.6g}"


def _summary(kind: str, title: Optional[str], labels: Sequence[str], series: Sequence[Tuple[str, Sequence[Optional[float]]]]) -> str:
    parts = []
    for i, label in enumerate(labels[:8]):
        cells = ", ".join(f"{(n + ' ') if n else ''}{_plain(d[i])}" for n, d in series if i < len(d) and d[i] is not None)
        parts.append(f"{label}: {cells}")
    more = f" and {len(labels) - 8} more" if len(labels) > 8 else ""
    return f"{title + '. ' if title else ''}{kind} chart. " + "; ".join(parts) + more


def _table(headers: Sequence[str], rows: Sequence[Sequence[object]]) -> str:
    head = "".join(f"<th>{_esc(h)}</th>" for h in headers)
    body = ""
    for row in rows:
        cells = ""
        for j, cell in enumerate(row):
            if j and isinstance(cell, (int, float)) and not isinstance(cell, bool):
                cells += f'<td data-v="{_plain(cell)}">{_plain(cell)}</td>'
            else:
                cells += f"<td>{_esc('' if cell is None else cell)}</td>"
        body += f"<tr>{cells}</tr>"
    return f'<div class="ac-scroll"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'


def _default_height(kind: str, count: int, series: int) -> int:
    if kind == "hbar":
        return max(240, min(900, 56 + count * (24 if series == 1 else 18 * series + 10)))
    if kind in ("pie", "donut"):
        return 340
    return 320


def _fragment(spec: Dict[str, object], title: Optional[str], height: Optional[int], summary: str, headers: Sequence[str], rows: Sequence[Sequence[object]], note: Optional[str]) -> str:
    h = int(height) if height else _default_height(str(spec["kind"]), len(spec.get("labels", [])), len(spec["series"]))  # type: ignore[arg-type]
    caption = f'<figcaption class="ac-title">{_esc(title)}</figcaption>' if title else ""
    foot = f'<p class="ac-note">{_esc(note)}</p>' if note else ""
    return (
        f'<figure class="ac-chart ac-pending" data-ac-chart="{_esc(spec["kind"])}">{caption}'
        f'<div class="ac-box" style="--ac-h:{h}px"><canvas role="img" aria-label="{_esc(summary)}">{_esc(summary)}</canvas></div>'
        f'<details class="ac-data" open><summary>Data table</summary>{_table(headers, rows)}</details>{foot}'
        f'<script type="application/json">{_json(spec)}</script></figure>'
    )


def _empty(message: str = "No data to chart") -> str:
    _warn(message)
    return f'<p class="ac-empty">{_esc(message)}</p>'


def _labels(labels: Iterable[object]) -> List[str]:
    return [str(label) for label in labels]


def _share(kind: str, labels: Iterable[object], values: Iterable[object], title, fmt, locale, unit, height, max_slices, center, note) -> str:
    raw_labels, raw_values = _labels(labels), list(values)
    if len(raw_labels) != len(raw_values):
        raise ValueError(f"labels ({len(raw_labels)}) and values ({len(raw_values)}) must have the same length")
    dropped = [l for l, v in zip(raw_labels, raw_values) if not ((_number(v) or 0) > 0)]
    if dropped:
        _warn(f"{len(dropped)} categories without a positive value were left out of the {kind}: {', '.join(dropped[:5])}")
    names, nums = _svg.group_small(raw_labels, raw_values, max_slices=max_slices, min_fraction=0.0 if len(raw_labels) <= max_slices else 0.02)
    if not nums:
        return _empty()
    if len(raw_labels) - len(dropped) > len(names):
        _warn(f'categories beyond {max_slices} were grouped into "Other"; use hbar() to show them all')
    total = sum(nums)
    percents = [round(100.0 * v / total, 2) for v in nums]
    other = len(raw_labels) - len(dropped) > len(names)
    spec = {
        "v": 1, "kind": kind, "labels": names, "series": [{"name": "", "data": nums}], "percents": percents,
        "fmt": _fmt_spec(fmt, locale, unit, nums), "otherLast": bool(other), **({"center": center} if center else {}),
    }
    rows = [[n, v, p] for n, v, p in zip(names, nums, percents)]
    summary = _summary("Donut" if kind == "donut" else "Pie", title, names, [("", nums)]) + " Shares: " + ", ".join(f"{n} {p:.1f}%" for n, p in zip(names, percents)) + "."
    return _fragment(spec, title, height, summary, ["Category", "Value", "Share (%)"], rows, note)


def pie(labels: Iterable[object], values: Iterable[object], title: Optional[str] = None, fmt: Fmt = None, locale: Optional[str] = None,
        unit: Optional[str] = None, height: Optional[int] = None, max_slices: int = 6, note: Optional[str] = None) -> str:
    """A pie of shares (slices and legend show the percentage). Use for 2-5 parts of a whole; more than
    ``max_slices`` categories fold into "Other" (use ``hbar`` or ``donut`` instead)."""
    return _share("pie", labels, values, title, fmt, locale, unit, height, max_slices, None, note)


def donut(labels: Iterable[object], values: Iterable[object], title: Optional[str] = None, fmt: Fmt = None, locale: Optional[str] = None,
          unit: Optional[str] = None, height: Optional[int] = None, max_slices: int = 8, center: Optional[str] = None, note: Optional[str] = None) -> str:
    """A donut of shares; ``center`` is text for the hole (for example the total)."""
    return _share("donut", labels, values, title, fmt, locale, unit, height, max_slices, center, note)


def _cartesian(kind: str, labels: Iterable[object], values: Series, title, fmt, locale, unit, height, stacked, value_labels, smooth, x_title, y_title, note) -> str:
    names = _labels(labels)
    series = _svg._series(values)
    if not names or not any(v is not None for _, d in series for v in d):
        return _empty()
    count = len(names)
    fixed = []
    for name, data in series:
        if len(data) != count:
            _warn(f"series {name or ''!r} has {len(data)} values for {count} labels; padded or cut to match")
        fixed.append((name or "", (data + [None] * count)[:count]))
    invalid = sum(1 for _, d in fixed for v in d if v is None)
    if invalid:
        _warn(f"{invalid} missing or non-numeric values are shown as gaps")
    flat = [v for _, d in fixed for v in d if v is not None]
    spec = {
        "v": 1, "kind": kind, "labels": names, "series": [{"name": n, "data": d} for n, d in fixed], "stacked": bool(stacked),
        "valueLabels": bool(value_labels) and count * len(fixed) <= 16, "smooth": bool(smooth),
        "fmt": _fmt_spec(fmt, locale, unit, flat),
        **({"xTitle": x_title} if x_title else {}), **({"yTitle": y_title} if y_title else {}),
    }
    headers = ["Category"] + [n or "Value" for n, _ in fixed]
    rows = [[names[i]] + [d[i] for _, d in fixed] for i in range(count)]
    summary = _summary({"bar": "Bar", "hbar": "Horizontal bar", "line": "Line", "area": "Area"}[kind], title, names, fixed)
    return _fragment(spec, title, height, summary, headers, rows, note)


def bar(labels: Iterable[object], values: Series, title: Optional[str] = None, fmt: Fmt = None, locale: Optional[str] = None, unit: Optional[str] = None,
        height: Optional[int] = None, stacked: bool = False, value_labels: bool = True, x_title: Optional[str] = None, y_title: Optional[str] = None, note: Optional[str] = None) -> str:
    """Vertical bars. ``values`` is a sequence or ``{series name: sequence}`` (grouped, or ``stacked=True``)."""
    return _cartesian("bar", labels, values, title, fmt, locale, unit, height, stacked, value_labels, False, x_title, y_title, note)


def hbar(labels: Iterable[object], values: Series, title: Optional[str] = None, fmt: Fmt = None, locale: Optional[str] = None, unit: Optional[str] = None,
         height: Optional[int] = None, stacked: bool = False, value_labels: bool = True, x_title: Optional[str] = None, y_title: Optional[str] = None, note: Optional[str] = None) -> str:
    """Horizontal bars: the best form for rankings, long labels and more than 5 categories."""
    return _cartesian("hbar", labels, values, title, fmt, locale, unit, height, stacked, value_labels, False, x_title, y_title, note)


def line(labels: Iterable[object], values: Series, title: Optional[str] = None, fmt: Fmt = None, locale: Optional[str] = None, unit: Optional[str] = None,
         height: Optional[int] = None, smooth: bool = False, x_title: Optional[str] = None, y_title: Optional[str] = None, note: Optional[str] = None) -> str:
    """Lines over ordered ``labels`` (dates as text, months…); ``values`` as in ``bar``."""
    return _cartesian("line", labels, values, title, fmt, locale, unit, height, False, False, smooth, x_title, y_title, note)


def area(labels: Iterable[object], values: Series, title: Optional[str] = None, fmt: Fmt = None, locale: Optional[str] = None, unit: Optional[str] = None,
         height: Optional[int] = None, stacked: bool = False, smooth: bool = False, x_title: Optional[str] = None, y_title: Optional[str] = None, note: Optional[str] = None) -> str:
    """Filled lines; ``stacked=True`` stacks the series."""
    return _cartesian("area", labels, values, title, fmt, locale, unit, height, stacked, False, smooth, x_title, y_title, note)


def scatter(xs: Iterable[object], ys: Series, title: Optional[str] = None, fmt: Fmt = None, locale: Optional[str] = None, unit: Optional[str] = None,
            height: Optional[int] = None, x_title: Optional[str] = None, y_title: Optional[str] = None, note: Optional[str] = None) -> str:
    """Points ``(x, y)``; ``ys`` is a sequence or ``{series name: sequence}`` sharing ``xs``."""
    xv = [_number(x) for x in xs]
    series = _svg._series(ys)
    pairs_ok = [i for i, x in enumerate(xv) if x is not None]
    if not pairs_ok or not any(v is not None for _, d in series for v in d):
        return _empty()
    spec_series = []
    flat: List[float] = [xv[i] for i in pairs_ok]  # type: ignore[misc]
    for name, data in series:
        data = (data + [None] * len(xv))[: len(xv)]
        points = [{"x": xv[i], "y": data[i]} for i in pairs_ok if data[i] is not None]
        flat += [p["y"] for p in points]  # type: ignore[misc]
        spec_series.append({"name": name or "", "data": points})
    skipped = len(xv) - len(pairs_ok)
    if skipped:
        _warn(f"{skipped} points without a numeric x were left out")
    spec = {"v": 1, "kind": "scatter", "labels": [], "series": spec_series, "fmt": _fmt_spec(fmt, locale, unit, flat),
            **({"xTitle": x_title} if x_title else {}), **({"yTitle": y_title} if y_title else {})}
    rows = [[xv[i]] + [d[i] if i < len(d) else None for _, d in series] for i in pairs_ok][:200]
    summary = f"{title + '. ' if title else ''}Scatter chart with {len(pairs_ok)} points."
    return _fragment(spec, title, height, summary, [x_title or "x"] + [n or (y_title or "y") for n, _ in series], rows, note)


# ------------------------------------------------------------------------ layout and page


def card(title: Optional[str], *content: str, note: Optional[str] = None) -> str:
    """A bordered card with a heading around one chart (or any HTML). One chart per card."""
    head = f"<h3>{_esc(title)}</h3>" if title else ""
    foot = f'<p class="ac-note">{_esc(note)}</p>' if note else ""
    return f'<section class="ac-card">{head}{"".join(content)}{foot}</section>'


def grid(*cards: str, min_width: int = 340) -> str:
    """Cards in a responsive grid: columns of at least ``min_width`` px that stack on a phone."""
    return f'<div class="ac-grid" style="--ac-min:{int(min_width)}px">{"".join(cards)}</div>'


def kpis(*items: Union[Tuple[str, object], Tuple[str, object, str]]) -> str:
    """A row of headline numbers: ``kpis(("Orders", "1,204"), ("Revenue", "$1.2M", "+8% vs last month"))``."""
    cells = ""
    for item in items:
        label, value = item[0], item[1]
        extra = f"<span>{_esc(item[2])}</span>" if len(item) > 2 else ""  # type: ignore[misc]
        cells += f'<div class="ac-kpi"><span>{_esc(label)}</span><b>{_esc(value)}</b>{extra}</div>'
    return f'<div class="ac-kpis">{cells}</div>'


def library() -> str:
    """The Chart.js source (``chart.umd.min.js`` next to this file), or "" when it is missing."""
    try:
        return _LIB.read_text(encoding="utf-8")
    except OSError:
        return ""


def scripts() -> str:
    """The <script> tags that draw every chart of the page: add them ONCE, at the end of the body.
    ``page`` and ``write`` already do it."""
    lib = library()
    if not lib:
        _warn("chart.umd.min.js is missing: the charts will show their data tables only")
        return f"<script>{_BOOT}</script>"
    safe = lib.replace("</script", "<\\/script")
    return f"<script>{safe}</script><script>{_BOOT}</script>"


def page(title: str, body: str, css: Optional[str] = None, lang: str = "en") -> str:
    """A complete page (theme-aware CSS, Chart.js inlined once, charts drawn on load)."""
    heading = f"<h1>{_esc(title)}</h1>" if "<h1" not in body else ""
    return _htmlmod.page(title, heading + body + scripts(), CSS + (css or ""), lang=lang)


def write(name: str, title: str, body: str, css: Optional[str] = None, lang: str = "en") -> Path:
    """Writes the dashboard page to the output folder and returns its path."""
    from . import outputs

    target = outputs.path(name)
    target.write_text(page(title, body, css, lang), encoding="utf-8")
    return target
