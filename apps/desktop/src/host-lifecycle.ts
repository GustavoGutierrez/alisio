/**
 * Keeps the desktop host from outliving the app. A supervised host (started by the app with
 * `ALISIO_SUPERVISED=1`) stops when its IPC channel disconnects, so it must have one: without it
 * nothing would ever stop it and it would keep listening on loopback as an orphan. An unsupervised
 * host without IPC (started by hand or a script) stops when its original parent goes away.
 */

/** Why the host must not start, or undefined. */
export function channelProblem(env: NodeJS.ProcessEnv, hasChannel: boolean): string | undefined {
  return env.ALISIO_SUPERVISED === "1" && !hasChannel
    ? "The supervised Alisio host needs the IPC channel of the app that starts it; start Alisio Desktop instead"
    : undefined;
}

/**
 * Calls `onGone` once when the parent process id changes (the parent exited and the host was
 * re-parented). The timer is unref'd: it never keeps the process alive. Returns a stop function.
 */
export function watchParent(options: {
  ppid: () => number;
  onGone: () => void;
  intervalMs?: number;
}): () => void {
  const original = options.ppid();
  const timer = setInterval(() => {
    if (options.ppid() === original) return;
    clearInterval(timer);
    options.onGone();
  }, options.intervalMs ?? 3_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
