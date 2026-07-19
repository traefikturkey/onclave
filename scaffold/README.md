# Onclave Values Scaffold

Copy this scaffold into the ignored `values/` directory with
`just values-init`. Replace all RFC 5737 addresses, example users, paths,
provider settings, and zero UUIDs inside the private values repository.

No production value belongs in tracked source. The values remote remains an
operator decision; `values-init` creates a local nested repository without a
remote.
