import { readFile } from "node:fs/promises";
import type { OnclavePaths } from "./state";

export async function loadIdentityPrivateKeyHex(paths: OnclavePaths): Promise<string> {
  const privateKeyHex = (await readFile(paths.privateKey, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/i.test(privateKeyHex)) {
    throw new Error("identity private key must be 32 bytes of hex");
  }
  return privateKeyHex.toLowerCase();
}
