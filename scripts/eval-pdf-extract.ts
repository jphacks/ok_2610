// PDF の履歴書（フォルダの下の各フォルダの .pdf）を、アプリと同じ取り込み（importPdf）で文章にし、jsonl に書く。
// 画像の OCR はしない（写真の顔は eval-pdf-faces.ts で別に確かめる）。
//
//   npx tsx scripts/eval-pdf-extract.ts <PDF のフォルダ> texts.jsonl
//
// 続けて: NER のトークン列を保存（npx tsx scripts/eval-ner-cache.ts texts.jsonl ner.jsonl <models/ のあるフォルダ>）し、
// npx tsx scripts/eval-resume-pdf.ts texts.jsonl --ner ner.jsonl --out 結果フォルダ で正解と突き合わせる。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { importPdf } from '../src/infra/pdf/document';
const [root, out] = process.argv.slice(2);
if (!root || !out) {
  console.error('usage: tsx scripts/eval-pdf-extract.ts <PDF のフォルダ> texts.jsonl');
  process.exit(1);
}
const files: string[] = [];
for (const d of readdirSync(root, { withFileTypes: true })) {
  if (d.isDirectory()) for (const f of readdirSync(join(root, d.name))) if (f.endsWith('.pdf')) files.push(join(root, d.name, f));
}
files.sort();
const lines: string[] = [];
const t0 = Date.now();
for (const [i, p] of files.entries()) {
  const id = p.slice(root.length + 1).split(sep).join('/');
  try {
    const src = await importPdf(p, new Uint8Array(readFileSync(p)), null);
    lines.push(JSON.stringify({ id, text: src.text, images: src.images.map((x) => [x.width, x.height]), notes: src.notes, blockers: src.blockers.filter((b) => !b.startsWith('画像の中の文字を読み取れない')) }));
  } catch (e) {
    lines.push(JSON.stringify({ id, error: String(e) }));
  }
  if ((i + 1) % 1000 === 0) console.error(i + 1, ((Date.now() - t0) / 1000).toFixed(0) + 's');
}
writeFileSync(out, lines.join('\n') + '\n');
console.error('done', files.length);
