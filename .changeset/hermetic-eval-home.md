---
"@alisio/core": patch
---

The Reliability Lab no longer depends on the host: `createApplication` accepts a `home` option
(default `os.homedir()`) and the eval engine points it at the run's scratch home, so skills and
agents installed in the developer's real home never reach the prompt, the tool descriptions or the
cassette fingerprints. The bundled cassettes were re-recorded hermetically.
