# Pi Onclave Extension

This package contains the Pi extension entrypoint for Onclave.

## Local loading

From the repository root:

```bash
just setup
pi -e ./extensions/pi-onclave
```

The package metadata also declares `./src/onclave.ts` in `pi.extensions` for repo-local package loading.

## Scope

`extensions/pi-onclave` is supported when it remains inside this repo checkout. It imports implementation code from `packages/core` using relative source imports, so it is not a standalone copied package yet.
