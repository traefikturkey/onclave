# QA Validation Review

## Finding 1
severity: high
evidence: T4 AC1 uses `grep -R ... || true` and defines pass as “no stale import matches.” The command exits 0 even when stale imports exist, so an automated checklist can mark it passing while broken old-path imports remain.
required_fix: Replace with a failing assertion, e.g. `! grep -R "\.\./\.\./src/onclave\|\.\./src/onclave\|extensions/onclave" tests scripts extensions packages --include='*.ts'`, or pipe output to a reviewed allowlist with a nonzero exit on unexpected matches.

## Finding 2
severity: high
evidence: The Pi smoke check permits `pi --no-extensions -e ./extensions/pi-onclave --help`. `--help` and `--no-extensions` can avoid loading the moved extension, so criteria can pass while the extension entry is syntactically invalid or unloadable.
required_fix: Add a non-interactive smoke that actually loads the extension from root metadata and package path, such as a Pi command/list invocation with `-e ./extensions/pi-onclave` and no `--no-extensions`, asserting no extension-resolution/import errors.

## Finding 3
severity: medium
evidence: Objective requires loading from repo root and `extensions/pi-onclave`, but metadata checks only assert root `package.json` has `pi.extensions`. Extension package JSON is only parsed, not checked for its own `pi` metadata or entry path.
required_fix: Add acceptance checks that `extensions/pi-onclave/package.json` declares the expected Pi extension entry and that root and package-local metadata paths both resolve to existing files.

## Finding 4
severity: medium
evidence: Root must remain npm-compatible for `pi install git:...`, yet validation only runs `pnpm install` / `just setup`. A workspace-only dependency or pnpm-only script can pass local validation and fail Pi’s npm-based git install.
required_fix: Add an npm compatibility gate in a clean temp checkout or with `npm install --package-lock=false --ignore-scripts` plus JSON/script checks required by Pi install behavior.

## Finding 5
severity: medium
evidence: F5 “Archive preflight complete” has no concrete verification command, despite many checklist items relying on evidence fields. `/do-it` could archive after checking the box without proving all task checks, docs paths, and load smoke evidence were recorded.
required_fix: Define archive preflight: all task/final checkboxes `[x]`, each Evidence field non-placeholder, `just setup && just check` passed after final changes, Pi load smoke passed, and `git status --short` reviewed for only intended files.
