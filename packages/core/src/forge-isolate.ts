/**
 * The entry the compiled `alisio` binary runs for its hidden `__forge-isolate` command (spec D-21):
 * the body of a Forja process isolate. It is a separate export on purpose, so the CLI loads it
 * without loading the application, the configuration or SQLite.
 */
export { runProcessIsolate } from "./forge/javascript/hosts/isolate-main.ts";
