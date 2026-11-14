import type { Evidence, Span } from '../model/types';
import { TIER } from '../model/types';
import type { MergedSpan } from './merge';
import { normalizeForDetection } from './normalize';

// 氏名のふりがな（読み仮名）を見つける。
// 履歴書や申込書では、氏名の欄のほかに「ふりがな」の欄があり、ひらがな・カタカナだけの読みは
// 敬称も漢字もないため、人名の規則や NER では拾えなかった。
// 文章（貼り付け・Excel・PDF・画像の OCR）はどれも同じ文章にしてから検出するので、ここで拾えば全形式で隠れる。

/** 読み仮名として拾った候補の根拠。同一対象の統合（読みを氏名と同じ人物にする）でも使う */
export const READING_DETAILS = {
  label: '直前に「ふりがな」などの見出し',
  column: '「フリガナ」などの列の値',
  ruby: '氏名のすぐ上に書かれた読み仮名',
  below: '氏名のすぐ下に書かれた読み仮名',
  paren: '氏名の直後の括弧の中の読み仮名',
} as const;

/** 住所のすぐ上に書かれた読み仮名（履歴書の「ふりがな」欄）。読みからも住所が分かるので住所として隠す */
export const ADDRESS_READING_DETAIL = '住所のすぐ上に書かれた読み仮名';

const READING_DETAIL_SET = new Set<string>(Object.values(READING_DETAILS));

export function isReadingEvidence(evidence: Evidence[]): boolean {
  return evidence.some((e) => READING_DETAIL_SET.has(e.detail));
}

// 長音符・濁点（半角を含む）は Hiragana / Katakana に含まれないので足す
const KANA = '\\p{Script=Hiragana}\\p{Script=Katakana}ー・\\u309b\\u309c\\uff70\\uff9e\\uff9f';
const KANA_ONLY = new RegExp(`^[${KANA}]+(?: +[${KANA}]+)*$`, 'u');
const HAN = /\p{Script=Han}/u;

/** 「ふりがな」の見出し。「氏名（フリガナ）」「フリガナ氏名」「カナ氏名」なども含む */
const LABEL = [
  '(?:ご?氏名|お?名前)?[(]?(?:ふりがな|フリガナ|ふり仮名|振り仮名|振仮名|よみがな|ヨミガナ|読み仮名|読みがな|読仮名|ﾌﾘｶﾞﾅ)[)]?(?:氏名|名前)?',
  'カナ氏名',
  '氏名カナ',
  '(?:ご?氏名|お?名前)[(](?:カナ|かな|ｶﾅ)[)]',
].join('|');

const LABEL_START_RE = new RegExp(`^(?:${LABEL})`, 'u');
const LABEL_ONLY_RE = new RegExp(`^\\s*(?:${LABEL})\\s*$`, 'u');

/** 見出しの後ろにあっても読みではないもの（「フリガナ を ふる」「ふりがな なし」） */
const NOT_READING = /^(?:[をはがのにでへとも](?: |$)|なし$|ふる$|つき$|不要)/u;
/** 読みにはならない、文として終わる語（「こんにちは」「よろしくね」） */
const SENTENCE_END = /(?:です|ます|でした|ました|ください|ね|よ|な|か|は|を|が)$/u;

/** 「氏名」の列の見出し */
const NAME_HEADER_RE = /^\s*(?:ご?氏名|お名前|名前|姓名|担当者名?|契約者名|申込者名|名義)\s*$/u;
const NAME_COLUMN_DETAIL = '「氏名」などの列の値';
/** 氏名の列の値として受け取る形（漢字・かなの1〜2語。数字や記号を含むものは除く） */
function isNameCell(value: string): boolean {
  if (!/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー・]{1,10}(?: [\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー・]{1,10})?$/u.test(value)) return false;
  return !isFieldLabel(value);
}

/** 表の見出しによくある語。「名前\tメール」のような見出しの行で、隣の見出しを名前と取り違えない */
const FIELD_WORDS = new Set([
  '住所', '現住所', '連絡先', '電話', '携帯', '携帯電話', 'メール', 'メールアドレス', 'アドレス', '年齢', '性別', '生年月日', '誕生日',
  '所属', '部署', '部門', '役職', '会社', '会社名', '勤務先', '職業', '学校', '学校名', '学歴', '職歴', '資格', '免許', '国籍', '血液型',
  '趣味', '特技', '備考', 'メモ', '日付', '金額', '数量', '単価', '合計', '状態', 'ステータス', '担当', '担当者', '区分', '種別', '都道府県',
  '市区町村', '本籍', '続柄', '家族', '配偶者', '扶養', '写真', '印', '署名', '署名欄', '氏', '名', '姓', '性', '年', '月', '日', '歳',
]);
const FIELD_SUFFIX = /(?:番号|年月日|日付|欄|区分|コード|アドレス|ID)$/u;

