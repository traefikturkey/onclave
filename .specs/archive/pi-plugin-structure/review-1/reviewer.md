---
reviewer: completeness-explicitness-reviewer
status: complete
finding_count: 5
---

# Findings

- severity: high
  category: "execution-order"
  confidence: high
  evidence: "T1 includes feature branch creation, but Wave 1 marks T1 and T2 as parallel. T2 writes AGENTS.md, justfile, and README and depends on nothing, despite Constraints saying “Use a feature branch before implementation.”"
  required_fix: "Split branch creation into a preflight task that must complete before any file-writing task, or make T2 depend on T1 acceptance criterion 1. The checklist/dependency graph should reflect this serialization."
- severity: high
  category: "execution-order"
  confidence: high
  evidence: "Wave 2 marks T3 and T4 as parallel after V1. T4 edits imports/scripts/tests in files whose final paths are created by T3, and acceptance requires compiler visibility of relocated code."
  required_fix: "Make T4 depend on T3, or define a safe handoff/locking sequence where T3 completes file moves before T4 edits imports and tsconfig. Update Dependency Graph and checklist accordingly."
- severity: medium
  category: "hidden-prerequisite"
  confidence: medium
  evidence: "Objective says load from repo root and from extensions/pi-onclave, but T1 only requires root pi metadata. extensions/pi-onclave/package.json is listed but no acceptance criterion verifies its Pi metadata or entrypoint."
  required_fix: "Add explicit acceptance for extensions/pi-onclave/package.json: valid JSON, npm-install-safe dependencies, and correct `pi.extensions`/main entry pointing to src/onclave.ts, verified by a node command."
- severity: medium
  category: "weak-verification"
  confidence: high
  evidence: "Several grep checks use alternation, e.g. `grep -E 'packages/*|extensions/*' pnpm-workspace.yaml` and AGENTS.md grep. These pass if only one required token appears, not all."
  required_fix: "Replace with explicit checks for each required token or a node/yaml parser assertion that all required globs/strings exist. Update pass criteria to require all items, not any match."
- severity: medium
  category: "ambiguous-validation"
  confidence: medium
  evidence: "Pi smoke check says `just pi-local-no-extensions --help` if supported, or `pi --no-extensions -e ./extensions/pi-onclave --help`; Handoff says do not require interactive Pi. It is unclear which command must pass or what output proves extension resolution."
  required_fix: "Define one exact non-interactive smoke command with expected exit code/output, or explicitly mark Pi runtime smoke as inspect-only and require deterministic checks of justfile recipe, root pi metadata, and extension package metadata."
