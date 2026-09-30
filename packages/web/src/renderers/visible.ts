/** One shared IntersectionObserver for lazy work (highlighting, heavy renderers), §10.6. */
const callbacks = new WeakMap<Element, () => void>();
let observer: IntersectionObserver | undefined;

export function whenVisible(element: Element, run: () => void): () => void {
  if (typeof IntersectionObserver !== "function") {
    run();
    return () => {};
  }
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const cb = callbacks.get(entry.target);
        callbacks.delete(entry.target);
        observer?.unobserve(entry.target);
        cb?.();
      }
    },
    { rootMargin: "200px 0px" },
  );
  callbacks.set(element, run);
  observer.observe(element);
  return () => {
    callbacks.delete(element);
    observer?.unobserve(element);
  };
}
