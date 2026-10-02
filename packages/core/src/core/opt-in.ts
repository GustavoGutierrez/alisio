/**
 * Tools that exist only for runs that ask for them. The registry is shared by the main session,
 * its child sessions and Code Mode, so hiding a tool from "everything but the plan agent" cannot
 * be a filter on the plan run: the tool is hidden by default and a run lists it in
 * `RunOptions.optInTools` to see (and be allowed to call) it.
 */
export const EXIT_PLAN_TOOL = "exit_plan";

export const OPT_IN_TOOLS: ReadonlySet<string> = new Set([EXIT_PLAN_TOOL]);

/** Whether `name` may be offered or executed for a run that opted into `optIn`. */
export const optInAllows = (name: string, optIn: readonly string[] | undefined): boolean =>
  !OPT_IN_TOOLS.has(name) || !!optIn?.includes(name);
