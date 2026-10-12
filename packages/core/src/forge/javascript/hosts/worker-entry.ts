/** Entry file of the worker thread (spec D-33: erasable TypeScript only). */
import { runWorkerIsolate } from "./isolate-main.ts";

await runWorkerIsolate();
