import { randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_TIME = 2 ** 48 - 1;

export function ulid(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) {
    throw new Error(`ulid timestamp out of range: ${now}`);
  }
  let time = "";
  let remaining = now;
  for (let index = 0; index < 10; index += 1) {
    time = ENCODING[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }
  const bytes = randomBytes(10);
  let random = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      random += ENCODING[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return time + random;
}

export function isUlid(value: unknown): value is string {
  return typeof value === "string" && ULID_RE.test(value);
}
