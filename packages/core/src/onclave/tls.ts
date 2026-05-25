import { readFile, writeFile } from "node:fs/promises";
import selfsigned from "selfsigned";
import type { OnclavePaths } from "./state";
import { ensureOnclaveRoot } from "./state";
import type { TlsMaterial } from "./wss-transport";

export type TlsMaterialGenerator = () => Promise<TlsMaterial>;

export async function loadOrCreateTlsMaterial(
  paths: OnclavePaths,
  generator: TlsMaterialGenerator = generateSelfSignedTlsMaterial
): Promise<TlsMaterial> {
  await ensureOnclaveRoot(paths.root);

  const existing = await readExistingTls(paths);
  if (existing) return existing;

  const material = await generator();
  validateTlsMaterial(material);

  await writeFile(paths.tlsCert, material.cert, { mode: 0o644 });
  await writeFile(paths.tlsKey, material.key, { mode: 0o600 });
  return material;
}

async function readExistingTls(paths: OnclavePaths): Promise<TlsMaterial | null> {
  try {
    const [cert, key] = await Promise.all([
      readFile(paths.tlsCert, "utf8"),
      readFile(paths.tlsKey, "utf8"),
    ]);
    const material = { cert, key };
    validateTlsMaterial(material);
    return material;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function generateSelfSignedTlsMaterial(): Promise<TlsMaterial> {
  const now = new Date();
  const notAfterDate = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  const material = await selfsigned.generate(
    [{ name: "commonName", value: "localhost" }],
    {
      notBeforeDate: now,
      notAfterDate,
      keySize: 2048,
      algorithm: "sha256",
      extensions: [
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", serverAuth: true, clientAuth: true },
        { name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }] },
      ],
    }
  );

  return {
    cert: material.cert,
    key: material.private,
  };
}

function validateTlsMaterial(material: TlsMaterial): void {
  if (!material.cert.includes(pemBegin("CERTIFICATE"))) {
    throw new Error("TLS certificate must be PEM encoded");
  }
  if (
    !material.key.includes(pemBegin("PRIVATE KEY")) &&
    !material.key.includes(pemBegin("RSA PRIVATE KEY")) &&
    !material.key.includes(pemBegin("EC PRIVATE KEY"))
  ) {
    throw new Error("TLS private key must be PEM encoded");
  }
}

function pemBegin(label: string): string {
  return `-----${"BEGIN"} ${label}-----`;
}


function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
