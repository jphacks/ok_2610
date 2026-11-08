import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFContext,
  type PDFObject,
} from 'pdf-lib';

// pdf-lib のオブジェクトを読むための小さな道具（Issue #9）。参照（PDFRef）は自動でたどる。

export const N = (s: string) => PDFName.of(s);

export function resolve(ctx: PDFContext, obj: PDFObject | undefined): PDFObject | undefined {
  let cur = obj;
  for (let i = 0; cur instanceof PDFRef && i < 32; i++) cur = ctx.lookup(cur);
  return cur instanceof PDFRef ? undefined : cur;
}

export function dictGet(ctx: PDFContext, dict: PDFDict | undefined, key: string): PDFObject | undefined {
  return dict ? resolve(ctx, dict.get(N(key))) : undefined;
}

export function getDict(ctx: PDFContext, dict: PDFDict | undefined, key: string): PDFDict | undefined {
  const v = dictGet(ctx, dict, key);
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return undefined;
}

export function getArray(ctx: PDFContext, dict: PDFDict | undefined, key: string): PDFArray | undefined {
  const v = dictGet(ctx, dict, key);
  return v instanceof PDFArray ? v : undefined;
}

export function getNumber(ctx: PDFContext, dict: PDFDict | undefined, key: string): number | undefined {
  const v = dictGet(ctx, dict, key);
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

export function getName(ctx: PDFContext, dict: PDFDict | undefined, key: string): string | undefined {
  const v = dictGet(ctx, dict, key);
  return v instanceof PDFName ? v.decodeText() : undefined;
}

export function arrayNumbers(ctx: PDFContext, arr: PDFArray | undefined): number[] {
  if (!arr) return [];
  const out: number[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const v = resolve(ctx, arr.get(i));
    out.push(v instanceof PDFNumber ? v.asNumber() : NaN);
  }
  return out;
}

export function textOf(obj: PDFObject | undefined): string | undefined {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText();
  if (obj instanceof PDFName) return obj.decodeText();
  return undefined;
}

/** ストリームの中身を、フィルタを外した状態で取り出す */
export function streamBytes(stream: PDFStream): Uint8Array {
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  const s = stream as PDFStream & { getUnencodedContents?: () => Uint8Array; getContents: () => Uint8Array };
  return s.getUnencodedContents ? s.getUnencodedContents() : s.getContents();
}

/** 親をたどって継承される値（Resources, MediaBox など）を読む */
export function inherited(ctx: PDFContext, node: PDFDict, key: string): PDFObject | undefined {
  let cur: PDFDict | undefined = node;
  for (let i = 0; cur && i < 64; i++) {
    const v = cur.get(N(key));
    if (v !== undefined) return resolve(ctx, v);
    const parent = resolve(ctx, cur.get(N('Parent')));
    cur = parent instanceof PDFDict ? parent : undefined;
  }
  return undefined;
}

export function refKey(ref: PDFRef | undefined): string | undefined {
  return ref ? `${ref.objectNumber} ${ref.generationNumber}` : undefined;
}