/** 「フリガナ」「氏名」「メール」などの見出しそのもの（人名の値として拾わない） */
export function isFieldLabel(value: string): boolean {
  const v = value.replace(/\s/gu, '');
  return LABEL_ONLY_RE.test(v) || NAME_HEADER_RE.test(v) || FIELD_WORDS.has(v) || FIELD_SUFFIX.test(v);
}

function isReading(value: string): boolean {
  const compact = value.replace(/ /g, '');
  if (compact.length < 2 || compact.length > 24) return false;
  if (!KANA_ONLY.test(value)) return false;
  return !NOT_READING.test(value);
}

/** 姓と名を空白で区切った氏名だけの行（漢字。名はひらがなでもよい。ローマ字の Yamada Taro も） */
const NAME_LINE = /^(?:\p{Script=Han}{1,4} [\p{Script=Han}\p{Script=Hiragana}]{1,4}|[A-Z][a-z]{1,15} [A-Z][a-z]{1,15})$/u;
const NAME_PAIR_DETAIL = '読み仮名と上下に並んだ氏名';

/** 氏名の行と上下に並んだ読み仮名か（姓と名の2語で、読みの長さが氏名に見合う） */
function isPairReading(name: string, reading: string): boolean {
  // 読みは「はるか」「れな」のように文末と同じ音で終わることがある。氏名の行と並ぶことを手がかりにするので、文末の形では外さない
  if (!isReading(reading) || /(?:です|ます|でした|ました|ください)$/u.test(reading) || LABEL_START_RE.test(reading) || isFieldLabel(name)) return false;
  const parts = reading.split(/ +/u);
  if (parts.length !== 2) return false;
  // ローマ字の氏名は字数が読みと合わないので、語の数だけで見る
  if (/^[A-Za-z ]+$/u.test(name)) return true;
  const n = name.replace(/ /g, '').length;
  const r = parts.join('').length;
  return r >= n && r <= n * 4 + 2 && name.split(' ').every((p) => !FIELD_WORDS.has(p));
}

function span(start: number, end: number, detail: string, certainty: Span['certainty'], category: Span['category'] = 'personName'): Span {
  return {
    start,
    end,
    category,
    source: 'rule',
    certainty,
    evidence: [{ kind: detail === READING_DETAILS.ruby || detail === READING_DETAILS.below || detail === READING_DETAILS.paren || detail === ADDRESS_READING_DETAIL || detail === NAME_PAIR_DETAIL ? 'context' : 'label', detail }],
    tier: TIER.certainRule,
  };
}

/** 行の位置。end は改行の手前 */
function lines(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = 0;
  for (;;) {
    const nl = text.indexOf('\n', start);
    const end = nl < 0 ? text.length : nl;
    out.push({ start, end: end > start && text[end - 1] === '\r' ? end - 1 : end });
    if (nl < 0) return out;
    start = nl + 1;
  }
}

/** 値の前後の空白を除いた範囲 */
function trimRange(text: string, start: number, end: number): { start: number; end: number } {
  while (start < end && /\s/u.test(text[start]!)) start++;
  while (end > start && /\s/u.test(text[end - 1]!)) end--;
  return { start, end };
}

/**
 * 規則として拾う読み仮名。
 * - 見出しの後ろ: 「ふりがな やまだ たろう」（全角の空白も）「フリガナ：ヤマダ タロウ」「ふりがな\tやまだ たろう」（次の行に書かれたものも）
 * - 表の列: 見出しの行に「フリガナ」のセルがあれば、その下の行の同じ列の値
 */
