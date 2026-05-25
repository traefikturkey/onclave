import { describe, expect, it } from "bun:test";
import {
  parseAuthorizedKeys,
  parseSshEd25519PublicKeyLine,
} from "../src/lib/authorized-keys";

const VALID_KEY_LINE =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM1NZk8j6HsQb8Bv0yFVCNLU4lSxt1z0XkTPMFCBmbix test@example";

const VALID_KEY_WITH_SPACES =
  "   ssh-ed25519   AAAAC3NzaC1lZDI1NTE5AAAAIM1NZk8j6HsQb8Bv0yFVCNLU4lSxt1z0XkTPMFCBmbix   comment with spaces   ";

const RSA_KEY_LINE =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC7 unsupported@example";

const OPTIONED_KEY_LINE =
  "from=\"192.168.1.*\" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM1NZk8j6HsQb8Bv0yFVCNLU4lSxt1z0XkTPMFCBmbix optioned@example";

describe("authorized_keys parser", () => {
  it("parses a valid ssh-ed25519 key line", () => {
    const key = parseSshEd25519PublicKeyLine(VALID_KEY_LINE, 1);

    expect(key.type).toBe("ssh-ed25519");
    expect(key.publicKeyBytes).toHaveLength(32);
    expect(key.comment).toBe("test@example");
    expect(key.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]+$/);
    expect(key.lineNumber).toBe(1);
  });

  it("accepts extra whitespace and comment text", () => {
    const key = parseSshEd25519PublicKeyLine(VALID_KEY_WITH_SPACES, 2);

    expect(key.publicKeyBytes).toHaveLength(32);
    expect(key.comment).toBe("comment with spaces");
  });

  it("ignores blank lines and comments in full files", () => {
    const keys = parseAuthorizedKeys(`\n# comment\n${VALID_KEY_LINE}\n\n`);

    expect(keys).toHaveLength(1);
    expect(keys[0]?.comment).toBe("test@example");
  });

  it("rejects unsupported key types", () => {
    expect(() => parseSshEd25519PublicKeyLine(RSA_KEY_LINE, 1)).toThrow(
      /unsupported authorized key type/
    );
  });

  it("rejects authorized_keys options in v1", () => {
    expect(() => parseSshEd25519PublicKeyLine(OPTIONED_KEY_LINE, 1)).toThrow(
      /authorized_keys options are not supported/
    );
  });

  it("rejects malformed base64 payloads", () => {
    expect(() =>
      parseSshEd25519PublicKeyLine("ssh-ed25519 not-base64 test@example", 1)
    ).toThrow(/invalid ssh-ed25519 key payload/);
  });

  it("rejects OpenSSH payloads with the wrong inner key type", () => {
    const badPayload = Buffer.concat([
      encodeSshString(Buffer.from("ssh-rsa", "utf8")),
      encodeSshString(Buffer.alloc(32, 1)),
    ]).toString("base64");

    expect(() =>
      parseSshEd25519PublicKeyLine(`ssh-ed25519 ${badPayload} bad@example`, 1)
    ).toThrow(/inner key type/);
  });

  it("rejects OpenSSH payloads with non-32-byte Ed25519 keys", () => {
    const badPayload = Buffer.concat([
      encodeSshString(Buffer.from("ssh-ed25519", "utf8")),
      encodeSshString(Buffer.alloc(31, 1)),
    ]).toString("base64");

    expect(() =>
      parseSshEd25519PublicKeyLine(`ssh-ed25519 ${badPayload} bad@example`, 1)
    ).toThrow(/32 bytes/);
  });
});

function encodeSshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length, 0);
  return Buffer.concat([length, value]);
}
