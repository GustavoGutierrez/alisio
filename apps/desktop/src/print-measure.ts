/**
 * DOM measurement script run in an isolated world before printing (spec 026 D-27). It is a copy
 * of `MEASURE_SCRIPT` in `@alisio/core` (the main process does not import core; a test keeps the
 * two identical).
 */
export const MEASURE_SCRIPT = `(() => {
  const main = document.querySelector('main');
  const out = { overflow: [], lowDpi: [] };
  if (!main) return JSON.stringify(out);
  const box = main.getBoundingClientRect();
  for (const el of main.querySelectorAll('[data-b]')) {
    if (el.parentElement !== main) continue;
    let worst = 0;
    for (const n of [el, ...el.querySelectorAll('*')]) worst = Math.max(worst, n.getBoundingClientRect().right - box.right);
    const sw = el.scrollWidth - el.clientWidth;
    if (worst > 1 || sw > 1) out.overflow.push({ block: Number(el.getAttribute('data-b')), tag: el.tagName.toLowerCase(), overflowPx: Math.round(Math.max(worst, sw)) });
  }
  for (const img of document.images) {
    const w = img.getBoundingClientRect().width / 96;
    if (w > 0 && img.naturalWidth > 0 && !/\\.svg(\\?|$)/i.test(img.getAttribute('src') || '')) { const dpi = Math.round(img.naturalWidth / w); if (dpi < 150) out.lowDpi.push({ src: img.getAttribute('src') || '', dpi }); }
  }
  return JSON.stringify(out);
})()`;
