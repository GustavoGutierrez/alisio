/**
 * One-line tool rows (RF-05): a friendly name and a short summary taken from the call's
 * arguments (`Read · README.md`, `Shell · Show working directory`).
 */
const NAMES: Record<string, string> = {
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  list_files: "List",
  search_text: "Search",
  glob: "Glob",
  shell: "Shell",
  run_process: "Shell",
  bash: "Shell",
  git_status: "Git status",
  git_diff: "Git diff",
  web_fetch: "Fetch",
  web_search: "Web search",
  ask_user_question: "Question",
  task: "Agent",
};

/** Argument keys worth showing, in priority order. */
const SUMMARY_KEYS = [
  "description",
  "path",
  "file_path",
  "file",
  "command",
  "pattern",
  "query",
  "url",
  "prompt",
  "name",
];

export const toolLabel = (name: string): string =>
  NAMES[name] ??
  name
    .split(/[_:]/)
    .filter(Boolean)
    .map((part, i) => (i === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");

export function toolSummary(args: string, max = 120): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return oneLine(args, max);
  }
  if (!parsed || typeof parsed !== "object") return oneLine(String(parsed ?? ""), max);
  const record = parsed as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return oneLine(value, max);
    if (Array.isArray(value) && typeof value[0] === "string") return oneLine(value.join(" "), max);
  }
  const first = Object.values(record).find((v) => typeof v === "string" && v.trim());
  return typeof first === "string" ? oneLine(first, max) : "";
}

const oneLine = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** A path argument, when the call has one (rendered as a file reference). */
export function toolPath(args: string): string | undefined {
  try {
    const record = JSON.parse(args) as Record<string, unknown>;
    for (const key of ["path", "file_path", "file"])
      if (typeof record[key] === "string") return record[key] as string;
  } catch {
    /* not JSON */
  }
  return undefined;
}

/** Pretty JSON for the expanded input, or the raw text when it is not JSON. */
export function prettyArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

/** The command line of a shell-like call (`shell`, `run_process`) for its live terminal view. */
export function liveCommand(tool: { name: string; arguments: string }): string | undefined {
  if (tool.name !== "shell" && tool.name !== "run_process" && tool.name !== "bash")
    return undefined;
  try {
    const record = JSON.parse(tool.arguments) as Record<string, unknown>;
    const command = typeof record.command === "string" ? record.command : "";
    const args = Array.isArray(record.args) ? record.args.filter((a) => typeof a === "string") : [];
    return [command, ...args].filter(Boolean).join(" ");
  } catch {
    return "";
  }
}
