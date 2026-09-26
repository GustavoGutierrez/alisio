import type {
  EditorTheme,
  ImageTheme,
  MarkdownTheme,
  SelectListTheme,
} from "@earendil-works/pi-tui";
import type { Level } from "./state.ts";

const enabled = !process.env.NO_COLOR;
const sgr =
  (open: number | string, close: number) =>
  (text: string): string =>
    enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text;

export const style = {
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  italic: sgr(3, 23),
  underline: sgr(4, 24),
  strike: sgr(9, 29),
  red: sgr(31, 39),
  green: sgr(32, 39),
  yellow: sgr(33, 39),
  blue: sgr(34, 39),
  magenta: sgr(35, 39),
  cyan: sgr(36, 39),
  gray: sgr(90, 39),
  brightCyan: sgr(96, 39),
  userBg: sgr("48;5;236", 49),
};
export const levelColor = (level: Level) =>
  level === "ok" ? style.green : level === "warn" ? style.yellow : style.red;

export const markdownTheme: MarkdownTheme = {
  heading: (t) => style.bold(style.cyan(t)),
  link: (t) => style.underline(style.blue(t)),
  linkUrl: (t) => style.dim(t),
  code: (t) => style.yellow(t),
  codeBlock: (t) => style.green(t),
  codeBlockBorder: (t) => style.dim(t),
  quote: (t) => style.italic(style.gray(t)),
  quoteBorder: (t) => style.dim(t),
  hr: (t) => style.dim(t),
  listBullet: (t) => style.cyan(t),
  bold: (t) => style.bold(t),
  italic: (t) => style.italic(t),
  strikethrough: (t) => style.strike(t),
  underline: (t) => style.underline(t),
};
export const selectListTheme: SelectListTheme = {
  selectedPrefix: (t) => style.cyan(t),
  selectedText: (t) => style.bold(style.cyan(t)),
  description: (t) => style.gray(t),
  scrollInfo: (t) => style.dim(t),
  noMatch: (t) => style.yellow(t),
};
export const editorTheme: EditorTheme = {
  borderColor: (t) => style.gray(t),
  selectList: selectListTheme,
};
export const imageTheme: ImageTheme = {
  fallbackColor: (t) => style.gray(t),
};
