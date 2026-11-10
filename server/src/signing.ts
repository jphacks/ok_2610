import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// 組織ポリシーの署名（SERVER_DESIGN.md §12-3）。Ed25519 で署名し、公開鍵を MDM の初期設定で端末に配る。
// 秘密鍵は DB と分けて置く。本番は環境変数（KMS などから注入）、開発はデータのフォルダのファイル。

export type Signer = {
  /** 拡張に配る公開鍵（SPKI の DER を base64 にしたもの） */
  publicKey: string;
  sign: (data: Uint8Array) => Uint8Array;
};

function signerFrom(privateKey: KeyObject): Signer {
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('ポリシーの署名鍵は Ed25519 にしてください。');
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');
  return { publicKey, sign: (data) => new Uint8Array(sign(null, data, privateKey)) };
}

/** 試験・一時的な起動用。起動のたびに鍵が変わるので、端末に配った公開鍵と合わなくなる */
export function ephemeralSigner(): Signer {
  return signerFrom(generateKeyPairSync('ed25519').privateKey);
}

/**
 * 署名鍵を読む。pem（PKCS#8 の PEM）があればそれを使い、なければ path のファイルを読む。
 * ファイルもなければ作る（開発用。作ったファイルは Git に入れない）。
 */
export function loadSigner({ pem, path }: { pem?: string | undefined; path: string }): Signer {
  if (pem) return signerFrom(createPrivateKey(pem.replace(/\\n/g, '\n')));
  if (existsSync(path)) return signerFrom(createPrivateKey(readFileSync(path, 'utf8')));
  const { privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), { mode: 0o600 });
  console.info(`ポリシーの署名鍵を作りました: ${path}`);
  return signerFrom(privateKey);
}
