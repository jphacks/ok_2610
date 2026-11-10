import { base64Decode, base64UrlDecode, PolicyPayloadSchema, SignedPolicySchema, type PolicyPayload } from '../../shared/management';

// サーバーから受け取ったポリシーの署名を確かめる（SERVER_DESIGN.md §12-3）。WebCrypto の Ed25519 を使い、ライブラリは足さない。
// 手元の保存場所（chrome.storage.local）は利用者が DevTools で書き換えられるので、読むたびにここを通す。

/** 署名が合い、形式も正しいときだけ中身を返す */
export async function verifySignedPolicy(signed: unknown, publicKeySpkiBase64: string): Promise<PolicyPayload | null> {
  const parsed = SignedPolicySchema.safeParse(signed);
  if (!parsed.success) return null;
  try {
    const key = await crypto.subtle.importKey('spki', toBuffer(base64Decode(publicKeySpkiBase64)), { name: 'Ed25519' }, false, ['verify']);
    const bytes = base64UrlDecode(parsed.data.payload);
    const ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, toBuffer(base64UrlDecode(parsed.data.signature)), toBuffer(bytes));
    if (!ok) return null;
    const payload = PolicyPayloadSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return payload.success ? payload.data : null;
  } catch {
    return null;
  }
}

/** 文字列の SHA-256（16進）。登録トークンと署名の宛先を照らし合わせるのに使う */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
