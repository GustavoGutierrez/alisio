/**
 * Progressive enhancement for the home "What is Alisio?" block: a staggered
 * entrance (only when motion is allowed), a pause/play control for the looping
 * demo video and a lightbox that expands the Web UI screenshot and the video.
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

  // Entrance. Visible by default; hidden start state only once JS can reveal it.
  if (!reduced.matches && "IntersectionObserver" in window) {
    root.classList.add("is-ready");
    const reveal = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          root.classList.add("is-in");
          reveal.disconnect();
        }
      },
      { threshold: 0.08 },
    );
    reveal.observe(root);
    disposers.push(() => reveal.disconnect());
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
    const card = trigger.closest("section");
    const source =
      kind === "video"
        ? card?.querySelector<HTMLVideoElement>("video")
        : card?.querySelector<HTMLImageElement>("img");
    if (!source) return;

    const title = card?.querySelector("h3")?.textContent?.trim() ?? "";
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
      const big = document.createElement("img");
      big.src = source.currentSrc || source.src;
      big.alt = source.alt;
      big.width = source.naturalWidth || 1833;
      big.height = source.naturalHeight || 990;
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
