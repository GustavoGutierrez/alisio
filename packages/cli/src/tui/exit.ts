/**
 * Interactive-exit bounds: `/exit`, double Ctrl+C on an empty input, Ctrl+D and SIGINT/SIGTERM
 * must feel instant, so each shutdown step is raced against a cap instead of awaiting teardown
 * without limits. The plugin host's own hook timeout (`pluginHooks.sessionEndTimeoutMs`) still
 * applies to `/clear`; exit deliberately uses shorter user-facing caps on the same hooks.
 */
export const EXIT_PENDING_CAP_MS = 3_000;
export const EXIT_SESSION_END_CAP_MS = 1_500;

/** Resolves when `work` settles or after `capMs`, whichever comes first; never rejects. */
export function bounded(work: Promise<unknown> | undefined, capMs: number): Promise<void> {
  return Promise.race([
    Promise.resolve(work).catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, capMs)),
  ]).then(() => undefined);
}
