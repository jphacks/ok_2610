import { generateKeyPairSync } from 'node:crypto';

// ポリシーの署名鍵を作る（npm run server:keygen）。クラウドの環境変数 POLICY_SIGNING_KEY に貼る1行を出す。
// 改行は \n の2文字に置き換えてある（loadSigner が元に戻す）。この値は秘密なので、ほかの人に見せない。

const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim();
console.log('POLICY_SIGNING_KEY に、次の1行をそのまま貼ってください（秘密の値です）:\n');
console.log(pem.replace(/\n/g, '\\n'));
