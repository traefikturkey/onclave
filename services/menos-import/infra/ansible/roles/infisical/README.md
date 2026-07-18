# Infisical Ansible Role

Deploys self-hosted Infisical behind Caddy with a dedicated Postgres container.

## Required vault variables

- `vault_infisical_encryption_key`: Infisical data encryption key. Generate a strong random value and store it in the password manager.
- `vault_infisical_auth_secret`: Infisical auth/JWT secret. Generate a strong random value and store it in the password manager.
- `vault_infisical_postgres_password`: Password for the dedicated `infisical` Postgres user.
- `vault_infisical_cloudflare_api_token`: Cloudflare API token scoped to the `ilude.com` zone with `Zone:Read` and `DNS:Edit`. Caddy uses Zone Read to discover the zone for `_acme-challenge.infisical.ilude.com` and DNS Edit to create/remove TXT records.

## Required non-secret variables

- `infisical_domain`: Public DNS name. Defaults to `infisical.ilude.com`.
- `infisical_caddy_email`: Email used for Caddy ACME registration.
- `infisical_deploy_path`: Directory where compose files are rendered. Defaults to `{{ deploy_path }}/infisical`.

## Caddy Cloudflare DNS-01

The role builds a local Caddy image with `github.com/caddy-dns/cloudflare` using pinned versions:

- `infisical_caddy_version`
- `infisical_xcaddy_version`
- `infisical_caddy_cloudflare_module_version`

`infisical_caddy_letsencrypt_staging` defaults to `true` for first deploys. Switch it to `false` only after staging issuance and HTTPS validation pass.

## Secret handling

- Cloudflare credentials are rendered only to `caddy.env` with mode `0600`.
- `caddy.env` is loaded only by the Caddy service.
- `CLOUDFLARE_API_TOKEN` must never be added to `infisical.env` or consumed by the Infisical app container.
- Token render/copy tasks use `no_log: true` and `diff: false`; do not inspect or publish rendered token diffs.
- Environment variables can appear in `docker inspect` output for the Caddy container. Treat host Docker access as privileged and do not paste inspect output into logs or tickets.

## Network exposure

- DNS-01 does not require inbound port 80.
- `infisical_caddy_bind_http` defaults to `false`.
- `infisical_caddy_bind_https` defaults to `true` for LAN/VPN clients.
- Confirm host firewall and port conflicts before live deploy.

## Joyride DNS

For initial deployment, prefer a Joyride static host entry:

```text
192.168.16.241 infisical.ilude.com
```

The Caddy service also has a `coredns.host.name` label as an optional convenience. Use it only after confirming Joyride resolves the label to `192.168.16.241`.

## Notes

- Infisical and Postgres stay on Docker networks; Postgres is internal only.
- SMTP is intentionally not configured by default. Root account recovery is handled by the documented DB-edit runbook.
- The rendered `infisical.env` and `caddy.env` files are mode `0600` and must never be committed.
