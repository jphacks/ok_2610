// 履歴書の文章から「隠すべき箇所」の正解を、項目名（氏名・現住所・電話番号など）だけを頼りに作る。検出器のコードは使わない。
// 検証用の合成履歴書（20 の型・各 500 件）の項目名に合わせてある。別の様式の履歴書で測るときは項目名を足す。
export type Field =
  | 'name' | 'kana' | 'dob' | 'postal' | 'address' | 'phone' | 'email'
  | 'altAddress' | 'altPhone' | 'school' | 'company' | 'station' | 'practicum';
export type Truth = { field: Field; start: number; end: number; text: string };

const LABELS = new Set([
  '氏名', 'ふりがな', 'フリガナ', '生年月日', '現住所', '電話番号', 'メールアドレス', '別の連絡先', '帰省先住所', '別連絡先の電話番号',
  '連絡先', '最寄り駅・通勤時間', '学歴・職歴', '学歴', '職歴', '年 月 内容', '免許・資格', '資格', '保有資格', '実習先・活動歴',
]);
const KANA_NAME = /^[ぁ-ゖァ-ヺー]+[\u3000 ][ぁ-ゖァ-ヺー]+$/;

export function truth(text: string): Truth[] {
  const out: Truth[] = [];
  const lines: { s: string; at: number }[] = [];
  let at = 0;
  for (const s of text.split('\n')) {
    lines.push({ s, at });
    at += s.length + 1;
  }
  const add = (field: Field, start: number, end: number) => {
    // 前後の空白は除く
    while (start < end && /\s/.test(text[start]!)) start++;
    while (end > start && /\s/.test(text[end - 1]!)) end--;
    if (end > start) out.push({ field, start, end, text: text.slice(start, end) });
  };
  const next = (i: number) => lines[i + 1];
  const values = new Map<Field, Set<string>>();
  const remember = (f: Field, v: string) => {
    if (!values.has(f)) values.set(f, new Set());
    values.get(f)!.add(v);
  };

  for (let i = 0; i < lines.length; i++) {
    const { s } = lines[i]!;
    const n = next(i);
    if (!n) continue;
    if (s === '氏名') remember('name', n.s.trim());
    else if (s === 'ふりがな' || s === 'フリガナ') {
      if (KANA_NAME.test(n.s.trim())) remember('kana', n.s.trim());
    } else if (s === '生年月日') add('dob', n.at, n.at + n.s.length);
    else if (s === '現住所' || s === '別の連絡先' || s === '帰省先住所') {
      if (n.s.trim() === '同上') continue;
      const field: Field = s === '現住所' ? 'address' : 'altAddress';
      // 次の項目名までが住所（2〜3行に折り返すことがある）
      for (let k = i + 1; k < lines.length && !LABELS.has(lines[k]!.s.trim()); k++) {
        const L = lines[k]!;
        const m = /^〒\s*([0-9０-９]{3}[-－][0-9０-９]{4})/.exec(L.s);
        if (m) {
          const ps = L.at + L.s.indexOf(m[1]!);
          add('postal', ps, ps + m[1]!.length);
          add(field, L.at + m[0].length, L.at + L.s.length);
        } else add(field, L.at, L.at + L.s.length);
      }
    } else if (s === '電話番号') add('phone', n.at, n.at + n.s.length);
    else if (s === 'メールアドレス') add('email', n.at, n.at + n.s.length);
    else if (s === '別連絡先の電話番号') add('altPhone', n.at, n.at + n.s.length);
    else if (s === '連絡先') {
      const m = /^(\S+)[\u3000 ]+(\S+@\S+)$/.exec(n.s);
      if (m) {
        add('phone', n.at, n.at + m[1]!.length);
        add('email', n.at + n.s.length - m[2]!.length, n.at + n.s.length);
      }
    } else if (s === '最寄り駅・通勤時間') {
      const m = /^(\S+駅)/.exec(n.s);
      if (m) add('station', n.at, n.at + m[1]!.length);
    } else if (s === '実習先・活動歴') {
      const m = /^(.+?)にて/.exec(n.s);
      if (m) remember('practicum', m[1]!);
    }
    // 学歴・職歴の行（間は全角の空白）: 「2019 3 学校名 学部 卒業」「2023 4 株式会社X 入社」
    const row = /^(?:19|20)\d{2} \d{1,2} (\S+?)(?:\u3000|$)/.exec(s);
    if (row) {
      const org = row[1]!;
      if (/(高等学校|大学|専門学校|高等専門学校|短期大学)$/.test(org)) remember('school', org);
      else if (/^株式会社|株式会社$/.test(org)) remember('company', org);
    }
  }
  // 中央写真の型: 項目名のない氏名（ふりがなの行のすぐ上）
  if (!values.has('name')) {
    for (let i = 1; i < lines.length; i++) {
      if (KANA_NAME.test(lines[i]!.s.trim()) && /^(?:[一-龥々]+[\u3000 ][一-龥々]+|[A-Z][a-z]+ [A-Z][a-z]+)$/.test(lines[i - 1]!.s.trim())) {
        remember('name', lines[i - 1]!.s.trim());
        remember('kana', lines[i]!.s.trim());
        break;
      }
    }
  }
  // 名前・学校・会社などは本文のどこに出てきても隠すべき
  for (const [field, set] of values) {
    for (const v of set) {
      if (!v) continue;
      for (let p = text.indexOf(v); p >= 0; p = text.indexOf(v, p + v.length)) add(field, p, p + v.length);
    }
  }
  // 重複を除く
  const seen = new Set<string>();
  return out.filter((t) => {
    const k = `${t.field}:${t.start}:${t.end}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.start - b.start);
}
