import { generateKeyPairSync } from 'node:crypto';
import { expect, test } from 'vitest';
import { loadSigner } from '../../server/src/signing';

// クラウドの環境変数には改行を入れにくいので、npm run server:keygen は改行を \n の2文字にした1行を出す。それを読めること
test('1行にした署名鍵（\\n の2文字で改行を表したもの）を、環境変数から読める', () => {
  const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim();
  const oneLine = pem.replace(/\n/g, '\\n');
  expect(oneLine).not.toContain('\n');
  const a = loadSigner({ pem: oneLine, path: 'unused' });
  const b = loadSigner({ pem, path: 'unused' });
  expect(a.publicKey).toBe(b.publicKey);
});
