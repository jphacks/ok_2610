// PDF のコンテンツストリーム（描画命令の並び）と CMap を読み書きする最小限の字句解析（Issue #9）。
// 書き換えた命令をそのまま書き戻せるよう、数値は元の表記を残す。

export type Token =
  | { t: 'num'; v: number; raw?: string }
  | { t: 'name'; v: string }
  | { t: 'str'; bytes: Uint8Array }
  | { t: 'arr'; items: Token[] }
  | { t: 'dict'; entries: [string, Token][] }
  | { t: 'kw'; v: string };

/** 演算子と引数。インライン画像（BI … ID … EI）は data に生のバイトを持つ */
export type Op = { op: string; args: Token[]; inline?: { dict: [string, Token][]; data: Uint8Array } };

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

export class PdfSyntaxError extends Error {}

export class Lexer {
  pos = 0;
  constructor(readonly b: Uint8Array) {}

  private skipWs() {
    const b = this.b;
    while (this.pos < b.length) {
      const c = b[this.pos]!;
      if (WS.has(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
      } else break;
    }
  }

  /** 次の字句。終わりなら null。配列・辞書の閉じ括弧は kw として返す */
  next(): Token | null {
    this.skipWs();
    const b = this.b;
    if (this.pos >= b.length) return null;
    const c = b[this.pos]!;
    if (c === 0x2f) return { t: 'name', v: this.readName() };
    if (c === 0x28) return { t: 'str', bytes: this.readLiteral() };
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return this.readDict();
      }
      return { t: 'str', bytes: this.readHex() };
    }
    if (c === 0x5b) {
      this.pos++;
      const items: Token[] = [];
      for (;;) {
        const tok = this.next();
        if (tok === null) throw new PdfSyntaxError('配列が閉じていません');
        if (tok.t === 'kw' && tok.v === ']') break;
        items.push(tok);
      }
      return { t: 'arr', items };
    }
    if (c === 0x5d || c === 0x7b || c === 0x7d) {
      this.pos++;
      return { t: 'kw', v: String.fromCharCode(c) };
    }
    if (c === 0x3e && b[this.pos + 1] === 0x3e) {
      this.pos += 2;
      return { t: 'kw', v: '>>' };
    }
    const start = this.pos;
    while (this.pos < b.length && !WS.has(b[this.pos]!) && !DELIM.has(b[this.pos]!)) this.pos++;
    if (this.pos === start) {
      this.pos++;
      return { t: 'kw', v: String.fromCharCode(c) };
    }
    const raw = latin1(b.subarray(start, this.pos));
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw)) return { t: 'num', v: Number(raw), raw };
    return { t: 'kw', v: raw };
  }

  private readName(): string {
    const b = this.b;
    this.pos++;
    let out = '';
    while (this.pos < b.length && !WS.has(b[this.pos]!) && !DELIM.has(b[this.pos]!)) {
      const c = b[this.pos]!;
      if (c === 0x23 && this.pos + 2 < b.length + 1) {
        const hex = latin1(b.subarray(this.pos + 1, this.pos + 3));
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          this.pos += 3;
          continue;
        }
      }
      out += String.fromCharCode(c);
      this.pos++;
    }
    return out;
  }

  private readLiteral(): Uint8Array {
    const b = this.b;
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < b.length) {
      const c = b[this.pos++]!;
      if (c === 0x5c) {
        const n = b[this.pos++];
        if (n === undefined) break;
        switch (n) {
          case 0x6e: out.push(0x0a); break;
          case 0x72: out.push(0x0d); break;
          case 0x74: out.push(0x09); break;
          case 0x62: out.push(0x08); break;
          case 0x66: out.push(0x0c); break;
          case 0x0d:
            if (b[this.pos] === 0x0a) this.pos++;
            break;
          case 0x0a:
            break;
          default:
            if (n >= 0x30 && n <= 0x37) {
              let v = n - 0x30;
              for (let k = 0; k < 2; k++) {
                const d = b[this.pos];
                if (d === undefined || d < 0x30 || d > 0x37) break;
                v = v * 8 + (d - 0x30);
                this.pos++;
              }
              out.push(v & 0xff);
            } else out.push(n);
        }
        continue;
      }
      if (c === 0x28) depth++;
      if (c === 0x29 && --depth === 0) break;
      out.push(c);
    }
    return Uint8Array.from(out);
  }

  private readHex(): Uint8Array {
    const b = this.b;
    this.pos++;
    let hex = '';
    while (this.pos < b.length && b[this.pos] !== 0x3e) {
      const c = b[this.pos++]!;
      if (!WS.has(c)) hex += String.fromCharCode(c);
    }
    this.pos++;
    if (hex.length % 2) hex += '0';
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16) || 0;
    return out;
  }

  private readDict(): Token {
    const entries: [string, Token][] = [];
    for (;;) {
      const key = this.next();
      if (key === null) throw new PdfSyntaxError('辞書が閉じていません');
      if (key.t === 'kw' && key.v === '>>') break;
      if (key.t !== 'name') continue;
      const value = this.next();
      if (value === null) throw new PdfSyntaxError('辞書が閉じていません');
      entries.push([key.v, value]);
    }
    return { t: 'dict', entries };
  }

  /** BI の後: 辞書の組を ID まで読み、続く生データを EI まで取る */
  readInlineImage(): { dict: [string, Token][]; data: Uint8Array } {
    const dict: [string, Token][] = [];
    for (;;) {
      const key = this.next();
      if (key === null) throw new PdfSyntaxError('インライン画像が閉じていません');
      if (key.t === 'kw' && key.v === 'ID') break;
      const value = this.next();
      if (key.t === 'name' && value) dict.push([key.v, value]);
    }
    const b = this.b;
    if (WS.has(b[this.pos]!)) this.pos++;
    const start = this.pos;
    // EI の前後が空白のところを終わりとみなす
    for (let i = start; i < b.length - 1; i++) {
      if (b[i] === 0x45 && b[i + 1] === 0x49 && (i === start || WS.has(b[i - 1]!)) && (i + 2 >= b.length || WS.has(b[i + 2]!) || DELIM.has(b[i + 2]!))) {
        const data = b.slice(start, i > start && WS.has(b[i - 1]!) ? i - 1 : i);
        this.pos = i + 2;
        return { dict, data };
      }
    }
    throw new PdfSyntaxError('インライン画像の終わり（EI）が見つかりません');
  }
}

