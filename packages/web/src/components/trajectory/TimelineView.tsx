import { type MessageKey, t } from "../../i18n/index.ts";
import { formatSeconds } from "../../store/stats.ts";
import type {
  ExecutionTimeline,
  TimelineKind,
  TimelineLaneId,
  ToolDuration,
  TurnTokens,
} from "../../store/trajectory.ts";
import styles from "./trajectory.module.css";

/** Lane and legend colours, from the app palette. */
const KIND_COLOR: Record<TimelineKind, string> = {
  model: "var(--accent)",
  tool: "var(--ok)",
  question: "var(--warn)",
  approval: "var(--danger)",
};

const LANE_LABEL: Record<TimelineLaneId, MessageKey> = {
  model: "trajectory.lane.model",
  tool: "trajectory.lane.tool",
  user: "trajectory.lane.user",
};

const LEGEND: Array<{ kind: TimelineKind; key: MessageKey }> = [
  { kind: "model", key: "trajectory.legend.model" },
  { kind: "tool", key: "trajectory.legend.tool" },
  { kind: "question", key: "trajectory.legend.question" },
  { kind: "approval", key: "trajectory.legend.approval" },
];

/** `m:ss` (or `h:mm:ss` past an hour): the axis and tooltips stay compact. */
const mmss = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const base = `${m}:${String(s).padStart(2, "0")}`;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : base;
};

const fmtTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

const TICK_STEPS = [
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000,
];
function timeTicks(total: number): number[] {
  const target = total / 8;
  const step =
    TICK_STEPS.find((candidate) => candidate >= target) ??
    TICK_STEPS[TICK_STEPS.length - 1] ??
    60_000;
  const ticks: number[] = [];
  for (let ms = 0; ms <= total + 1; ms += step) ticks.push(ms);
  return ticks;
}

const W = 1000;
const PAD = { top: 16, right: 18, bottom: 36, left: 122 };
const ROW = 30;
const BAR = 14;

/** The trace waterfall: one row per lane, one bar per interval, on a shared time axis. */
function Waterfall({ timeline }: { timeline: ExecutionTimeline }) {
  const total = Math.max(1, timeline.endAt - timeline.startAt);
  const plotW = W - PAD.left - PAD.right;
  const height = PAD.top + timeline.lanes.length * ROW + PAD.bottom;
  const axisY = height - PAD.bottom;
  const x = (at: number) => PAD.left + ((at - timeline.startAt) / total) * plotW;
  return (
    <svg
      class={styles.chart}
      viewBox={`0 0 ${W} ${height}`}
      role="img"
      aria-label={t("trajectory.waterfall")}
    >
      {timeline.lanes.map((lane, i) => {
        const y = PAD.top + i * ROW;
        return (
          <g key={lane.id}>
            <text
              x={PAD.left - 12}
              y={y + ROW / 2}
              class={styles.laneLabel}
              dominant-baseline="middle"
            >
              {t(LANE_LABEL[lane.id])}
            </text>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y + ROW / 2}
              y2={y + ROW / 2}
              class={styles.grid}
            />
            {lane.intervals.map((interval, j) => {
              const bx = x(interval.start);
              const bw = Math.max(1.5, x(interval.end) - bx);
              return (
                <rect
                  key={j}
                  x={bx}
                  y={y + (ROW - BAR) / 2}
                  width={bw}
                  height={BAR}
                  rx={2.5}
                  class={interval.error ? styles.barError : undefined}
                  style={{ fill: KIND_COLOR[interval.kind] }}
                >
                  <title>{`${interval.label} · ${formatSeconds(interval.end - interval.start)}`}</title>
                </rect>
              );
            })}
          </g>
        );
      })}
      <line x1={PAD.left} x2={W - PAD.right} y1={axisY} y2={axisY} class={styles.axis} />
      {timeTicks(total).map((ms) => {
        const tx = PAD.left + (ms / total) * plotW;
        return (
          <g key={ms}>
            <line x1={tx} x2={tx} y1={axisY} y2={axisY + 4} class={styles.axis} />
            <text x={tx} y={axisY + 17} class={styles.tick} text-anchor="middle">
              {mmss(ms)}
            </text>
          </g>
        );
      })}
      <text x={PAD.left + plotW / 2} y={height - 4} class={styles.axisLabel}>
        {t("trajectory.axis.time")}
      </text>
    </svg>
  );
}

