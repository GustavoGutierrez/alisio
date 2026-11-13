/**
 * Progressive enhancement for the home page content: the "How you work" wind sequence
 * and a few once-only section entrances (only when motion is allowed), a pause/play
 * control for the looping terminal demo video and a lightbox that expands every framed
 * screenshot and the video.
 * Copy and markup stay in the home markdown; every control starts `hidden` and
 * is revealed here, so nothing is offered that JS cannot deliver.
 */
const REDUCE = "(prefers-reduced-motion: reduce)";
const SVG = (path: string) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="${path}" /></svg>`;

let cleanup: (() => void) | undefined;

export function initWhatIs(): void {
  const root = document.querySelector<HTMLElement>('[data-component="whatis"]');
  if (root?.dataset.enhanced) return;
  cleanup?.();
  cleanup = undefined;
  if (!root) return;
  root.dataset.enhanced = "true";

  const reduced = window.matchMedia(REDUCE);
  const disposers: Array<() => void> = [];
  cleanup = () => {
    for (const dispose of disposers) dispose();
  };

  // The page's one authored motion moment: in "How you work", the wind line draws from 1 to 3
  // and each numeral lights up as it passes, showing that the three steps form one sequence.
  // Runs once. Visible by default; the dimmed start state exists only once JS can play it, and
  // never under reduced motion.
  const steps = root.querySelector<HTMLElement>(".home-steps");
  if (steps && !reduced.matches && "IntersectionObserver" in window) {
    steps.classList.add("is-ready");
    const play = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        steps.classList.add("is-in");
        play.disconnect();
      },
      { threshold: 0.45 },
    );
    play.observe(steps);
    disposers.push(() => play.disconnect());
  }

  // Supporting entrances, each specific to its section and played once (motion allowed only):
  // offer screenshots drift in from the east, the task rules draw in, the apps status pills
  // cascade, the data and permissions items fade in, the download button gets one breeze sheen.
  // Content is visible by default; the start states apply only under `.is-motion`.
  if (!reduced.matches && "IntersectionObserver" in window) {
    root.querySelector("#data-and-permissions ~ .home-list")?.classList.add("home-list-stagger");
    const targets = root.querySelectorAll<HTMLElement>(
      ".offer-row, .home-columns, .home-table, .home-list-stagger, #download",
    );
    root.classList.add("is-motion");
    const enter = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-in");
          enter.unobserve(entry.target);
        }
      },
      { threshold: 0.25 },
    );
    for (const target of targets) enter.observe(target);
    disposers.push(() => enter.disconnect());

    // The closing band's faint streamlines move only while the band is on screen.
    const closing = root.querySelector<HTMLElement>(".home-closing");
    if (closing) {
      const flow = new IntersectionObserver((entries) => {
        closing.classList.toggle(
          "is-flowing",
          entries.some((entry) => entry.isIntersecting),
        );
      });
      flow.observe(closing);
      disposers.push(() => flow.disconnect());
    }
  }

  const video = root.querySelector<HTMLVideoElement>('[data-component="video"] video');
  const toggle = root.querySelector<HTMLButtonElement>("[data-video-toggle]");

  let userPaused = false;
  let visible = false;
  let lightboxOpen = false;

  const label = () => {
    if (!video || !toggle) return;
    const paused = video.paused;
    toggle.dataset.state = paused ? "paused" : "playing";
    const text = paused ? toggle.dataset.labelPlay : toggle.dataset.labelPause;
    if (text) {
      toggle.setAttribute("aria-label", text);
      toggle.title = text;
    }
  };

  const sync = () => {
    if (!video) return;
    if (reduced.matches || userPaused || !visible || lightboxOpen) {
      if (!video.paused) video.pause();
    } else {
      void video.play().catch(() => undefined);
    }
    label();
  };

  if (video) {
    if (toggle) {
      toggle.hidden = false;
      toggle.addEventListener("click", () => {
        if (video.paused) {
          userPaused = false;
          void video.play().catch(() => undefined);
        } else {
          userPaused = true;
          video.pause();
        }
        label();
      });
      video.addEventListener("play", label);
      video.addEventListener("pause", label);
    }

    // Play only while on screen; the demo costs nothing off screen.
    const watch = new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      if (!reduced.matches) sync();
    });
    watch.observe(video);
    disposers.push(() => watch.disconnect());

    const onReduceChange = () => {
      userPaused = false;
      if (reduced.matches) video.currentTime = 0;
      sync();
    };
    reduced.addEventListener("change", onReduceChange);
    disposers.push(() => reduced.removeEventListener("change", onReduceChange));

    // Reduced motion starts paused on the first frame.
    if (reduced.matches) {
      video.pause();
      video.currentTime = 0;
    }
    label();
  }

  // Lightbox: one native <dialog> per open, so focus is trapped, Esc closes and
  // focus returns to the button that opened it.
  const openLightbox = (trigger: HTMLButtonElement) => {
    // a second click while one is open must not stack another dialog
    if (lightboxOpen) return;
    const kind = trigger.dataset.expand;
    // The frame that holds the button also holds the media it expands.
    const frame = trigger.parentElement;
    const source =
      kind === "video"
        ? frame?.querySelector<HTMLVideoElement>("video")
        : (frame?.querySelector<HTMLImageElement>("img[data-active]") ??
          frame?.querySelector<HTMLImageElement>("img"));
    if (!source) return;

    // Title: the heading of the section or offer row around the media, else the image alt text.
    const owner = trigger.closest(".offer-row, section");
    const title =
      trigger.dataset.title ||
      owner?.querySelector("h3")?.textContent?.trim() ||
      (source instanceof HTMLImageElement ? source.alt : "");
    const dialog = document.createElement("dialog");
    dialog.className = "whatis-lightbox";
    dialog.setAttribute("aria-label", title);

    const bar = document.createElement("div");
    bar.className = "lightbox-bar";
    const heading = document.createElement("p");
    heading.className = "lightbox-title";
    heading.textContent = title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "media-btn";
    const closeText = trigger.dataset.labelClose ?? "Close";
    close.setAttribute("aria-label", closeText);
    close.title = closeText;
    close.innerHTML = SVG("M6 6l12 12M18 6L6 18");
    bar.append(heading, close);

    const body = document.createElement("div");
    body.className = "lightbox-body";
    if (source instanceof HTMLVideoElement) {
      const big = document.createElement("video");
      big.controls = true;
      big.loop = true;
      big.muted = true;
      big.playsInline = true;
      big.poster = source.poster;
      big.width = 960;
      big.height = 500;
      big.setAttribute("aria-label", title);
      for (const src of source.querySelectorAll("source")) {
        big.append(src.cloneNode(true));
      }
      big.autoplay = !reduced.matches;
      body.append(big);
    } else {
      // Shown at its natural resolution, scaled down only to fit the viewport (lightbox CSS), so it
      // is never smaller than the inline copy.
      const big = document.createElement("img");
      // `data-full` names the full-resolution file when the inline copy may be a small variant.
      big.src = source.dataset.full || source.currentSrc || source.src;
      big.alt = source.alt;
      big.width = source.dataset.full ? source.width : source.naturalWidth || source.width;
      big.height = source.dataset.full ? source.height : source.naturalHeight || source.height;
      body.append(big);
    }
    dialog.append(bar, body);

    lightboxOpen = true;
    video?.pause();
    document.documentElement.classList.add("whatis-locked");
    document.body.append(dialog);

    const finish = () => {
      dialog.remove();
      document.documentElement.classList.remove("whatis-locked");
      lightboxOpen = false;
      sync();
      trigger.focus();
    };
    close.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", finish, { once: true });
    dialog.showModal();
    close.focus();
  };

  for (const trigger of root.querySelectorAll<HTMLButtonElement>("[data-expand]")) {
    trigger.hidden = false;
    const onClick = () => openLightbox(trigger);
    trigger.addEventListener("click", onClick);
    if (trigger.dataset.expand === "image") {
      const img = trigger.parentElement?.querySelector("img");
      img?.addEventListener("click", onClick);
    }
  }
}
