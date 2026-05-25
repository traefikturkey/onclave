# onclave-comms Pi Extension

This package contains the Pi extension entrypoint for the Onclave communication
subsystem.

## Local loading

From the repository root:

```bash
just setup
pi -e ./extensions/onclave-comms
```

The package metadata also declares `./src/onclave-comms.ts` in `pi.extensions`
for repo-local package loading.

## Scope

`extensions/onclave-comms` is supported when it remains inside this repo
checkout. The current implementation, tests, and helper script live in the same
subtree for simpler monorepo navigation during the current stage of the project.
