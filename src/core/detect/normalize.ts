// 検出用の正規化。1文字を1文字に置き換えるだけなので、原文とオフセットが一致する（FR-01「原文の位置との対応を保つ」）

const FULLWIDTH_START = 0xff01;
const FULLWIDTH_END = 0xff5e;
const FULLWIDTH_OFFSET = 0xfee0;

/** 全角英数記号を半角に、全角空白を半角空白にする。長さは変えない */
export function normalizeForDetection(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= FULLWIDTH_START && code <= FULLWIDTH_END) {
      out += String.fromCharCode(code - FULLWIDTH_OFFSET);
    } else if (code === 0x3000) {
      out += ' ';
    } else if (code === 0x2010 || code === 0x2011 || code === 0x2012 || code === 0x2013 || code === 0x2212) {
      // ハイフンに似た記号（‐ ‑ ‒ – −）
      out += '-';
    } else {
      out += text[i];
    }
  }
  return out;
}

/** 比較用のキー。空白を除き、正規化する（同一対象の判定や辞書照合に使う） */
export function comparisonKey(text: string): string {
  return normalizeForDetection(text).replace(/\s+/g, '').toLowerCase();
}
