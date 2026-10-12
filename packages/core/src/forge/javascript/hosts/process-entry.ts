/** Entry file of the isolate child process when run from a file (spec D-33: erasable TypeScript only). */
import { runProcessIsolate } from "./isolate-main.ts";

await runProcessIsolate();
