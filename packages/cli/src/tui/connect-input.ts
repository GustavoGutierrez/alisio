import { type Component, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { style } from "./theme.ts";

export interface ConnectInputState {
  value: string;
  cursor: number;
}

export type ConnectInputAction =
  | { type: "insert"; text: string }
  | { type: "left" | "right" | "home" | "end" | "backspace" | "delete" };

const characters = (value: string) => Array.from(value);

/** Removes terminal paste framing and controls while retaining an entire printable input chunk. */
export function printableInput(data: string): string {
  return data
    .replaceAll("\x1b[200~", "")
    .replaceAll("\x1b[201~", "")
    .replace(/[\u0000-\u001f\u007f]/g, "");
}

export function reduceConnectInput(
  state: ConnectInputState,
  action: ConnectInputAction,
): ConnectInputState {
  const value = characters(state.value);
  const cursor = Math.max(0, Math.min(state.cursor, value.length));
  if (action.type === "insert") {
    const inserted = characters(action.text);
    value.splice(cursor, 0, ...inserted);
    return { value: value.join(""), cursor: cursor + inserted.length };
  }
  if (action.type === "left") return { value: state.value, cursor: Math.max(0, cursor - 1) };
  if (action.type === "right")
    return { value: state.value, cursor: Math.min(value.length, cursor + 1) };
  if (action.type === "home") return { value: state.value, cursor: 0 };
  if (action.type === "end") return { value: state.value, cursor: value.length };
  if (action.type === "backspace" && cursor > 0) {
    value.splice(cursor - 1, 1);
    return { value: value.join(""), cursor: cursor - 1 };
  }
  if (action.type === "delete" && cursor < value.length) value.splice(cursor, 1);
  return { value: value.join(""), cursor };
}

/** Focused single-field dialog for provider configuration; secret values never leave this component. */
export class ConnectInputPrompt implements Component {
  private state: ConnectInputState;
  private replaceInitial: boolean;

  constructor(
    private options: {
      provider: string;
      label: string;
      initial: string;
      secret: boolean;
      placeholder: string;
      hint?: string;
      step: number;
      steps: number;
      onSubmit: (value: string) => void;
      onCancel: () => void;
    },
  ) {
    this.state = { value: options.initial, cursor: characters(options.initial).length };
    this.replaceInitial = !!options.initial;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) return this.options.onCancel();
    if (matchesKey(data, Key.enter)) return this.options.onSubmit(this.state.value);
    const action = matchesKey(data, Key.left)
      ? "left"
      : matchesKey(data, Key.right)
        ? "right"
        : matchesKey(data, Key.home)
          ? "home"
          : matchesKey(data, Key.end)
            ? "end"
            : matchesKey(data, Key.backspace)
              ? "backspace"
              : matchesKey(data, Key.delete)
                ? "delete"
                : undefined;
    if (action) {
      if (this.replaceInitial && (action === "backspace" || action === "delete")) {
        this.state = { value: "", cursor: 0 };
        this.replaceInitial = false;
        return;
      }
      this.replaceInitial = false;
      this.state = reduceConnectInput(this.state, { type: action });
      return;
    }
    const text = printableInput(data);
    if (text) {
      if (this.replaceInitial) this.state = { value: "", cursor: 0 };
      this.replaceInitial = false;
      this.state = reduceConnectInput(this.state, { type: "insert", text });
    }
  }

  render(width: number): string[] {
    const value = characters(this.state.value);
    const masked = this.options.secret ? value.map(() => "•") : value;
    const before = masked.slice(0, this.state.cursor).join("");
    const current = masked[this.state.cursor] ?? " ";
    const after = masked.slice(this.state.cursor + 1).join("");
    const empty = !value.length;
    const field = empty
      ? `${style.dim(this.options.placeholder)} ${style.brightCyan("▏")}`
      : `${before}${style.brightCyan(`▏${current}`)}${after}`;
    const rule = "─".repeat(Math.max(1, Math.min(56, width - 2)));
    return [
      truncateToWidth(style.cyan(`┌${rule}┐`), width),
      truncateToWidth(
        `│ ${style.bold(`Connect · ${this.options.provider}`)} ${style.dim(`(${this.options.step}/${this.options.steps})`)}`,
        width,
      ),
      truncateToWidth(`│ ${style.brightCyan("❯")} ${style.bold(this.options.label)}`, width),
      truncateToWidth(`│   ${field}`, width),
      ...(this.options.hint ? [truncateToWidth(`│   ${style.dim(this.options.hint)}`, width)] : []),
      truncateToWidth(
        `│ ${style.dim(`${this.replaceInitial ? "Paste or type to replace · " : ""}←/→ Home/End edit`)}`,
        width,
      ),
      truncateToWidth(`│ ${style.dim("Enter submit · Esc cancel")}`, width),
      truncateToWidth(style.cyan(`└${rule}┘`), width),
    ];
  }
}
