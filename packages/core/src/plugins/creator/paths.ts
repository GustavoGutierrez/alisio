/**
 * Where the plugin creator keeps its data, under the config home:
 *
 *   plugin-creator/projects/<id>/   the project sources (also the creator session's workspace)
 *   plugin-creator/records/<id>.json the metadata record (written atomically)
 *   plugin-creator/builds/<id>/      the last package (`.tgz`) and its build record
 *   plugin-creator/skills/           the bundled creator skill, materialized from the core
 */
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { configHome } from "../../config.ts";
import { inside } from "../../runtime/paths.ts";

export const PROJECT_ID = /^[a-f0-9]{12}$/;

export interface PluginCreatorPaths {
  root: string;
  projects: string;
  records: string;
  builds: string;
  skills: string;
}

export function pluginCreatorPaths(home: string = configHome()): PluginCreatorPaths {
  const root = join(resolve(home), "plugin-creator");
  return {
    root,
    projects: join(root, "projects"),
    records: join(root, "records"),
    builds: join(root, "builds"),
    skills: join(root, "skills"),
  };
}

/** The projects folder as given and as resolved through symlinks (workspaces are realpaths). */
function projectRoots(home: string): string[] {
  const { projects } = pluginCreatorPaths(home);
  try {
    const real = realpathSync(projects);
    return real === projects ? [projects] : [projects, real];
  } catch {
    return [projects];
  }
}

/** The project id of a path inside a creator project folder, if any. */
export function pluginCreatorProjectOf(
  path: string,
  home: string = configHome(),
): string | undefined {
  const target = resolve(path);
  for (const root of projectRoots(home)) {
    if (target === root || !inside(root, target)) continue;
    const id = target.slice(root.length + 1).split(/[\\/]/)[0] ?? "";
    if (PROJECT_ID.test(id)) return id;
  }
  return undefined;
}

/** Whether `path` is (inside) a plugin creator project folder. */
export function isPluginCreatorPath(path: string, home: string = configHome()): boolean {
  return pluginCreatorProjectOf(path, home) !== undefined;
}

/** A reusable `isPluginCreatorPath` for many paths (the folder is resolved once). */
export function pluginCreatorPathMatcher(home: string = configHome()): (path: string) => boolean {
  const roots = projectRoots(home);
  return (path) => {
    const target = resolve(path);
    return roots.some((root) => {
      if (target === root || !inside(root, target)) return false;
      return PROJECT_ID.test(target.slice(root.length + 1).split(/[\\/]/)[0] ?? "");
    });
  };
}