/** A compact line/area chart for one series (tokens per turn). */
function LineChart({
  values,
  color,
  label,
  xLabel,
}: {
  values: number[];
  color: string;
  label: string;
  xLabel: string;
}) {
  const w = 460;
  const h = 190;
  const pad = { top: 18, right: 12, bottom: 30, left: 54 };
  const max = Math.max(1, ...values);
  const n = Math.max(1, values.length - 1);
  const px = (i: number) => pad.left + (i / n) * (w - pad.left - pad.right);
  const py = (v: number) => pad.top + (1 - v / max) * (h - pad.top - pad.bottom);
  const line = values
    .map((v, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(v).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${px(values.length - 1).toFixed(1)},${py(0).toFixed(1)} L${px(0).toFixed(1)},${py(0).toFixed(1)} Z`;
  return (
    <figure class={styles.chartFigure}>
      <figcaption class={styles.chartTitle}>{label}</figcaption>
      <svg class={styles.chart} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
        <path d={area} style={{ fill: color }} opacity={0.14} />
        <path d={line} style={{ stroke: color }} fill="none" stroke-width={2} />
        <line x1={pad.left} x2={w - pad.right} y1={py(0)} y2={py(0)} class={styles.axis} />
        <line x1={pad.left} x2={pad.left} y1={pad.top} y2={py(0)} class={styles.axis} />
        <text x={pad.left - 8} y={py(max) + 4} class={styles.tick} text-anchor="end">
          {fmtTokens(max)}
        </text>
        <text x={pad.left - 8} y={py(0)} class={styles.tick} text-anchor="end">
          0
        </text>
        <text x={(pad.left + w - pad.right) / 2} y={h - 4} class={styles.axisLabel}>
          {xLabel}
        </text>
      </svg>
    </figure>
  );
}

/** Accumulated time per tool, longest first. */
function ToolBars({ tools }: { tools: ToolDuration[] }) {
  const max = Math.max(1, ...tools.map((tool) => tool.durationMs));
  return (
    <ul class={styles.toolBars}>
      {tools.map((tool) => (
        <li key={tool.name}>
          <span class={styles.toolName} title={tool.name}>
            {tool.name}
          </span>
          <span class={styles.toolTrack}>
            <span
              class={styles.toolFill}
              style={{
                width: `${(tool.durationMs / max) * 100}%`,
                background: tool.error ? "var(--danger)" : "var(--ok)",
              }}
            />
          </span>
          <span class={`${styles.num} ${styles.mono}`}>{formatSeconds(tool.durationMs)}</span>
        </li>
      ))}
    </ul>
  );
}

/** The graphical view of the Trajectory tab: execution timeline, tokens and tool time. */
export function TimelineView({ timeline }: { timeline: ExecutionTimeline }) {
  const turns: TurnTokens[] = timeline.turns;
  return (
    <div class={styles.timeline}>
      <figure class={styles.chartFigure}>
        <figcaption class={styles.chartTitle}>{t("trajectory.waterfall")}</figcaption>
        <Waterfall timeline={timeline} />
      </figure>
      <ul class={styles.legend}>
        {LEGEND.map(({ kind, key }) => (
          <li key={kind}>
            <span class={styles.swatch} style={{ background: KIND_COLOR[kind] }} />
            {t(key)}
          </li>
        ))}
      </ul>
      {turns.length ? (
        <div class={styles.chartGrid}>
          <LineChart
            values={turns.map((turn) => turn.input)}
            color="var(--accent)"
            label={t("trajectory.tokensIn")}
            xLabel={t("trajectory.axis.turn")}
          />
          <LineChart
            values={turns.map((turn) => turn.output)}
            color="var(--warn)"
            label={t("trajectory.tokensOut")}
            xLabel={t("trajectory.axis.turn")}
          />
        </div>
      ) : null}
      {timeline.tools.length ? (
        <figure class={styles.chartFigure}>
          <figcaption class={styles.chartTitle}>{t("trajectory.toolDuration")}</figcaption>
          <ToolBars tools={timeline.tools} />
        </figure>
      ) : null}
    </div>
  );
}
