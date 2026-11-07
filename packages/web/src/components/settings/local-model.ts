/**
 * Pure model of the "Install from file" tab: what a picked file may be, the verdict of an
 * inspection, the install flow as a reducer and the phase stepper. No DOM, no signals.
 */
export interface LocalInspectView {
  stagingId?: string;
  package?: string;
  version?: string;
  description?: string;
  author?: string;
  license?: string;
  sdkRange?: string;
  compatible: boolean;
  isAlisioPlugin: boolean;
  reasons: string[];
  lifecycleScripts: string[];
  installed?: { version: string; relation: "update" | "same" | "downgrade" };
  size: number;
}

export type PhaseId =
  | "uploading"
  | "validating"
  | "copying"
  | "installing"
  | "registering"
  | "reloading"
  | "cleanup";

export type PhaseStatus = "pending" | "running" | "done" | "failed";

export const PHASE_IDS: readonly PhaseId[] = [
  "uploading",
  "validating",
  "copying",
  "installing",
  "registering",
  "reloading",
  "cleanup",
];

/** `GET /api/plugins/jobs/:jobId`. */
export interface JobStateView {
  phase?: PhaseId;
  phases: Array<{ id: PhaseId; status: PhaseStatus }>;
  done: boolean;
  error?: string;
  result?: {
    package: string;
    installedVersion: string;
    alreadyInstalled: boolean;
    updated: boolean;
    previousVersion?: string;
    restartPending: boolean;
    restartRequired: boolean;
  };
  logTail?: string;
}

/** Only `.tgz` / `.tar.gz` files are offered to the server. */
export const acceptsFile = (name: string): boolean => /\.(tgz|tar\.gz)$/i.test(name);

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type LocalWarning = "sdk" | "lifecycle";

export interface Verdict {
  /** Valid Alisio plugin with an upload to install. */
  canInstall: boolean;
  /** Shown prominently but never blocking. */
  warnings: LocalWarning[];
  /** An installed version will be replaced: an update, a reinstall or a downgrade. */
  existing?: { version: string; relation: "update" | "same" | "downgrade" };
  /** The file's package differs from the one an "Update from file" was scoped to. */
  scopeMismatch?: boolean;
}

export function inspectVerdict(info: LocalInspectView, scope?: string): Verdict {
  const warnings: LocalWarning[] = [];
  if (!info.compatible) warnings.push("sdk");
  if (info.lifecycleScripts.length) warnings.push("lifecycle");
  return {
    canInstall: info.isAlisioPlugin && !!info.stagingId,
    warnings,
    ...(info.installed
      ? { existing: { version: info.installed.version, relation: info.installed.relation } }
      : {}),
    ...(scope && info.package && info.package !== scope ? { scopeMismatch: true } : {}),
  };
}

// ---- Flow ---------------------------------------------------------------------------------------

export type LocalFlow =
  | { step: "idle" }
  | { step: "inspecting"; fileName: string }
  | { step: "inspected"; fileName: string; info: LocalInspectView }
  | { step: "installing"; fileName: string; info: LocalInspectView; job?: JobStateView }
  | { step: "done"; info: LocalInspectView; job: JobStateView }
  | {
      step: "failed";
      info?: LocalInspectView;
      error: string;
      logTail?: string;
      job?: JobStateView;
    };

export type LocalEvent =
  | { type: "pick"; fileName: string }
  | { type: "inspected"; info: LocalInspectView }
  | { type: "start" }
  | { type: "progress"; job: JobStateView }
  | { type: "error"; message: string }
  | { type: "reset" };

export function localReducer(state: LocalFlow, event: LocalEvent): LocalFlow {
  switch (event.type) {
    case "reset":
      return { step: "idle" };
    case "pick":
      return state.step === "installing" ? state : { step: "inspecting", fileName: event.fileName };
    case "inspected":
      return state.step === "inspecting"
        ? { step: "inspected", fileName: state.fileName, info: event.info }
        : state;
    case "start":
      return state.step === "inspected" && inspectVerdict(state.info).canInstall
        ? { step: "installing", fileName: state.fileName, info: state.info }
        : state;
    case "progress": {
      if (state.step !== "installing") return state;
      if (!event.job.done) return { ...state, job: event.job };
      if (event.job.error)
        return {
          step: "failed",
          info: state.info,
          error: event.job.error,
          ...(event.job.logTail ? { logTail: event.job.logTail } : {}),
          job: event.job,
        };
      return { step: "done", info: state.info, job: event.job };
    }
    case "error":
      return state.step === "inspecting" ||
        state.step === "installing" ||
        state.step === "inspected"
        ? {
            step: "failed",
            ...("info" in state ? { info: state.info } : {}),
            error: event.message,
          }
        : state;
  }
}

/** Steps of the stepper. Before the first poll the upload step is the running one. */
export function phaseSteps(
  job: JobStateView | undefined,
): Array<{ id: PhaseId; status: PhaseStatus }> {
  if (!job) return PHASE_IDS.map((id, i) => ({ id, status: i === 0 ? "running" : "pending" }));
  return PHASE_IDS.map((id) => ({
    id,
    status: job.phases.find((phase) => phase.id === id)?.status ?? "pending",
  }));
}
