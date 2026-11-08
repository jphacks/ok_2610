import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// パスワード・組織トークン・セッションの扱い。平文は保存せず、ハッシュだけを DB に置く。

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } satisfies ScryptOptions;
const KEY_LEN = 32;

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, KEY_LEN, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))));
}

/** パスワードを scrypt でハッシュする（Node.js 組込み。ネイティブモジュールを足さない） */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 組織トークン（tc_ で始まる）。拡張のポリシー検証（src/core/policy.ts）と同じ形 */
export function newOrgToken(): string {
  return `tc_${randomBytes(24).toString('base64url')}`;
}

export function newSessionId(): string {
  return randomBytes(32).toString('base64url');
}
