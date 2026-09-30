/** Inline stroke icons (no icon font, no network). Decorative: always aria-hidden. */
import type { JSX } from "preact";

const PATHS = {
  plus: "M12 5v14M5 12h14",
  plusCircle: "M12 8v8M8 12h8M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4",
  archive: "M4 7h16M5 7l1 12h12l1-12M9 11h6M3 4h18v3H3z",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
  folderPlus:
    "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7ZM12 10v6M9 13h6",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
  panel: "M4 5h16v14H4zM9 5v14",
  chevronDown: "M6 9l6 6 6-6",
  chevronRight: "M9 6l6 6-6 6",
  copy: "M9 9h10v10H9zM5 15V5h10",
  check: "M5 12l5 5 9-10",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  arrowUp: "M12 19V5M6 11l6-6 6 6",
  arrowDown: "M12 5v14M6 13l6 6 6-6",
  home: "M4 11l8-7 8 7M6 9.5V20h12V9.5M10 20v-5h4v5",
  shield: "M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z",
  file: "M6 3h8l4 4v14H6zM14 3v4h4",
  terminal: "M4 5h16v14H4zM8 10l3 2-3 2M13 15h3",
  sparkle: "M12 4v4M12 16v4M4 12h4M16 12h4M7 7l2 2M15 15l2 2M17 7l-2 2M9 15l-2 2",
  layers: "M12 4l8 4-8 4-8-4 8-4ZM4 12l8 4 8-4M4 16l8 4 8-4",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8h.01",
  alert: "M12 3l10 18H2L12 3ZM12 10v5M12 18h.01",
  x: "M6 6l12 12M18 6L6 18",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  pin: "M9 3h6l-1 6 3 3H7l3-3-1-6ZM12 12v9",
  menu: "M4 7h16M4 12h16M4 17h16",
  tool: "M14 7a4 4 0 0 0-5 5l-5 5 3 3 5-5a4 4 0 0 0 5-5l-2 2-3-3 2-2Z",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  edit: "M4 20h4L19 9l-4-4L4 16v4ZM13 7l4 4",
  question:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01",
  expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  database:
    "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3ZM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  sliders: "M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4",
  book: "M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4ZM5 17a3 3 0 0 1 3-3h10",
  plug: "M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v4",
  users:
    "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14c2 .8 3 2.8 3 6",
  palette:
    "M12 21a9 9 0 1 1 9-9c0 2.5-2 3-3.5 3H16a2 2 0 0 0-1.5 3.3c.4.5.3 1.4-.3 1.9-.6.5-1.4.8-2.2.8ZM7.5 11h.01M10 7.5h.01M14.5 7.5h.01",
  key: "M15 9a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM13.8 11.8L20 18v3h-3v-2h-2v-2h-2l-1.2-1.2",
} as const;

/** Solid glyphs: filled with `currentColor`, no stroke (e.g. the stop square). */
const FILLED = {
  stop: "M9 7h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z",
} as const;

export type IconName = keyof typeof PATHS | keyof typeof FILLED;

/** Whether an icon renders filled rather than stroked. */
export const isFilledIcon = (name: IconName): name is keyof typeof FILLED => name in FILLED;

export function Icon(props: { name: IconName; size?: number; class?: string }): JSX.Element {
  const size = props.size ?? 16;
  const filled = isFilledIcon(props.name);
  return (
    <svg
      class={props.class}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      stroke-width={filled ? undefined : "1.8"}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={
          filled
            ? FILLED[props.name as keyof typeof FILLED]
            : PATHS[props.name as keyof typeof PATHS]
        }
      />
    </svg>
  );
}
