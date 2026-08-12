#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
compose_file="${repo_root}/deploy/app/onclave/compose.yaml"
build_file="${repo_root}/deploy/app/onclave/compose.build.yaml"
example_env="${repo_root}/deploy/app/onclave/.env.example"
temp_dir="$(mktemp -d)"
env_file="${temp_dir}/.env"
keys_file="${temp_dir}/authorized_keys"
private_key_file="${temp_dir}/smoke-key.pem"
key_id_file="${temp_dir}/key-id"
project_name="onclave-smoke-$(date +%s)-$$"

cleanup() {
  docker compose --project-name "${project_name}" --env-file "${env_file}" -f "${compose_file}" -f "${build_file}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "${temp_dir}"
}
trap cleanup EXIT INT TERM

cp "${example_env}" "${env_file}"
node --input-type=module - "${keys_file}" "${private_key_file}" "${key_id_file}" <<'NODE'
import { createHash, generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";

const [keysFile, privateKeyFile, keyIdFile] = process.argv.slice(2);
if (keysFile === undefined || privateKeyFile === undefined || keyIdFile === undefined) {
  throw new Error("missing smoke key paths");
}
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const spki = publicKey.export({ format: "der", type: "spki" });
const rawPublicKey = Buffer.from(spki.subarray(spki.length - 32));
const keyType = Buffer.from("ssh-ed25519", "utf8");
const keyTypeLength = Buffer.alloc(4);
keyTypeLength.writeUInt32BE(keyType.length, 0);
const keyLength = Buffer.alloc(4);
keyLength.writeUInt32BE(rawPublicKey.length, 0);
const blob = Buffer.concat([keyTypeLength, keyType, keyLength, rawPublicKey]);
writeFileSync(keysFile, `ssh-ed25519 ${blob.toString("base64")} smoke@onclave\n`, { mode: 0o600 });
writeFileSync(privateKeyFile, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
writeFileSync(keyIdFile, `SHA256:${createHash("sha256").update(blob).digest("hex").slice(0, 16)}\n`, { mode: 0o600 });
NODE

compose() {
  POSTGRES_IMAGE="pgvector/pgvector:pg17" \
  MINIO_IMAGE="quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z" \
  OLLAMA_IMAGE="ollama/ollama:latest" \
  SEARXNG_IMAGE="ghcr.io/searxng/searxng:latest" \
  DOCLING_IMAGE="quay.io/docling-project/docling-serve-cpu:v1.15.0" \
  ONCLAVE_AUTHORIZED_KEYS_FILE="${keys_file}" \
  docker compose --project-name "${project_name}" --env-file "${env_file}" -f "${compose_file}" -f "${build_file}" "$@"
}

wait_for() {
  local path="$1"
  for _ in $(seq 1 120); do
    if curl --fail --silent --show-error "http://127.0.0.1:8000${path}" >/dev/null; then
      return 0
    fi
    sleep 2
  done
  printf 'Timed out waiting for %s\n' "${path}" >&2
  return 1
}

compose up --detach --build
wait_for /health

bucket_ready=false
for _ in $(seq 1 60); do
  if compose exec -T onclave-core node --input-type=module -e '
    import { Client } from "minio";
    const client = new Client({ endPoint: "minio", port: 9000, useSSL: false, accessKey: process.env.ONCLAVE_VAULT_S3_ACCESS_KEY, secretKey: process.env.ONCLAVE_VAULT_S3_SECRET_KEY });
    const bucket = process.env.ONCLAVE_VAULT_S3_BUCKET;
    if (!(await client.bucketExists(bucket))) await client.makeBucket(bucket, "us-east-1");
  ' >/dev/null 2>&1; then
    bucket_ready=true
    break
  fi
  sleep 2
done
[[ "${bucket_ready}" == "true" ]] || {
  printf 'Timed out creating the vault S3 bucket\n' >&2
  exit 1
}
wait_for /ready

node --input-type=module - "${private_key_file}" "${key_id_file}" <<'NODE'
import { readFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";

const [privateKeyFile, keyIdFile] = process.argv.slice(2);
if (privateKeyFile === undefined || keyIdFile === undefined) throw new Error("missing signer paths");
const path = "/api/v1/auth/whoami";
const host = "127.0.0.1:8000";
const keyId = readFileSync(keyIdFile, "utf8").trim();
const created = Math.floor(Date.now() / 1000);
const params = '("@method" "@path" "@authority");keyid="' + keyId + '";alg="ed25519";created=' + created;
const signatureBase = `"@method": GET\n"@path": ${path}\n"@authority": ${host}\n"@signature-params": ${params}`;
const privateKey = createPrivateKey(readFileSync(privateKeyFile));
const signature = sign(null, Buffer.from(signatureBase, "utf8"), privateKey).toString("base64");
const response = await fetch(`http://${host}${path}`, {
  headers: {
    "signature-input": `sig1=${params}`,
    signature: `sig1=:${signature}:`,
  },
});
if (!response.ok) throw new Error(`whoami returned ${response.status}: ${await response.text()}`);
console.log(await response.text());
NODE

printf 'Onclave smoke passed\n'
