import "@tanstack/react-start/server-only";

import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password and session-token primitives.
 *
 * scrypt via node:crypto rather than a dependency: it runs identically under the
 * Node process that serves the dev site and the Bun process that serves the built
 * site, and it keeps the dependency surface at zero for something this load-bearing.
 * The algorithm parameters are recorded alongside each digest so a future cost bump
 * re-hashes on next login instead of invalidating every account.
 */

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

export const PASSWORD_ALGO = `scrypt$${String(SCRYPT_N)}$${String(SCRYPT_R)}$${String(SCRYPT_P)}$${String(KEY_LENGTH)}`;

export interface PasswordDigest {
  hash: string;
  salt: string;
  algo: string;
}

export function hashPassword(password: string): PasswordDigest {
  const salt = randomBytes(SALT_BYTES).toString("hex");
  const hash = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
    .toString("hex");
  return { hash, salt, algo: PASSWORD_ALGO };
}

export function verifyPassword(
  password: string,
  digest: { password_hash: string | null; password_salt: string | null; password_algo: string | null }
): boolean {
  if (!digest.password_hash || !digest.password_salt) return false;
  const [, n, r, p, keylen] = (digest.password_algo ?? PASSWORD_ALGO).split("$");
  const expected = Buffer.from(digest.password_hash, "hex");
  let actual: Buffer;
  try {
    actual = scryptSync(password, digest.password_salt, Number(keylen ?? KEY_LENGTH), {
      N: Number(n ?? SCRYPT_N),
      r: Number(r ?? SCRYPT_R),
      p: Number(p ?? SCRYPT_P),
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** A fresh opaque session token. Only its digest is ever stored. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newId(): string {
  return randomUUID();
}
