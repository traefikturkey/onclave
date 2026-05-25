# DevOps Install Review

## Finding 1
- severity: high
- evidence: Plan says Pi git installs clone repo root and run `npm install` when root `package.json` exists, but validation only requires `pnpm install`, `just setup`, and `pnpm test`. Current repo has `bun.lock` and no npm lockfile; planned workspace packages may use pnpm-only workspace behavior.
- required_fix: Add a required smoke check from a clean checkout using npm: delete/avoid `node_modules`, run `npm install`, then run the exact Pi git/local package metadata smoke command. Ensure root dependencies/scripts do not rely on pnpm-only resolution.

## Finding 2
- severity: high
- evidence: Root Pi metadata points directly to `./extensions/pi-onclave/src/onclave.ts`, while the plan also creates `extensions/pi-onclave/package.json`. It does not verify that `pi install git:...` loads the root `pi` metadata rather than treating workspace package metadata differently.
- required_fix: Define the intended install target unambiguously and add non-interactive smoke checks for both root local install and package-local loading, e.g. from repo root and from `extensions/pi-onclave`, verifying Pi discovers the extension path without interactive startup.

## Finding 3
- severity: medium
- evidence: The smoke command is ambiguous: `just pi-local-no-extensions --help` or `pi --no-extensions -e ./extensions/pi-onclave --help`. In many CLIs, `--help` can bypass extension loading, and `--no-extensions` may conflict with testing an extension load.
- required_fix: Replace this with one exact, non-interactive command known to exercise package resolution and extension loading. If Pi has no such mode, add a documented dry-run recipe that fails on stale paths/import errors without opening an interactive session.

## Finding 4
- severity: medium
- evidence: Rollback command is `git reset --hard HEAD && git switch main && git branch -D refactor/pi-plugin-structure`. After file moves and package installs, this will not remove untracked files such as `node_modules`, generated lockfiles, new package directories not tracked yet, or pnpm/npm artifacts.
- required_fix: Add a safe rollback/preflight section: capture current branch, refuse rollback with unrelated dirty changes, use targeted cleanup for planned untracked files, and explicitly mention whether `git clean -fd` is allowed or must be path-scoped.

## Finding 5
- severity: medium
- evidence: Plan requires Windows Git Bash portability but acceptance commands use `grep -R --include`, `test`, `perl/python or editor-safe replacements`, and unspecified just recipes. Fresh Windows Git Bash may lack `just`, pnpm, or Python, and quoting/path behavior is not specified.
- required_fix: Add tool preflight checks (`command -v git node npm pnpm bun just`) and make just recipes Bash-explicit and portable. Avoid relying on Python/Perl unless preflighted, or provide Node-based replacement/verification scripts.
