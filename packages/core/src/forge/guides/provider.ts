/**
 * `GuideProvider` (spec §8.3, D12, Lazy Load): layer 2 of the incremental context. Each topic is
 * generated on request from the live state of the engines, so a guide never describes a limit, a
 * package or a guarantee the engine does not have right now. Nothing is built at construction.
 * Every topic is at most 4 KiB and carries an `etag` (truncated SHA-256 of its content); a caller
 * that already holds the same etag gets `{ unchanged: true }`.
 */
import { createHash } from "node:crypto";
import {
  type CatalogSummaryEntry,
  type JavascriptGuideState,
  jsApiGuide,
  jsPatternsGuide,
  jsToolsGuide,
} from "./javascript.ts";
import {
  type PythonEnvironment,
  pythonDashboardsGuide,
  pythonDataGuide,
  pythonEnvironmentGuide,
  pythonMlGuide,
  pythonRuntimeGuide,
} from "./python.ts";

export const JS_GUIDE_TOPICS = ["js.api", "js.patterns", "js.tools"] as const;
export const PYTHON_GUIDE_TOPICS = [
  "python.runtime",
  "python.data",
  "python.ml",
  "python.dashboards",
  "python.environment",
] as const;
export const GUIDE_TOPICS = [...JS_GUIDE_TOPICS, ...PYTHON_GUIDE_TOPICS] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

/** Hard bound of one topic (spec §8.3). */
export const GUIDE_MAX_BYTES = 4096;
/** Characters of the SHA-256 kept as the etag. */
export const ETAG_LENGTH = 16;

export interface GuideSources {
  /** Present when the JavaScript engine is ready; its absence removes the `js.*` topics. */
  javascript?: () => Promise<JavascriptGuideState>;
  /** Present when `python_run` is registered; its absence removes the `python.*` topics. */
  python?: () => Promise<PythonEnvironment>;
}

export type GuideResponse =
  | { unchanged: true; etag: string }
  | { unchanged: false; topic: GuideTopic; etag: string; content: string };

export interface GuideRequest {
  topic: string;
  ifNoneMatch?: string | undefined;
  /** The tools a script can call right now (for `js.tools`). */
  catalog?: readonly CatalogSummaryEntry[] | undefined;
}

export class UnknownGuideTopicError extends Error {
  constructor(topic: string, available: readonly string[]) {
    super(`Unknown guide topic "${topic}". Available: ${available.join(", ")}`);
    this.name = "UnknownGuideTopicError";
  }
}

export const etagOf = (content: string): string =>
  createHash("sha256").update(content).digest("hex").slice(0, ETAG_LENGTH);

/** Cuts to the byte bound on a character boundary, saying so. */
function bounded(content: string): string {
  if (Buffer.byteLength(content) <= GUIDE_MAX_BYTES) return content;
  const note = "\n[guide cut at 4 KiB]";
  let out = content;
  while (Buffer.byteLength(out) + Buffer.byteLength(note) > GUIDE_MAX_BYTES)
    out = out.slice(0, -64);
  return out + note;
}

export class GuideProvider {
  readonly #sources: GuideSources;

  constructor(sources: GuideSources) {
    this.#sources = sources;
  }

  /** The topics that exist now: the JavaScript ones with a ready engine, the Python ones with `python_run`. */
  topics(): GuideTopic[] {
    return [
      ...(this.#sources.javascript ? JS_GUIDE_TOPICS : []),
      ...(this.#sources.python ? PYTHON_GUIDE_TOPICS : []),
    ];
  }

  async get(request: GuideRequest): Promise<GuideResponse> {
    const available = this.topics();
    const topic = available.find((candidate) => candidate === request.topic);
    if (!topic) throw new UnknownGuideTopicError(request.topic, available);
    const content = bounded(await this.#render(topic, request));
    const etag = etagOf(content);
    if (request.ifNoneMatch !== undefined && request.ifNoneMatch === etag)
      return { unchanged: true, etag };
    return { unchanged: false, topic, etag, content };
  }

  async #render(topic: GuideTopic, request: GuideRequest): Promise<string> {
    switch (topic) {
      case "js.api":
        return jsApiGuide(await this.#js());
      case "js.patterns":
        return jsPatternsGuide(await this.#js());
      case "js.tools":
        return jsToolsGuide(request.catalog);
      case "python.runtime":
        return pythonRuntimeGuide(await this.#py());
      case "python.data":
        return pythonDataGuide(await this.#py());
      case "python.ml":
        return pythonMlGuide(await this.#py());
      case "python.dashboards":
        return pythonDashboardsGuide(await this.#py());
      case "python.environment":
        return pythonEnvironmentGuide(await this.#py());
    }
  }

  #js(): Promise<JavascriptGuideState> {
    const source = this.#sources.javascript;
    if (!source) throw new Error("the JavaScript engine is not available");
    return source();
  }

  #py(): Promise<PythonEnvironment> {
    const source = this.#sources.python;
    if (!source) throw new Error("python_run is not available");
    return source();
  }
}