const OPERAND_KW = new Set(['true', 'false', 'null']);

/** コンテンツストリームを演算子ごとに分ける */
export function parseContent(bytes: Uint8Array): Op[] {
  const lx = new Lexer(bytes);
  const ops: Op[] = [];
  let args: Token[] = [];
  for (;;) {
    const tok = lx.next();
    if (tok === null) break;
    if (tok.t !== 'kw' || OPERAND_KW.has(tok.v)) {
      args.push(tok);
      continue;
    }
    if (tok.v === 'BI') {
      ops.push({ op: 'BI', args: [], inline: lx.readInlineImage() });
      args = [];
      continue;
    }
    ops.push({ op: tok.v, args });
    args = [];
  }
  return ops;
}

// ---- 書き出し ----

export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return '0';
  if (Number.isInteger(v)) return String(v);
  const s = v.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

function nameOut(v: string): string {
  let out = '/';
  for (const ch of v) {
    const c = ch.charCodeAt(0);
    if (c < 0x21 || c > 0x7e || c === 0x23 || DELIM.has(c)) out += '#' + c.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out;
}

function hexOut(bytes: Uint8Array): string {
  let s = '<';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s + '>';
}

export function tokenOut(tok: Token): string {
  switch (tok.t) {
    case 'num': return tok.raw ?? formatNumber(tok.v);
    case 'name': return nameOut(tok.v);
    case 'str': return hexOut(tok.bytes);
    case 'arr': return '[' + tok.items.map(tokenOut).join(' ') + ']';
    case 'dict': return '<<' + tok.entries.map(([k, v]) => `${nameOut(k)} ${tokenOut(v)}`).join(' ') + '>>';
    case 'kw': return tok.v;
  }
}

/** 演算子の並びをコンテンツストリームのバイト列にする。インライン画像の生データはそのまま埋め込む */
export function serializeContent(ops: Op[]): Uint8Array {
  const parts: Uint8Array[] = [];
  let text = '';
  const enc = new TextEncoder();
  const flush = () => {
    if (text) parts.push(enc.encode(text));
    text = '';
  };
  for (const o of ops) {
    if (o.inline) {
      text += 'BI ' + o.inline.dict.map(([k, v]) => `${nameOut(k)} ${tokenOut(v)}`).join(' ') + ' ID ';
      flush();
      parts.push(o.inline.data);
      text += '\nEI\n';
      continue;
    }
    text += (o.args.length ? o.args.map(tokenOut).join(' ') + ' ' : '') + o.op + '\n';
  }
  flush();
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return s;
}

export const num = (v: number): Token => ({ t: 'num', v });
export const name = (v: string): Token => ({ t: 'name', v });
export const str = (bytes: Uint8Array): Token => ({ t: 'str', bytes });
