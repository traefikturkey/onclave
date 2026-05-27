#!/usr/bin/env node

import { accessSync, existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import process from "node:process";

const args = new Set(process.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
  printUsage();
  process.exit(0);
}

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(scriptPath));
const packageJsonPath = join(repoRoot, "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const packageManagerSpec = typeof packageJson.packageManager === "string" ? packageJson.packageManager : null;
const expectedPnpmVersion = packageManagerSpec && packageManagerSpec.startsWith("pnpm@")
  ? packageManagerSpec.slice("pnpm@".length)
  : null;
const expectedPnpmMajor = expectedPnpmVersion ? expectedPnpmVersion.split(".")[0] : null;
const recommendedNodeMajor = 24;

const checks = [];

checks.push(createNodeCheck(recommendedNodeMajor));
checks.push(createToolCheck("pnpm", {
  required: true,
  versionEvaluator: (version) => evaluatePnpmVersion(version, expectedPnpmVersion, expectedPnpmMajor),
  missingHint: "Install pnpm 10.x and rerun bootstrap preflight.",
}));
checks.push(createToolCheck("just", {
  required: true,
  missingHint: "Install just so you can use the repo command surface from `justfile`.",
}));
checks.push(createToolCheck("git", {
  required: true,
  missingHint: "Install git so project-label and normal repository workflows work.",
}));
checks.push(createToolCheck("pi", {
  required: false,
  missingHint: "Install Pi to run `just pi-local` and Onclave smoke checks locally.",
}));
checks.push(createDependencyInstallCheck(repoRoot));
checks.push(createWorkspaceCheck(repoRoot));

const failedChecks = checks.filter((check) => check.status === "fail");
const warnedChecks = checks.filter((check) => check.status === "warn");
const nextSteps = buildNextSteps(checks);

if (args.has("--json")) {
  process.stdout.write(
    `${JSON.stringify({
      repoRoot,
      ok: failedChecks.length === 0,
      checks,
      nextSteps,
    }, null, 2)}\n`
  );
  process.exit(failedChecks.length === 0 ? 0 : 1);
}

printHumanReport({ repoRoot, checks, nextSteps });
process.exit(failedChecks.length === 0 ? 0 : 1);

function createNodeCheck(expectedMajor) {
  const version = process.version.replace(/^v/, "");
  const currentMajor = Number.parseInt(version.split(".")[0] || "0", 10);
  if (currentMajor === expectedMajor) {
    return {
      name: "node",
      status: "pass",
      details: `found ${version} (matches the current validated major ${expectedMajor}.x)`,
    };
  }

  return {
    name: "node",
    status: "warn",
    details: `found ${version} (the repo is currently validated most directly on ${expectedMajor}.x)`,
  };
}

function createToolCheck(command, options) {
  const resolvedPath = findCommandOnPath(command);
  if (!resolvedPath) {
    return {
      name: command,
      status: options.required ? "fail" : "warn",
      details: "not found on PATH",
      hint: options.missingHint,
    };
  }

  const version = readCommandVersion(command);
  const evaluation = options.versionEvaluator ? options.versionEvaluator(version) : { status: "pass", suffix: version ? ` (${version})` : "" };

  return {
    name: command,
    status: evaluation.status,
    details: `found at ${resolvedPath}${evaluation.suffix}`,
    hint: evaluation.hint,
  };
}

function createDependencyInstallCheck(root) {
  const nodeModulesPath = join(root, "node_modules");
  if (existsSync(nodeModulesPath)) {
    return {
      name: "dependencies",
      status: "pass",
      details: "node_modules directory is present",
    };
  }

  return {
    name: "dependencies",
    status: "warn",
    details: "dependencies do not appear to be installed yet",
    hint: "Run `just setup` after preflight succeeds.",
  };
}

function createWorkspaceCheck(root) {
  const workspacePath = join(root, "pnpm-workspace.yaml");
  if (existsSync(workspacePath)) {
    return {
      name: "workspace",
      status: "pass",
      details: "found pnpm-workspace.yaml",
    };
  }

  return {
    name: "workspace",
    status: "fail",
    details: "missing pnpm-workspace.yaml",
    hint: "Restore the workspace manifest before adding or installing packages.",
  };
}

function evaluatePnpmVersion(version, expectedVersion, expectedMajor) {
  if (!version) {
    return {
      status: "warn",
      suffix: " (version unavailable)",
    };
  }

  const currentMajor = version.split(".")[0] || null;
  if (expectedMajor && currentMajor !== expectedMajor) {
    return {
      status: "fail",
      suffix: ` (${version}; expected pnpm ${expectedMajor}.x from packageManager ${expectedVersion})`,
      hint: `Use pnpm ${expectedMajor}.x for this workspace.`,
    };
  }

  if (expectedVersion && version !== expectedVersion) {
    return {
      status: "warn",
      suffix: ` (${version}; root packageManager pins ${expectedVersion})`,
      hint: `Prefer pnpm ${expectedVersion} or another ${expectedMajor}.x release for consistent installs.`,
    };
  }

  return {
    status: "pass",
    suffix: ` (${version})`,
  };
}

function readCommandVersion(command) {
  const result = spawnSync(command, ["--version"], {
    encoding: "utf8",
    cwd: repoRoot,
  });

  if (result.error) return null;

  const output = `${result.stdout || ""}\n${result.stderr || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  return output || null;
}

function findCommandOnPath(command) {
  const pathValue = process.env.PATH;
  if (!pathValue) return null;

  const pathEntries = pathValue.split(delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
        .split(";")
        .filter(Boolean)
    : [""];

  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = join(entry, process.platform === "win32" ? `${command}${extension}` : command);
      try {
        accessSync(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
  }

  return null;
}

function buildNextSteps(checkResults) {
  const steps = [];
  if (checkResults.some((check) => check.name === "pnpm" && check.status === "fail")) {
    steps.push("Install pnpm 10.x so workspace commands can run.");
  }
  if (checkResults.some((check) => check.name === "just" && check.status === "fail")) {
    steps.push("Install just so the repo command surface is available.");
  }
  if (checkResults.some((check) => check.name === "dependencies" && check.status !== "pass")) {
    steps.push("Run `just setup` to install workspace dependencies.");
  }
  steps.push("Run `just check` before handing off code changes.");
  steps.push("Run `just pi-local` when you need to load the Onclave extension in Pi.");
  return steps;
}

function printHumanReport(input) {
  console.log("Onclave repo preflight");
  console.log("");
  console.log(`Repo root: ${input.repoRoot}`);
  console.log("");

  for (const check of input.checks) {
    console.log(`${statusLabel(check.status)} ${check.name}: ${check.details}`);
    if (check.hint) console.log(`    hint: ${check.hint}`);
  }

  console.log("");
  console.log("Next steps:");
  for (const step of input.nextSteps) {
    console.log(`- ${step}`);
  }
}

function statusLabel(status) {
  switch (status) {
    case "pass":
      return "PASS";
    case "warn":
      return "WARN";
    default:
      return "FAIL";
  }
}

function printUsage() {
  console.log(`Usage: node ./scripts/preflight.mjs [--json]\n\nRuns the repo-aware Node-based preflight after bootstrap preflight succeeds.\n\nOptions:\n  --json   Print machine-readable JSON output.\n  -h       Show this help.\n`);
}
