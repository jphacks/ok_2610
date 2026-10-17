import type { Category, Certainty, Evidence, SensitiveKind, Span, SpanTier } from '../model/types';
import { TIER } from '../model/types';
import { luhnValid, myNumberValid } from './checksums';
import { normalizeForDetection } from './normalize';
import {
  CITY_PREFECTURE,
  DEPARTMENT_CORE,
  DEPARTMENT_SUFFIX,
  KANA_BANKS,
  NON_DEPARTMENT,
  NON_NAME_BEFORE_HONORIFIC,
  NON_STORE,
  ORG_FORM,
  ORG_SUFFIX,
  POSITIONS,
  PREFECTURES,
  RARE_CUES,
  SENSITIVE_WORDS,
  STORE_SUFFIX,
} from './vocab';

// 文字クラス。長音符「ー」と中黒「・」は Katakana に含まれないので必ず足す（前のツールで漏れた）
const HAN = '\\p{Script=Han}';
const HIRA = '\\p{Script=Hiragana}';
const KATA = '\\p{Script=Katakana}ー';
const NAME_CH = `${HAN}${KATA}・A-Za-z0-9&`;
const PREF_ALT = PREFECTURES.join('|');
const HONORIFICS = 'さん|様|さま|氏|殿|くん|君|ちゃん|先生';

type Rule = {
  id: string;
  category: Category;
  re: RegExp;
  /** 値だけを検出範囲にするときのキャプチャ番号（ラベルは残す） */
  group?: number;
  tier: SpanTier;
  certainty: Certainty;
  evidence: Evidence;
  validate?: (value: string, text: string, start: number, end: number) => boolean;
  /** 検出範囲を調整する（先頭の役職名を外すなど） */
  adjust?: (value: string, start: number) => { start: number; end: number } | null;
  sensitiveKind?: SensitiveKind;
};

function re(source: string, flags = 'gdu'): RegExp {
  return new RegExp(source, flags);
}

const pattern = (detail: string): Evidence => ({ kind: 'pattern', detail });
const label = (detail: string): Evidence => ({ kind: 'label', detail });

const NAME_LEADING_WORDS = new RegExp(`^(?:${POSITIONS}|担当|受付|窓口|係|店員|お客様|弊社|御社|貴社)+`, 'u');
const NON_NAME_ENDING = /[者員長師様方人家側客族社店部課係]$/u;

function trimNameLeading(value: string, start: number): { start: number; end: number } | null {
  const m = NAME_LEADING_WORDS.exec(value);
  const cut = m ? m[0].length : 0;
  const name = value.slice(cut).trim();
  if (!name) return null;
  const offset = value.indexOf(name, cut);
  return { start: start + offset, end: start + offset + name.length };
}

function isPersonName(value: string): boolean {
  const name = value.replace(/[（(][^）)]*[）)]/gu, '').replace(/[ \u3000]/g, '');
  if (!name) return false;
  if (NON_NAME_BEFORE_HONORIFIC.has(name)) return false;
  if (NON_NAME_ENDING.test(name) && name.length <= 3) return false;
  return true;
}

const SENSITIVE_DETAIL: Record<SensitiveKind, string> = {
  health: '健康・病歴に関する語',
  disability: '障害・介助に関する語',
  family: '家庭の事情に関する語',
  finance: '経済状況に関する語',
  crime: '犯罪・被害に関する語',
  belief: '信条・所属に関する語',
};

const NON_PLACE = new Set([
  '都市', '地区', '市区', '市区町村', '市町村', '区町村', '同市', '当市', '各市', '本市', '全市', '他市', '学区', '選挙区', '特別区', '行政区',
  '隣町', '下町', '城下町', '門前町', '港町', '農村', '漁村', '山村', '選手村', '市', '区', '町', '村', '一区', '地元', '近所', '海外', '国内',
  '都内', '市内', '区内', '町内', '村内', '県内', '府内', '道内', '県外', '関東', '関西', '地方', '全国', '現地',
]);

const NON_ORG = new Set([
  '地方銀行', '都市銀行', '信託銀行', 'ネット銀行', '大学病院', '総合病院', '動物病院', '市立病院', '国立大学', '私立大学', '公立大学', '女子大学',
  '公立高校', '私立高校', '県立高校', '都立高校', '大学', '高校', '病院', '銀行', '証券', '薬局', '歯科', '医院',
]);

