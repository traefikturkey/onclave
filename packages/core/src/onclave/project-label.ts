import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export async function resolveProjectLabel(cwd: string, gitRunner: GitRunner = runGit): Promise<string> {
  const fallback = basename(cwd) || "project";

  try {
    const inside = (await gitRunner(cwd, ["rev-parse", "--is-inside-work-tree"])).trim();
    if (inside !== "true") return fallback;

    const [gitDirRaw, commonDirRaw, branchRaw] = await Promise.all([
      gitRunner(cwd, ["rev-parse", "--git-dir"]),
      gitRunner(cwd, ["rev-parse", "--git-common-dir"]),
      gitRunner(cwd, ["branch", "--show-current"]),
    ]);

    const branch = branchRaw.trim();
    if (!branch) return fallback;

    if (isLinkedWorktree(gitDirRaw.trim(), commonDirRaw.trim())) {
      return branch;
    }

    return `${fallback}@${branch}`;
  } catch {
    return fallback;
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 1024 * 64,
  });
  return stdout;
}

function isLinkedWorktree(gitDir: string, commonDir: string): boolean {
  if (gitDir.length === 0 || commonDir.length === 0) return false;
  return normalizeGitPath(gitDir) !== normalizeGitPath(commonDir);
}

function normalizeGitPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
