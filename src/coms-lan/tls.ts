import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ComsLanPaths } from "./state";
import { ensureComsLanRoot } from "./state";
import type { TlsMaterial } from "./wss-transport";

const execFileAsync = promisify(execFile);

export type TlsMaterialGenerator = () => Promise<TlsMaterial>;

export async function loadOrCreateTlsMaterial(
  paths: ComsLanPaths,
  generator: TlsMaterialGenerator = generateSelfSignedTlsMaterial
): Promise<TlsMaterial> {
  await ensureComsLanRoot(paths.root);

  const existing = await readExistingTls(paths);
  if (existing) return existing;

  const material = await generator();
  validateTlsMaterial(material);

  await writeFile(paths.tlsCert, material.cert, { mode: 0o644 });
  await writeFile(paths.tlsKey, material.key, { mode: 0o600 });
  return material;
}

async function readExistingTls(paths: ComsLanPaths): Promise<TlsMaterial | null> {
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
  const dir = await mkdtemp(join(tmpdir(), "coms-lan-tls-"));
  try {
    await execFileAsync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        "key.pem",
        "-out",
        "cert.pem",
        "-subj",
        "/CN=localhost",
        "-days",
        "365",
      ],
      {
        cwd: dir,
        env: { ...process.env, MSYS_NO_PATHCONV: "1" },
        windowsHide: true,
      }
    );

    return {
      cert: await readFile(join(dir, "cert.pem"), "utf8"),
      key: await readFile(join(dir, "key.pem"), "utf8"),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
