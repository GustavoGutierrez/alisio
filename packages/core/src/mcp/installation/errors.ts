/** Refusals of the installer. `code` is a stable API error code (`ApiErrorCode`). */
export type McpInstallErrorCode =
  | "mcp_method_unsupported"
  | "mcp_runtime_missing"
  | "mcp_input_required"
  | "mcp_scope_untrusted"
  | "mcp_plan_expired"
  | "mcp_config_conflict"
  | "mcp_install_failed"
  | "mcp_secret_unavailable"
  | "not_found"
  | "validation_failed"
  | "mcp_not_permitted";

/** Why an entry cannot be installed automatically (drives the honest "not supported yet" text). */
export type UnsupportedReason =
  | "deprecated"
  | "deleted"
  | "no_method"
  | "unversioned"
  | "registry"
  | "sse"
  | "pypi"
  | "oci"
  | "mcpb"
  | "other_method"
  | "requires_arguments"
  | "lifecycle_scripts"
  | "bin_ambiguous"
  | "no_bin"
  | "unsafe_address"
  | "npm_missing";

export class McpInstallError extends Error {
  constructor(
    readonly code: McpInstallErrorCode,
    message: string,
    readonly extra: {
      reason?: UnsupportedReason | string;
      fields?: string[];
      choices?: string[];
    } = {},
  ) {
    super(message);
    this.name = "McpInstallError";
  }
}
