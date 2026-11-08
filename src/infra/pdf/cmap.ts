import { Lexer, type Token } from './lexer';

// CMap（文字コード → Unicode / CID の対応表）を読む（Issue #9）。
// ToUnicode と、フォントに埋め込まれた符号化の CMap の両方に使う。

export type CodeRange = { bytes: number; low: number; high: number };

export type CMap = {
  ranges: CodeRange[];
  /** 文字コード → Unicode 文字列（ToUnicode） */
  unicode: Map<number, string>;
  /** 文字コード → CID（符号化 CMap） */
  cid: Map<number, number>;
  cidRanges: { low: number; high: number; start: number; bytes: number }[];
  vertical: boolean;
  /** usecmap で参照している既定の CMap の名前 */
  useCMap?: string;
};

const bytesToInt = (b: Uint8Array) => b.reduce((v, x) => v * 256 + x, 0);

function utf16be(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
  if (b.length % 2) s += String.fromCharCode(b[b.length - 1]!);
  return s;
}

/** 文字列の最後の UTF-16 単位を n 進める（bfrange の連番） */
function bump(s: string, n: number): string {
  if (!s) return s;
  const last = s.charCodeAt(s.length - 1) + n;
  return s.slice(0, -1) + String.fromCharCode(last);
}

export function parseCMap(bytes: Uint8Array): CMap {
  const lx = new Lexer(bytes);
  const cmap: CMap = { ranges: [], unicode: new Map(), cid: new Map(), cidRanges: [], vertical: false };
  const stack: Token[] = [];
  for (;;) {
    const tok = lx.next();
    if (tok === null) break;
    if (tok.t !== 'kw') {
      stack.push(tok);
      continue;
    }
    switch (tok.v) {
      case 'usecmap': {
        const n = stack.pop();
        if (n?.t === 'name') cmap.useCMap = n.v;
        break;
      }
      case 'def': {
        const value = stack.pop();
        const key = stack.pop();
        if (key?.t === 'name' && key.v === 'WMode' && value?.t === 'num') cmap.vertical = value.v === 1;
        break;
      }
      case 'endcodespacerange':
        for (let i = 0; i + 1 < stack.length; i += 2) {
          const lo = stack[i];
          const hi = stack[i + 1];
          if (lo?.t === 'str' && hi?.t === 'str') cmap.ranges.push({ bytes: lo.bytes.length, low: bytesToInt(lo.bytes), high: bytesToInt(hi.bytes) });
        }
        break;
      case 'endbfchar':
        for (let i = 0; i + 1 < stack.length; i += 2) {
          const src = stack[i];
          const dst = stack[i + 1];
          if (src?.t !== 'str') continue;
          const code = bytesToInt(src.bytes);
          if (dst?.t === 'str') cmap.unicode.set(code, utf16be(dst.bytes));
          else if (dst?.t === 'name') cmap.unicode.set(code, dst.v);
        }
        break;
      case 'endbfrange':
        for (let i = 0; i + 2 < stack.length; i += 3) {
          const lo = stack[i];
          const hi = stack[i + 1];
          const dst = stack[i + 2];
          if (lo?.t !== 'str' || hi?.t !== 'str') continue;
          const a = bytesToInt(lo.bytes);
          const b = bytesToInt(hi.bytes);
          if (b - a > 0xffff) continue;
          if (dst?.t === 'str') {
            const base = utf16be(dst.bytes);
            for (let c = a; c <= b; c++) cmap.unicode.set(c, bump(base, c - a));
          } else if (dst?.t === 'arr') {
            dst.items.forEach((item, k) => {
              if (item.t === 'str' && a + k <= b) cmap.unicode.set(a + k, utf16be(item.bytes));
            });
          }
        }
        break;
      case 'endcidchar':
        for (let i = 0; i + 1 < stack.length; i += 2) {
          const src = stack[i];
          const dst = stack[i + 1];
          if (src?.t === 'str' && dst?.t === 'num') cmap.cid.set(bytesToInt(src.bytes), dst.v);
        }
        break;
      case 'endcidrange':
        for (let i = 0; i + 2 < stack.length; i += 3) {
          const lo = stack[i];
          const hi = stack[i + 1];
          const dst = stack[i + 2];
          if (lo?.t === 'str' && hi?.t === 'str' && dst?.t === 'num') {
            cmap.cidRanges.push({ low: bytesToInt(lo.bytes), high: bytesToInt(hi.bytes), start: dst.v, bytes: lo.bytes.length });
          }
        }
        break;
      default:
        break;
    }
    if (tok.v.startsWith('end') || tok.v.startsWith('begin') || tok.v === 'def' || tok.v === 'usecmap') stack.length = 0;
  }
  return cmap;
}

/** 符号化 CMap で、文字コードの CID を引く */
export function lookupCid(cmap: CMap, code: number, length: number): number | undefined {
  const direct = cmap.cid.get(code);
  if (direct !== undefined) return direct;
  for (const r of cmap.cidRanges) if (r.bytes === length && code >= r.low && code <= r.high) return r.start + (code - r.low);
  return undefined;
}

/** バイト列の先頭から、codespace に合う文字コードの長さを決める */
export function codeLength(ranges: CodeRange[], b: Uint8Array, at: number): number {
  for (let n = 1; n <= 4; n++) {
    if (at + n > b.length) break;
    let v = 0;
    for (let k = 0; k < n; k++) v = v * 256 + b[at + k]!;
    if (ranges.some((r) => r.bytes === n && v >= r.low && v <= r.high)) return n;
  }
  // どの範囲にも合わなければ、最も短い範囲の長さで進める（PDF.js と同じ扱い）
  const min = ranges.reduce((m, r) => Math.min(m, r.bytes), 4);
  return Math.min(Math.max(1, ranges.length ? min : 1), b.length - at);
}
