---
reviewer: security-reviewer
status: complete
finding_count: 4
---

# Findings

- severity: high
  category: "rollback/operational safety"
  confidence: high
  evidence: "Plan says Wave 1 runs T1 and T2 in parallel, but only T1 creates/switches the feature branch. T2 has Depends On `--` and writes `AGENTS.md`, `justfile`, and README before any guaranteed branch preflight."
  required_fix: "Make branch preflight a serialized T0 that must pass before any file mutation, or make T2 explicitly depend on T1 acceptance criterion 1. Add a validation check that `git branch --show-current` is the feature branch before every mutating wave starts."
- severity: medium
  category: "package/install integrity"
  confidence: medium
  evidence: "The objective requires loading from repo root and from `extensions/pi-onclave`, but validation only parses package JSON and checks paths. It does not actually run `pi install git/local`, `npm install`, or import the extension entry after an npm-style install."
  required_fix: "Add a non-interactive smoke that simulates Pi's git install path with npm: clean checkout or temp copy, `npm install`, then `pi --no-extensions -e ./extensions/pi-onclave --help` or equivalent entry import. Also test local install from `extensions/pi-onclave` if that is a supported target."
- severity: medium
  category: "dependency/confused-deputy risk"
  confidence: medium
  evidence: "The plan prefers relative imports and defers package-name imports, while also adding `packages/core/package.json`. This can produce a package that works in the repo but fails when `extensions/pi-onclave` is installed/loaded as a package boundary because its runtime dependency on core is not expressed or packed."
  required_fix: "Define one supported runtime dependency path. Either keep root-only Pi install as the sole target, or make `extensions/pi-onclave/package.json` explicitly depend on/pack core and validate from that package directory. Update docs to avoid claiming unsupported package-local install behavior."
- severity: low
  category: "archive/evidence hygiene"
  confidence: medium
  evidence: "Archive gates require validation success but do not require recording command outputs, dependency/lockfile diff, or a check that generated artifacts such as `node_modules`, caches, or local Pi state were not accidentally staged."
  required_fix: "Add an archive preflight: `git status --short`, `git diff --check`, targeted secret scan of changed files, and confirmation that generated directories/local state are unstaged. Record concise evidence for `just setup && just check` and Pi smoke checks before F5."