export function detectFurigana(text: string): Span[] {
  const norm = normalizeForDetection(text);
  const out: Span[] = [];

  // 見出しの後ろの値（同じ行か、見出しだけの行の次の行）
  const afterLabel = new RegExp(`(?:${LABEL})[ \\t]*[:：]?[ \\t]*(?:\\r?\\n[ \\t]*)?([${KANA}]+(?: +[${KANA}]+)*)`, 'gdu');
  for (const m of norm.matchAll(afterLabel)) {
    const [s, e] = m.indices![1]!;
    const value = norm.slice(s, e);
    if (!isReading(value)) continue;
    // 見出しの直後に空白も区切りもなく値が続くのは「ふりがなをふる」「ふりがなつき」のような文
    if (!/[\s:：]$/u.test(norm.slice(m.index!, s))) continue;
    out.push(span(s, e, READING_DETAILS.label, '確定'));
  }

  // 見出しのない欄（PDF・画像）: 漢字の氏名だけの行と、姓・名の区切りの数が同じ読み仮名だけの行が上下に並ぶ
  // （「山田 太郎\nやまだ たろう」「やまだ たろう\n山田 太郎」）。どちらも氏名にする
  {
    const ls = lines(norm);
    for (let i = 0; i + 1 < ls.length; i++) {
      const a = trimRange(norm, ls[i]!.start, ls[i]!.end);
      const b = trimRange(norm, ls[i + 1]!.start, ls[i + 1]!.end);
      const ta = norm.slice(a.start, a.end);
      const tb = norm.slice(b.start, b.end);
      const pair = NAME_LINE.test(ta) && isPairReading(ta, tb) ? { name: a, reading: b, detail: READING_DETAILS.below }
        : NAME_LINE.test(tb) && isPairReading(tb, ta) ? { name: b, reading: a, detail: READING_DETAILS.ruby } : null;
      if (!pair) continue;
      out.push(span(pair.name.start, pair.name.end, NAME_PAIR_DETAIL, '推定'));
      out.push(span(pair.reading.start, pair.reading.end, pair.detail, '推定'));
    }
  }

  // 表の列（Excel・CSV・表の貼り付け。セルはタブ区切り）。「フリガナ」の列は読み、「氏名」の列は氏名
  const columnRule = (cell: string): { detail: string; ok: (v: string) => boolean } | null => {
    if (LABEL_ONLY_RE.test(cell)) return { detail: READING_DETAILS.column, ok: isReading };
    if (NAME_HEADER_RE.test(cell)) return { detail: NAME_COLUMN_DETAIL, ok: isNameCell };
    return null;
  };
  const ls = lines(norm);
  for (let i = 0; i < ls.length; i++) {
    const line = norm.slice(ls[i]!.start, ls[i]!.end);
    if (!line.includes('\t')) continue;
    const cells = line.split('\t');
    const cols = new Map<number, NonNullable<ReturnType<typeof columnRule>>>();
    cells.forEach((c, k) => {
      const rule = columnRule(c);
      if (rule) cols.set(k, rule);
    });
    if (!cols.size) continue;
    for (let j = i + 1; j < ls.length; j++) {
      const row = ls[j]!;
      const rowText = norm.slice(row.start, row.end);
      // 空行・シートの見出し（【シート: 名前】）で表が終わる
      if (!rowText.trim() || /^【/u.test(rowText)) break;
      const rowCells = rowText.split('\t');
      let offset = row.start;
      for (let k = 0; k < rowCells.length; k++) {
        const cell = rowCells[k]!;
        const rule = cols.get(k);
        if (rule) {
          const r = trimRange(norm, offset, offset + cell.length);
          if (r.end > r.start && rule.ok(norm.slice(r.start, r.end))) out.push(span(r.start, r.end, rule.detail, '確定'));
        }
        offset += cell.length + 1;
      }
    }
  }
  return out;
}

/**
 * 検出した氏名に付いている読み仮名（統合のあと、ほかの検出結果を見て拾う）。
 * - 氏名の直後の括弧: 「山田太郎（やまだ たろう）」
 * - 氏名のすぐ上の行（ルビ。PDF・画像では小さな文字が上の行として読まれる）: 「やまだ たろう\n山田 太郎」
 */
