/**
 * "Alisios" hero motion. Steady trade winds blow east to west, so everything drifts right to left:
 * the title arrives like a gust (letters of the name, words of the text line), the logo floats and
 * sways, and thin streaks of wind cross behind it.
 *
 * SSR and the first client render are the final, static state. Everything here runs after
 * hydration (see `index.ts`), touches only transform, opacity and filter (plus the CSS-only name
 * shimmer) and does nothing at all under `prefers-reduced-motion: reduce`.
 */
import { loadMotion, prefersReducedMotion } from "./motion";

type Controls = { stop: () => void };

let running: Controls[] = [];

const stopAll = () => {
  for (const control of running) control.stop();
  running = [];
};

/** Splits `el` into inline-block spans; the original markup is restored by `restore`. */
function split(
  el: HTMLElement,
  unit: "letters" | "words",
): { parts: HTMLElement[]; restore: () => void } {
  const html = el.innerHTML;
  const text = el.textContent ?? "";
  el.replaceChildren();
  const parts: HTMLElement[] = [];
  const make = (value: string) => {
    const span = document.createElement("span");
    span.className = "alisio-part";
    span.textContent = value;
    span.setAttribute("aria-hidden", "true");
    parts.push(span);
    return span;
  };
  if (unit === "letters") {
    for (const char of text) el.append(make(char));
  } else {
    const words = text.split(/(\s+)/);
    for (const word of words) el.append(/^\s+$/.test(word) || word === "" ? word : make(word));
  }
  return {
    parts,
    restore: () => {
      el.innerHTML = html;
    },
  };
}

export function initHeroMotion(): void {
  if (typeof document === "undefined" || prefersReducedMotion()) return;
  const hero = document.querySelector<HTMLElement>(".VPHome .VPHero");
  if (!hero) return;
  const heading = hero.querySelector<HTMLElement>("h1.heading");
  const art = hero.querySelector<HTMLElement>("[data-hero-art]");
  const name = heading?.querySelector<HTMLElement>(".name") ?? null;
  const textLine = heading?.querySelector<HTMLElement>(".text") ?? null;
  // Idempotent: a re-run (route change) only proceeds for a hero that has not been enhanced.
  if (hero.dataset.windy) return;
  hero.dataset.windy = "true";

  void loadMotion()
    .then(({ animate }) => {
      if (!hero.isConnected || prefersReducedMotion()) return;
      stopAll();

      if (art) {
        const sway = art.querySelector<HTMLElement>("[data-sway]");
        if (sway) {
          running.push(
            animate(
              sway,
              {
                transform: [
                  "translate3d(0px,0px,0) rotate(0deg)",
                  "translate3d(-5px,-7px,0) rotate(-1.6deg)",
                  "translate3d(3px,3px,0) rotate(1.2deg)",
                  "translate3d(0px,0px,0) rotate(0deg)",
                ],
              },
              { duration: 9, ease: "easeInOut", repeat: Number.POSITIVE_INFINITY },
            ),
          );
        }
        const streaks = [...art.querySelectorAll<SVGPathElement>("[data-streak]")];
        streaks.forEach((streak, i) => {
          const duration = 7 + (i % 3) * 1.6;
          const delay = i * 0.9;
          running.push(
            animate(
              streak,
              { transform: ["translateX(110px)", "translateX(-110px)"] },
              { duration, delay, ease: "linear", repeat: Number.POSITIVE_INFINITY },
            ),
            animate(
              streak,
              { opacity: [0, 0.6, 0.6, 0] },
              {
                duration,
                delay,
                times: [0, 0.3, 0.7, 1],
                ease: "easeInOut",
                repeat: Number.POSITIVE_INFINITY,
              },
            ),
          );
        });
      }

      if (!heading || !name || !textLine) return;
      heading.setAttribute(
        "aria-label",
        `${name.textContent ?? ""} ${textLine.textContent ?? ""}`.trim(),
      );
      const nameSplit = split(name, "letters");
      const textSplit = split(textLine, "words");

      // Give every letter the slice of the name gradient it occupies, so the gradient looks the
      // same while the letters are separate elements (background-clip does not cross transforms).
      const width = name.getBoundingClientRect().width;
      name.style.setProperty("--alisio-name-w", `${Math.round(width * 2)}px`);
      for (const part of nameSplit.parts) {
        part.style.setProperty("--alisio-part-x", `${-part.offsetLeft}px`);
      }

      // Letters and words arrive from the east (the right) with a blur-to-sharp settle.
      const gust = (parts: HTMLElement[], duration: number, step: number, delay: number) =>
        parts.map((part, i) =>
          animate(
            part,
            {
              opacity: [0, 1],
              transform: ["translateX(30px)", "translateX(0px)"],
              filter: ["blur(8px)", "blur(0px)"],
            },
            { duration, delay: delay + i * step, ease: [0.22, 0.8, 0.3, 1] },
          ),
        );

      const entrance = [
        ...gust(nameSplit.parts, 0.5, 0.05, 0),
        ...gust(textSplit.parts, 0.45, 0.04, 0.15),
      ];
      running.push(...entrance);
      void Promise.all(entrance)
        .then(() => {
          nameSplit.restore();
          textSplit.restore();
          name.style.removeProperty("--alisio-name-w");
          // Only now does the slow gradient breeze start, on the original, unsplit text.
          name.dataset.breeze = "true";
        })
        .catch(() => {
          nameSplit.restore();
          textSplit.restore();
        });
    })
    .catch(() => {
      delete hero.dataset.windy;
    });
}
