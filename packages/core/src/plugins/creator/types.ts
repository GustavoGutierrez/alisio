/**
 * Plugin creator data model. The wire shapes live in `@alisio/sdk` (the web reads them); this
 * module re-exports them and adds the core-only error type.
 */
import type {
  PluginCreatorBuildStats,
  PluginCreatorIssue,
  PluginCreatorProjectInfo,
  PluginCreatorRequest,
  PluginCreatorSchema,
  PluginCreatorStatus,
  PluginCreatorStep,
  PluginCreatorStepId,
  PluginCreatorStepStatus,
  PluginCreatorTestRun,
} from "@alisio/sdk";

export type {
  PluginCreatorBuildStats,
  PluginCreatorIssue,
  PluginCreatorProjectInfo,
  PluginCreatorRequest,
  PluginCreatorSchema,
  PluginCreatorStatus,
  PluginCreatorStep,
  PluginCreatorStepId,
  PluginCreatorStepStatus,
  PluginCreatorTestRun,
};

/** Fixed progress steps the creator agent reports, in order. */
export const PLUGIN_CREATOR_STEPS: readonly PluginCreatorStepId[] = [
  "plan",
  "tests",
  "code",
  "run_tests",
  "package",
];

/** Stable failure codes; the server maps them to `ApiErrorCode` with the same names. */
export type PluginCreatorErrorCode =
  | "validation_failed"
  | "not_found"
  | "path_outside_workspace"
  | "plugin_project_not_found"
  | "plugin_project_invalid"
  | "plugin_tests_failed"
  | "plugin_project_busy"
  | "plugin_not_built";

export class PluginCreatorError extends Error {
  constructor(
    readonly code: PluginCreatorErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PluginCreatorError";
  }
}

/** Limits of a creator project (kept small: these plugins are meant to stay small). */
export const PLUGIN_CREATOR_LIMITS = {
  requestChars: 8_000,
  displayNameChars: 80,
  maxFiles: 500,
  maxProjectBytes: 5 * 1024 * 1024,
  maxFileBytes: 1024 * 1024,
  /** Characters of a file returned by `readFile` (larger files are cut). */
  readChars: 200_000,
  maxRequests: 200,
  testTimeoutMs: 120_000,
  testOutputChars: 8_000,
} as const;