export function readingSpans(merged: MergedSpan[], text: string): Span[] {
  const norm = normalizeForDetection(text);
  // NER などが読みそのものを人名として拾っていたら、同じ範囲に読みの根拠を足す（氏名と同じ人物に結びつけるため）
  const covered = (s: number, e: number) => merged.some((m) => m.start < e && s < m.end && !(m.start === s && m.end === e && m.categories.includes('personName')));
  const out: Span[] = [];
  const seen = new Set<string>();
  const push = (s: number, e: number, detail: string) => {
    const key = `${s}:${e}`;
    if (seen.has(key) || covered(s, e)) return;
    seen.add(key);
    out.push(span(s, e, detail, '推定'));
  };
  const ls = lines(norm);
  const lineOf = (pos: number) => ls.findIndex((l) => l.start <= pos && pos <= l.end);

  for (const m of merged) {
    if (!m.categories.includes('personName')) continue;
    const name = norm.slice(m.start, m.end);
    if (!HAN.test(name)) continue;

    // 直後の括弧
    const paren = /^ ?[(]([^()\n]+)[)]/u.exec(norm.slice(m.end));
    if (paren) {
      const s = m.end + paren[0].indexOf('(') + 1;
      const r = trimRange(norm, s, s + paren[1]!.length);
      if (isReading(norm.slice(r.start, r.end))) push(r.start, r.end, READING_DETAILS.paren);
    }

    // すぐ上の行（ルビ）。見出しのない欄では、すぐ下の行に読みを書くこともある（「山田 太郎\nやまだ たろう」）
    const li = lineOf(m.start);
    if (li < 0) continue;
    const nameLine = ls[li]!;
    const nameParts = name.trim().split(/ +/u);
    const compactName = nameParts.join('');
    // 氏名の行が氏名（と「氏名」の見出し・敬称）だけか
    const rest = (norm.slice(nameLine.start, m.start) + norm.slice(m.end, nameLine.end)).replace(/ご?氏名|お?名前|様|さん|殿|[\s:：]/gu, '');
    for (const [k, detail] of [[li - 1, READING_DETAILS.ruby], [li + 1, READING_DETAILS.below]] as const) {
      const near = ls[k];
      if (!near) continue;
      const r = trimRange(norm, near.start, near.end);
      const reading = norm.slice(r.start, r.end);
      if (!isReading(reading) || SENTENCE_END.test(reading) || LABEL_START_RE.test(reading)) continue;
      const readingParts = reading.split(/ +/u);
      const compactReading = readingParts.join('');
      if (compactReading.length < compactName.length || compactReading.length > compactName.length * 4 + 2) continue;
      // 姓と名の区切りの数が読みと同じか、（上の行のときは）氏名の行が氏名だけのときだけ
      const sameShape = nameParts.length >= 2 && nameParts.length === readingParts.length;
      if (k > li ? !sameShape || rest : !sameShape && rest) continue;
      push(r.start, r.end, detail);
    }
  }

  // 住所のすぐ上の行の読み仮名（間に郵便番号だけの行があってもよい）:
  // 「ほっかいどう さっぽろし ちゅうおうく\n〒0600001\n北海道札幌市中央区…」
  const addressLines = new Set<number>();
  for (const m of merged) {
    if (!m.categories.some((c) => c === 'address' || c === 'place')) continue;
    const li = lineOf(m.start);
    if (li <= 0 || addressLines.has(li)) continue;
    const line = trimRange(norm, ls[li]!.start, ls[li]!.end);
    // 住所が行の先頭から始まるときだけ（文の途中の地名の上の行は読みではない）
    if (line.start !== m.start || !HAN.test(norm.slice(m.start, m.end))) continue;
    addressLines.add(li);
    let j = li - 1;
    const prev = trimRange(norm, ls[j]!.start, ls[j]!.end);
    if (/^〒?\s?\d{3}-?\d{4}$/u.test(norm.slice(prev.start, prev.end))) j--;
    if (j < 0) continue;
    const r = trimRange(norm, ls[j]!.start, ls[j]!.end);
    const reading = norm.slice(r.start, r.end);
    const compact = reading.replace(/ /g, '');
    if (compact.length < 3 || compact.length > 60 || !KANA_ONLY.test(reading)) continue;
    // 地名は「ふくおか」「しが」のように助詞と同じ音で終わるので、SENTENCE_END ではなく文末の形だけを除く
    if (NOT_READING.test(reading) || /(?:です|ます|でした|ました|ください)$/u.test(reading) || LABEL_START_RE.test(reading)) continue;
    const key = `${r.start}:${r.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(span(r.start, r.end, ADDRESS_READING_DETAIL, '推定', 'address'));
  }
  return out;
}

/** 読み仮名の位置から、どの行かを返す（同一対象の統合用） */
function lineIndex(text: string, pos: number): number {
  let n = 0;
  for (let i = 0; i < pos && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

type LinkMention = { id: string; start: number; end: number; text: string; categories: string[]; evidence: Evidence[] };

/**
 * 読み仮名を、対応する漢字の氏名と結びつける（同じ「人物A」にする）。
 * 同じ行（表の同じ行・括弧）→ 次の行 → 前の行 の順に、いちばん近い漢字の氏名を選ぶ。
 * 戻り値は 読み仮名の id → 氏名の id
 */
export function linkReadings(mentions: LinkMention[], text: string): Map<string, string> {
  const people = mentions.filter((m) => m.categories.includes('personName'));
  const names = people.filter((m) => HAN.test(m.text)).map((m) => ({ m, line: lineIndex(text, m.start) }));
  const links = new Map<string, string>();
  for (const r of people) {
    if (HAN.test(r.text) || !isReadingEvidence(r.evidence)) continue;
    const line = lineIndex(text, r.start);
    let best: { id: string; score: number } | null = null;
    for (const n of names) {
      const d = n.line - line;
      const rank = d === 0 ? 0 : d === 1 ? 1 : d === -1 ? 2 : -1;
      if (rank < 0) continue;
      const score = rank * 1e6 + Math.abs(n.m.start - r.start);
      if (!best || score < best.score) best = { id: n.m.id, score };
    }
    if (best) links.set(r.id, best.id);
  }
  return links;
}
