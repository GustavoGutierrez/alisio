---
"@alisio/core": patch
"@alisio/server": patch
---

No process Alisio starts survives its shutdown: a live process registry tracks every `runProcess` child (on POSIX its whole process group, even after the leader exits) and the long-lived workers, kills them synchronously from a `process.on("exit")` hook (`killAllTrackedProcesses`), and `alisio serve`'s close now ends with a sweep (SIGTERM, one-second grace, SIGKILL) within `SERVER_CLOSE_BUDGET_MS`. App teardown runs document engines in parallel with the other components (`APP_CLOSE_BUDGET_MS`). Alisio Desktop asks its host to shut down over IPC on every OS and falls back to killing the host's process tree (`taskkill /T /F` on Windows).
