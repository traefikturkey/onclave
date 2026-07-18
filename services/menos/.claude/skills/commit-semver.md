# Commit Semver Skill

Activate when preparing commits, writing commit messages, or deciding version bumps.

## Goal

Infer the correct semantic version bump from staged changes, apply it, and include the reasoning in the commit.

## Decision Framework

Choose the highest applicable bump:

1. `major`
   - Breaking API contract changes
   - Breaking schema behavior changes
   - Incompatible endpoint/request/response changes
2. `minor`
   - New backward-compatible features
   - New endpoint/capability without breaking existing behavior
3. `patch`
   - Bug fixes
   - Refactors that keep behavior compatible
   - Tests/docs/chore updates

## Execution Steps

1. Review staged diff and classify change type.
2. Apply bump:
   - `make version-bump-major`
   - `make version-bump-minor`
   - `make version-bump-patch`
3. Validate version format:
   - `make version-check`
4. Ensure commit message includes:
   - selected bump level
   - why this level was selected

## Safety Rules

- Do not bump more than one level per commit.
- Do not skip semver update when code changes are being released.
- If change classification is ambiguous, default to lower bump and explain why.