const RULES: Rule[] = [
  // --- 認証情報（FR-04）---
  {
    id: 'credential-key',
    category: 'credential',
    re: re('(?<![A-Za-z0-9_-])(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})(?![A-Za-z0-9_-])'),
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: pattern('APIキーの形式'),
  },
  {
    id: 'credential-label',
    category: 'credential',
    re: re('(?:パスワード|password|Password|PASSWORD|暗証番号|PIN|APIキー|API key|アクセスキー|トークン|token|secret|シークレット|セキュリティコード|CVV|CVC)\\s*[:：=は]\\s*([^\\s、。,]{3,})'),
    group: 1,
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: label('直前に認証情報を示す語'),
  },
  // --- 連絡先・識別子（FR-01）---
  {
    id: 'email',
    category: 'email',
    re: re('[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}'),
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: pattern('メールアドレスの形式'),
  },
  {
    id: 'url',
    category: 'url',
    re: re('https?://[^\\s<>"\'（）()「」『』、。]+'),
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: pattern('URLの形式'),
  },
  {
    id: 'url-internal',
    category: 'confidential',
    re: re('https?://(?:localhost|10\\.\\d+\\.\\d+\\.\\d+|192\\.168\\.\\d+\\.\\d+|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d+\\.\\d+|[A-Za-z0-9.-]+\\.(?:local|internal|corp|lan|intranet))(?::\\d+)?[^\\s<>"\'（）()「」『』、。]*'),
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: pattern('社内向けURLの形式'),
  },
  {
    id: 'card',
    category: 'creditCard',
    re: re('(?<![\\d-])(?:\\d[ -]?){12,18}\\d(?![\\d-])'),
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: { kind: 'checksum', detail: 'カード番号の検査数字（Luhn）が一致' },
    validate: (v) => luhnValid(v),
  },
  {
    id: 'mynumber-label',
    category: 'myNumber',
    re: re('(?:マイナンバー|個人番号)\\s*[:：は]?\\s*(\\d{4}[ -]?\\d{4}[ -]?\\d{4})'),
    group: 1,
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: label('直前に「マイナンバー」'),
  },
  {
    id: 'mynumber-bare',
    category: 'myNumber',
    re: re('(?<![\\d-])\\d{4}[ -]?\\d{4}[ -]?\\d{4}(?![\\d-])'),
    tier: TIER.heuristicRule,
    certainty: '推定',
    evidence: { kind: 'checksum', detail: 'マイナンバーの検査数字が一致' },
    validate: (v) => myNumberValid(v),
  },
  {
    id: 'id-number',
    category: 'idNumber',
    re: re('(?:パスポート番号|旅券番号|運転免許証番号|免許証番号|健康保険証記号番号|保険証番号|被保険者番号|基礎年金番号|在留カード番号)\\s*[:：は]?\\s*([A-Za-z0-9-]{4,})'),
    group: 1,
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: label('直前に公的な番号を示す語'),
  },
  {
    id: 'phone',
    category: 'phone',
    re: re('(?<![\\d-])(?:\\+81[- ]?\\d{1,4}[- ]?\\d{1,4}[- ]?\\d{3,4}|0120-?\\d{2,3}-?\\d{3}|0[5789]0-?\\d{4}-?\\d{4}|\\(0\\d{1,4}\\)\\s?\\d{1,4}-\\d{3,4}|0\\d{1,4}-\\d{1,4}-\\d{3,4}|0\\d{9,10})(?![\\d-])'),
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: pattern('電話番号の形式'),
  },
  {
    id: 'postal',
    category: 'postalCode',
    re: re('(?:〒\\s?|郵便番号\\s*[:：]?\\s*)(\\d{3}-?\\d{4})'),
    group: 1,
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: label('直前に「〒」または「郵便番号」'),
  },
  {
    id: 'ip',
    category: 'ipAddress',
    re: re('(?<![\\d.])(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)(?![\\d.])'),
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: pattern('IPアドレスの形式'),
  },
  {
    id: 'order-label',
    category: 'orderNumber',
    re: re('(?:ご?注文番号|注文ID|オーダー番号|受注番号|伝票番号|お問い?合わ?せ番号|問合せ番号|予約番号|追跡番号|お荷物番号|受付番号|管理番号|契約番号|申込番号)\\s*[:：は]?\\s*([A-Za-z0-9][A-Za-z0-9-]{3,})'),
    group: 1,
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: label('直前に注文や受付の番号を示す語'),
  },
  {
    id: 'order-shape',
    category: 'orderNumber',
    re: re('(?<![A-Za-z0-9-])[A-Z]{2,5}-\\d{4,}(?:-\\d+)*(?![A-Za-z0-9-])'),
    tier: TIER.heuristicRule,
    certainty: '推定',
    evidence: pattern('英字と数字の管理番号の形'),
  },
  {
    id: 'customer-id',
    category: 'customerId',
    re: re('(?:会員番号|会員ID|顧客番号|顧客ID|お客様番号|ユーザーID|ユーザID|アカウントID|社員番号|ID)\\s*[:：は]\\s*([A-Za-z0-9_-]{3,})'),
    group: 1,
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: label('直前に会員やアカウントの番号を示す語'),
  },
  {
    id: 'account-handle',
    category: 'accountName',
    re: re('(?<![A-Za-z0-9._%+-])@[A-Za-z0-9_]{3,15}(?![A-Za-z0-9_.@])'),
    tier: TIER.heuristicRule,
    certainty: '推定',
    evidence: pattern('SNSアカウント名の形'),
  },
  {
    id: 'bank-account',
    category: 'bankAccount',
    re: re('(?:口座番号|口座)\\s*[:：は]?\\s*(?:普通|当座|貯蓄)?(?:預金)?\\s*(\\d{6,8})'),
    group: 1,
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: label('直前に「口座」'),
  },
  {
    id: 'bank-account-type',
    category: 'bankAccount',
    re: re('(?:普通|当座|貯蓄)(?:預金)?\\s*(\\d{7})(?!\\d)'),
    group: 1,
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: label('直前に預金の種類'),
  },
  // --- 日付・年齢・性別（役割は context/roles.ts で決める）---
  {
    id: 'date-ymd',
    category: 'date',
    re: re('(?<!\\d)(?:19|20)\\d{2}\\s*[年/.-]\\s*(?:1[0-2]|0?[1-9])\\s*[月/.-]\\s*(?:3[01]|[12]\\d|0?[1-9])\\s*日?(?!\\d)'),
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: pattern('年月日の形式'),
  },
  {
    id: 'date-wareki',
    category: 'date',
    re: re('(?:昭和|平成|令和)\\s*(?:元|\\d{1,2})\\s*年\\s*(?:1[0-2]|0?[1-9])\\s*月\\s*(?:3[01]|[12]\\d|0?[1-9])\\s*日'),
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: pattern('和暦の年月日'),
  },
  {
    id: 'date-md',
    category: 'date',
    re: re('(?<![\\d年/])(?:1[0-2]|0?[1-9])\\s*月\\s*(?:3[01]|[12]\\d|0?[1-9])\\s*日'),
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: pattern('月日の形式'),
  },
  {
    id: 'age',
    category: 'age',
    re: re('(?<!\\d)(\\d{1,3})\\s?(?:歳|才)'),
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: pattern('年齢の形式'),
    validate: (v) => Number(v.replace(/\D/g, '')) <= 120,
  },
  {
    id: 'age-band',
    category: 'age',
    re: re('(?<!\\d)[1-9]0代(?:前半|後半|半ば)?'),
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: pattern('年齢帯の形式'),
  },
  {
    id: 'gender',
    category: 'gender',
    re: re('男性|女性|男の子|女の子'),
    tier: TIER.heuristicRule,
    certainty: '推定',
    evidence: { kind: 'vocabulary', detail: '性別を表す語' },
  },
  // --- 住所・地域 ---
  {
    id: 'address-label',
    category: 'address',
    re: re('(?:ご?住所|所在地|お届け先|配送先|送付先|現住所|連絡先住所)\\s*[:：]\\s*([^\\n]+)'),
    group: 1,
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: label('直前に「住所」などの見出し'),
  },
  {
    id: 'address-shape',
    category: 'address',
    re: re(`(?:${PREF_ALT})?[${HAN}${KATA}のノヶケ]{1,15}?[0-9一二三四五六七八九十]{1,4}(?:丁目|番地|番|号|-)(?:[0-9]{1,5}(?:番地|番|号|-)?){0,3}(?:\\s?[${HAN}${KATA}A-Za-z]{1,15}?[0-9]{2,4}(?:号室)?)?`),
    tier: TIER.heuristicRule,
    certainty: '推定',
    evidence: pattern('丁目・番地などを含む住所の形'),
    validate: (v) => /[都道府県市区町村郡]/u.test(v.split(/[0-9一二三四五六七八九十]/u)[0] ?? ''),
    adjust: (v, start) => {
      // 「私の東京都…」のように前の語を巻き込んだら、都道府県か最後の「の」の後から始める
      const pref = PREFECTURES.map((p) => v.indexOf(p)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
      if (pref !== undefined) return { start: start + pref, end: start + v.length };
      const head = v.split(/[0-9一二三四五六七八九十]/u)[0] ?? '';
      const cityIdx = head.search(/[市区町村郡]/u);
      const no = head.lastIndexOf('の', cityIdx);
      const cut = no >= 0 && no < cityIdx ? no + 1 : 0;
      return { start: start + cut, end: start + v.length };
    },
  },
  {
    id: 'prefecture',
    category: 'place',
    re: re(`(?:${PREF_ALT})`),
    tier: TIER.heuristicRule,
    certainty: '確定',
    evidence: { kind: 'vocabulary', detail: '都道府県名' },
  },
  {
    id: 'city-known',
    category: 'place',
    re: re(`(?:${Object.keys(CITY_PREFECTURE).join('|')}|さいたま市|つくば市|いわき市|ひたちなか市|みよし市|あきる野市)`),
    tier: TIER.heuristicRule,
    certainty: '確定',
    evidence: { kind: 'vocabulary', detail: '市の名前' },
  },
  {
    id: 'city-shape',
    category: 'place',
    re: re(`(?<![${HAN}])[${HAN}]{1,4}[市区町村](?![${HAN}])`),
    tier: TIER.heuristicRule,
    certainty: '推定',
    evidence: pattern('市区町村の形'),
    validate: (v) => !NON_PLACE.has(v),
  },
  {
    id: 'residence',
    category: 'place',
    re: re(`(?<![${HAN}${KATA}])([${HAN}${KATA}]{2,10})(?:在住|出身|在勤|育ち|住まい)`),
    group: 1,
    tier: TIER.heuristicRule,
    certainty: '推定',
    evidence: { kind: 'context', detail: '直後に「在住」「出身」など' },
    validate: (v) => !NON_PLACE.has(v),
  },
  // --- 組織・店舗・部署・役職 ---
  {
    id: 'org-form-prefix',
    category: 'orgName',
    re: re(`(?:${ORG_FORM})\\s?[${NAME_CH}]{1,20}`),
    tier: TIER.heuristicRule,
    certainty: '確定',
    evidence: pattern('法人の種類（株式会社など）を含む'),
  },
  {
    id: 'org-form-suffix',
    category: 'orgName',
    re: re(`(?<![${NAME_CH}])[${NAME_CH}]{1,20}\\s?(?:株式会社|有限会社|合同会社|（株）|\\(株\\)|（有）|\\(有\\))`),
    tier: TIER.heuristicRule,
    certainty: '確定',
    evidence: pattern('法人の種類（株式会社など）を含む'),
  },
  {
    id: 'org-suffix',
    category: 'orgName',
    re: re(`(?<![${NAME_CH}])[${NAME_CH}]{1,15}(?:${ORG_SUFFIX})`),
    tier: TIER.heuristicRule,
    certainty: '推定',
    evidence: pattern('銀行・学校・病院などの名前の形'),
    validate: (v) => !NON_ORG.has(v),
  },
  {
    id: 'org-kana-bank',
    category: 'orgName',
    re: re(`(?:${KANA_BANKS.join('|')})`),
    tier: TIER.heuristicRule,
    certainty: '確定',
    evidence: { kind: 'vocabulary', detail: '金融機関の名前' },
  },
  {
    id: 'store',
    category: 'store',
    re: re(`(?<![${NAME_CH}])[${HAN}${KATA}A-Za-z0-9]{1,10}(?:${STORE_SUFFIX})(?![${HAN}])`),
    tier: TIER.heuristicRule,
    certainty: '推定',
    evidence: pattern('店舗・拠点の名前の形（〜店など）'),
    validate: (v) => !NON_STORE.has(v) && !/^(?:[0-9]+|この|その|あの)/u.test(v),
  },
  {
    id: 'department',
    category: 'department',
    re: re(`[${HAN}${KATA}A-Za-z]{0,8}?(?:${DEPARTMENT_CORE})(?:${DEPARTMENT_SUFFIX})`),
    tier: TIER.heuristicRule,
    certainty: '推定',
    evidence: { kind: 'vocabulary', detail: '部署名の語' },
    validate: (v) => !NON_DEPARTMENT.has(v),
  },
  {
    id: 'position',
    category: 'position',
    re: re(`(?:${POSITIONS})`),
    tier: TIER.heuristicRule,
    certainty: '推定',
    evidence: { kind: 'vocabulary', detail: '役職名' },
  },
  // --- 人名 ---
  {
    id: 'name-label',
    category: 'personName',
    re: re('(?:ご?氏名|お名前|名前|担当者名|署名|差出人|送信者|宛名|契約者名|名義)\\s*[:：]\\s*([^\\s、。,，\\n:：(（]{1,10}(?:[ \\u3000][^\\s、。,，\\n(（]{1,10})?)'),
    group: 1,
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: label('直前に「氏名」などの見出し'),
  },
  {
    id: 'name-honorific',
    category: 'personName',
    re: re(`(?<![${HAN}${KATA}])((?:(?:[${HAN}]{1,4}(?:[ \\u3000]?[${HAN}]{1,3})?)|(?:[${KATA}]{2,10}(?:[ \\u3000・][${KATA}]{2,10})?))(?:[（(][${HIRA}${KATA} \\u3000]+[）)])?)(?=(?:${HONORIFICS}))`),
    group: 1,
    tier: TIER.certainRule,
    certainty: '推定',
    evidence: { kind: 'honorific', detail: '直後に敬称（さん・様など）' },
    adjust: trimNameLeading,
    validate: (v) => isPersonName(v),
  },
  {
    id: 'name-self-intro',
    category: 'personName',
    re: re(`(?<![${HAN}${KATA}])((?:[${HAN}]{1,4}(?:[ \\u3000]?[${HAN}]{1,3})?)|(?:[${KATA}]{2,10}))(?=と申します|と申す|でございます|と言います|といいます)`),
    group: 1,
    tier: TIER.certainRule,
    certainty: '推定',
    evidence: { kind: 'context', detail: '直後に「と申します」など' },
    adjust: trimNameLeading,
    validate: (v) => isPersonName(v),
  },
  // --- 機密（FR-04）---
  {
    id: 'confidential-amount',
    category: 'confidential',
    re: re('(?:見積額|見積金額|お見積り?金額|契約金額|単価|仕入価格|原価|売上|予算|年収|給与|月給)\\s*[:：は]?\\s*((?:¥|￥)?[0-9,]+(?:\\.[0-9]+)?\\s*(?:万|億)?円?)'),
    group: 1,
    tier: TIER.heuristicRule,
    certainty: '推定',
    evidence: label('直前に金額や契約条件を示す語'),
  },
  {
    id: 'confidential-marker',
    category: 'confidential',
    re: re('社外秘|部外秘|極秘|機密情報|未公表|未発表|内部資料|取扱注意|confidential|CONFIDENTIAL'),
    tier: TIER.heuristicRule,
    certainty: '推定',
    evidence: { kind: 'vocabulary', detail: '機密の区分を示す語' },
  },
  // --- 組合せ評価の手がかり ---
  {
    id: 'rare',
    category: 'rareTrait',
    re: re(`(?:${RARE_CUES})`),
    tier: TIER.heuristicRule,
    certainty: '推定',
    evidence: { kind: 'vocabulary', detail: '人物を絞り込める表現' },
  },
  ...SENSITIVE_WORDS.map(
    ({ kind, words }): Rule => ({
      id: `sensitive-${kind}`,
      category: 'sensitive',
      re: re(`(?:${words})`),
      tier: TIER.heuristicRule,
      certainty: '推定',
      evidence: { kind: 'vocabulary', detail: SENSITIVE_DETAIL[kind] },
      sensitiveKind: kind,
    }),
  ),
];

/** 規則エンジン。全角は半角にそろえて照合し、範囲は原文の位置で返す */
export function detectRules(text: string): Span[] {
  const norm = normalizeForDetection(text);
  const spans: Span[] = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of norm.matchAll(rule.re)) {
      const indices = m.indices?.[rule.group ?? 0];
      if (!indices) continue;
      let [start, end] = indices;
      let value = norm.slice(start, end);
      // 末尾の空白や句読点は範囲に含めない
      const trimmed = value.replace(/[\s、。,.]+$/u, '');
      end = start + trimmed.length;
      value = trimmed;
      if (rule.adjust) {
        const adjusted = rule.adjust(value, start);
        if (!adjusted) continue;
        ({ start, end } = adjusted);
        value = norm.slice(start, end);
      }
      if (end <= start) continue;
      if (rule.validate && !rule.validate(value, norm, start, end)) continue;
      spans.push({
        start,
        end,
        category: rule.category,
        source: 'rule',
        certainty: rule.certainty,
        evidence: [rule.evidence],
        tier: rule.tier,
        ...(rule.sensitiveKind ? { sensitiveKind: rule.sensitiveKind } : {}),
      });
    }
  }
  return spans;
}

export const RULE_ENGINE_VERSION = 'rule-1';
