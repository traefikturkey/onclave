# Versioning Policy

This project uses semantic versioning (`MAJOR.MINOR.PATCH`) from `api/pyproject.toml` as the source of truth.

## Bump Rules

- `major`: Breaking contract changes (API shape, schema behavior, incompatible semantics)
- `minor`: Backward-compatible feature additions
- `patch`: Backward-compatible fixes/refactors/tests/docs updates

When unsure between two levels, choose the lower level and document the rationale in the commit message.

## Makefile Commands

Run from repository root:

```bash
make version-show
make version-check
make version-bump-major
make version-bump-minor
make version-bump-patch
make version-set VERSION=1.2.3
```

## Commit Workflow

1. Determine bump level from staged changes.
2. Apply bump with `make version-bump-{major|minor|patch}`.
3. Re-run checks (`make version-check`, tests, lint).
4. Include the selected bump level and reason in commit message body.

## Hook/CI Expectations

- Version string must match semver format.
- Release tag and `api/pyproject.toml` version must match during release validation.
