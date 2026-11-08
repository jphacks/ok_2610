// テスト用の小さな PDF を組み立てる。ページごとに文字の行を並べる（空の配列なら文字のないページ）。
// 日本語は埋め込みなしの Adobe-Japan1 フォント（UniJIS-UCS2-H）で書くので、読むには CMap が要る。

type Line = string;

function utf16Hex(s: string): string {
  let hex = '';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code > 0xffff) throw new Error('BMP の文字だけ使えます');
    hex += code.toString(16).padStart(4, '0').toUpperCase();
  }
  return hex;
}

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);
const escapeLiteral = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);

export function buildPdf(pages: Line[][]): Uint8Array {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body) as number; // 戻り値はオブジェクト番号（1始まり）

  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('PAGES'); // 後で埋める
  const latin = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const descriptor = add('<< /Type /FontDescriptor /FontName /HeiseiKakuGo-W5 /Flags 4 /FontBBox [0 -120 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>');
  const cid = add(`<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HeiseiKakuGo-W5 /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 2 >> /FontDescriptor ${descriptor} 0 R /DW 1000 >>`);
  const ja = add(`<< /Type /Font /Subtype /Type0 /BaseFont /HeiseiKakuGo-W5 /Encoding /UniJIS-UCS2-H /DescendantFonts [${cid} 0 R] >>`);

  const pageIds: number[] = [];
  for (const lines of pages) {
    let stream = '';
    lines.forEach((line, i) => {
      const y = 780 - i * 24;
      stream += isAscii(line) ? `BT /F1 12 Tf 50 ${y} Td (${escapeLiteral(line)}) Tj ET\n` : `BT /F2 12 Tf 50 ${y} Td <${utf16Hex(line)}> Tj ET\n`;
    });
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
    pageIds.push(
      add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${latin} 0 R /F2 ${ja} 0 R >> >> /Contents ${content} 0 R >>`),
    );
  }
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  let out = '%PDF-1.7\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out); // 中身はすべて ASCII なので、文字数とバイト数が一致する
}
