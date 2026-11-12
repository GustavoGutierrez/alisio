---
"@alisio/core": patch
"@alisio/server": patch
"@alisio/sdk": patch
"@alisio/web": patch
"@alisio/alisio-code": patch
---

Plugin creator delivery gates: every build now checks the packaged plugin on an installed copy with the real plugin host (strict tool schemas, one smoke call per tool, dispose and reactivation, a test per tool, syntax and packed imports), installs require a passing build for the current sources, an install whose plugin does not start is rolled back, and the catalog diagnostic explains why a plugin failed to activate. Also: shorter provisional titles replaced by the plugin's own name, settled progress steps and a "could not start" recovery path in the creator page.
