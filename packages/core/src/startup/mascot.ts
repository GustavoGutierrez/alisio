/**
 * Default mascot: "Ali", a small trade-wind cloud spirit (alisio = trade wind) blowing a
 * gust to the right. Original art; Unicode, ASCII and one-line compact variants.
 */
import type { MascotContext, MascotProvider } from "@alisio/sdk";
import { sgr } from "./text.ts";

const UNICODE = [
  "    .-~~~-.     ",
  "  .(  ◕ ◡ ◕ ).  ≋≋",
  " (___________)≋≋≋",
  "    ╰≈≈≈≈≈╯  ≋≋",
  "     ˙ ˙ ˙",
];
const ASCII = [
  "    .-~~~-.     ",
  "  .(  o u o ).  ~~",
  " (___________)~~~",
  "    `~~~~~'  ~~",
  "     . . .",
];
export const DefaultAlisioMascot: MascotProvider = {
  id: "alisio.default",
  render(ctx: MascotContext): string[] {
    const { unicode, color, columns } = ctx.terminal;
    if (columns < 40) {
      const line = unicode ? "≋(◕◡◕)≋" : "~(o.o)~";
      return [sgr(color, "36")(line)];
    }
    const cloud = sgr(color, "96"),
      wind = sgr(color, "34");
    return (unicode ? UNICODE : ASCII).map((raw) => {
      const [, body = "", gust = ""] = /^(.*?)([≋~]{2,})?$/u.exec(raw.trimEnd()) ?? [];
      return `${body ? cloud(body) : ""}${gust ? wind(gust) : ""}`;
    });
  },
};
