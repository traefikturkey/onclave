import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { resolveProjectLabel } from "../src/lib/project-label";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("resolveProjectLabel", () => {
  it("uses the worktree branch name when git reports a worktree branch", async () => {
    const label = await resolveProjectLabel("/repo/feature-worktree", async (_cwd, args) => {
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return "true\n";
      if (args.join(" ") === "rev-parse --git-common-dir") return "/repo/.git\n";
      if (args.join(" ") === "rev-parse --git-dir") return "/repo/.git/worktrees/feature-worktree\n";
      if (args.join(" ") === "branch --show-current") return "feature/onclave\n";
      return "";
    });

    expect(label).toBe("feature/onclave");
  });

  it("uses cwd basename plus branch for a normal git repository", async () => {
    const label = await resolveProjectLabel("/repo/onclave", async (_cwd, args) => {
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return "true\n";
      if (args.join(" ") === "rev-parse --git-common-dir") return "/repo/onclave/.git\n";
      if (args.join(" ") === "rev-parse --git-dir") return "/repo/onclave/.git\n";
      if (args.join(" ") === "branch --show-current") return "main\n";
      return "";
    });

    expect(label).toBe("onclave@main");
  });

  it("falls back to cwd basename outside git", async () => {
    const root = await mkdtemp(join(tmpdir(), "onclave-label-"));
    tempDirs.push(root);

    const label = await resolveProjectLabel(root, async () => {
      throw new Error("not a git repository");
    });

    expect(label).toBe(basename(root));
  });

  it("uses cwd basename when git has no branch name", async () => {
    const label = await resolveProjectLabel("/repo/detached", async (_cwd, args) => {
      if (args.join(" ") === "rev-parse --is-inside-work-tree") return "true\n";
      if (args.join(" ") === "rev-parse --git-common-dir") return "/repo/detached/.git\n";
      if (args.join(" ") === "rev-parse --git-dir") return "/repo/detached/.git\n";
      if (args.join(" ") === "branch --show-current") return "\n";
      return "";
    });

    expect(label).toBe("detached");
  });
});
