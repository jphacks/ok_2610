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
/** ひらがなで始まる組織名の先頭部分（さくら・ひかり・みなと）。助詞を含むものは名前ではない */
const HIRA_NAME = `(?!という|として|とは|との|から|より|など)(?:(?![のはがをにでへ])[${HIRA}]){2,6}`;

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
  adjust?: (value: string, start: number, text: string) => { start: number; end: number } | null;
  sensitiveKind?: SensitiveKind;
};

function re(source: string, flags = 'gdu'): RegExp {
  return new RegExp(source, flags);
}

const pattern = (detail: string): Evidence => ({ kind: 'pattern', detail });
const label = (detail: string): Evidence => ({ kind: 'label', detail });

const NAME_LEADING_WORDS = new RegExp(
  `^(?:${POSITIONS}|担当者?|受付|窓口|係|店員|お客様|弊社|御社|貴社|契約者|利用者|患者|申込者|購入者|入居者|相談者|依頼者|会員|社員|同僚|部下|上司)+`,
  'u',
);
const NON_NAME_ENDING = /[者員長師様方人家側客族社店部課係]$/u;

function trimNameLeading(value: string, start: number, text: string): { start: number; end: number } | null {
  const m = NAME_LEADING_WORDS.exec(value);
  let cut = m ? m[0].length : 0;
  // 「ひかり通信 三浦亮様」のように前の語の途中から始まっていたら、空白の後だけを名前にする
  const space = value.search(/\s/u);
  if (!m && space > 0 && /[\p{Script=Hiragana}\p{Script=Han}\p{Script=Katakana}]/u.test(text[start - 1] ?? '')) cut = space + 1;
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

/** 「型番HM-2665」「HM-2665とHM-284の互換性」は製品の型番で、注文番号ではない */
const MODEL_NUMBER_BEFORE = /(?:型番|品番|型式|機種|製品番号|部品番号|モデル)\s*[:：は]?\s*$/u;
const MODEL_NUMBER_AFTER = /^(?:と[A-Z]{2,5}-\d+)?の?(?:互換|後継|部品|在庫|仕様)/u;
const PRODUCT_CODE_BEFORE = /(?:商品コード|JANコード|JAN|品番|型番|コード)\s*[:：は]?\s*$/u;
/** マイナンバーの検査数字が偶然合う、別の種類の番号 */
const OTHER_NUMBER_BEFORE = /(?:注文|伝票|追跡|荷物|問い?合わ?せ|予約|受付|管理|契約|申込|会員|顧客|社員|免許証|保険証|旅券|パスポート|口座)(?:番号|ID|No\.?)?\s*[:：は]?\s*$/u;
/** 「村」「町」で終わる姓（中村・西村など）。市区町村の形でも、人名の一部のことが多い */
const SURNAME_LIKE_PLACE = new Set([
  '中村', '西村', '木村', '田村', '北村', '松村', '野村', '岡村', '今村', '川村', '吉村', '上村', '下村', '河村', '奥村', '植村', '大村', '小村',
  '三村', '志村', '竹村', '市村', '島村', '藤村', '高村', '東村', '杉村', '中町', '大町', '小町',
]);
/** 「病院」「銀行」などの前に来ても名前ではない語 */
const NON_ORG_LEADING = /^(?:近く|大きな|小さな|地元|最寄り|かかりつけ|いつも|この|その|あの|どの|同じ|別の)/u;
/** 敬称の形でも、後ろに続いて別の語になるもの（模様替え・様式・様子・様々） */
const NOT_HONORIFIC_AFTER = '替|式|子|々|相|態|化';
/** 稀な特徴の前に付いて、絞り込む範囲を示す語（社内最年少の・その職種で唯一の） */
const RARE_SCOPE = `社内|部内|店内|校内|院内|学内|部署|店舗|支店|職場|チーム|クラス|学年|地域|業界|その[${HAN}]{1,4}`;
/** 機微な語と一続きで意味をなす前後の語（持病の喘息・がんの治療・ストーカー被害） */
const SENSITIVE_PREFIX = '持病の|腰の|膝の|夫と|妻と|電動|信仰している';
const SENSITIVE_SUFFIX = `の治療|の手術|被害|中(?![${HAN}])`;

/** メールアドレスの前に電話番号がくっついているとき（「0888-8150takahashi70@…」）は、番号の後から始める */
function trimGluedPhone(value: string, start: number): { start: number; end: number } {
  const m = /^[0-9-]*\d{4}(?=[A-Za-z])/u.exec(value);
  const cut = m && m[0].replace(/\D/g, '').length >= 7 ? m[0].length : 0;
  return { start: start + cut, end: start + value.length };
}

const ORG_TAIL = new RegExp(`(?:(?:${DEPARTMENT_CORE})(?:${DEPARTMENT_SUFFIX})|訪問.*|担当.*|御中)$`, 'u');

/** 「株式会社北斗物産人事部」「三つ葉商事株式会社訪問」のように後ろの語まで続いたら、その手前で切る */
function trimOrgTail(value: string, start: number): { start: number; end: number } | null {
  const m = ORG_TAIL.exec(value);
  const end = m ? m.index : value.length;
  return end > 0 ? { start, end: start + end } : null;
}

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
    re: re('(?:パスワード|password|Password|PASSWORD|暗証番号|PIN|APIキー|API key|アクセスキー|トークン|token|secret|シークレット|セキュリティコード|CVV|CVC)\\s*[:：=は]\\s*([^\\s、。,，()（）「」『』\\p{Script=Hiragana}]{3,})'),
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
    adjust: trimGluedPhone,
  },
  {
    id: 'email-obfuscated',
    category: 'email',
    re: re('[A-Za-z0-9._%+-]+\\s?(?:@|\\[at\\]|\\(at\\)|\\{at\\}|<at>|\\[アット\\]|\\(アット\\)|アットマーク)\\s?[A-Za-z0-9-]+(?:\\s?(?:\\.|\\[dot\\]|\\(dot\\))\\s?[A-Za-z0-9-]+)+'),
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: pattern('難読化したメールアドレスの形式（[at] など）'),
    adjust: trimGluedPhone,
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
    validate: (v, text, start) => luhnValid(v) && !PRODUCT_CODE_BEFORE.test(text.slice(Math.max(0, start - 8), start)),
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
    validate: (v, text, start) => myNumberValid(v) && !OTHER_NUMBER_BEFORE.test(text.slice(Math.max(0, start - 12), start)),
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
    re: re('(?<![\\d-])(?:\\+81[- ]?\\d{1,4}[- ]?\\d{1,4}[- ]?\\d{3,4}|0120-?\\d{2,3}-?\\d{3}|0[5789]0-?\\d{4}-?\\d{4}|\\(0\\d{1,4}\\)\\s?\\d{1,4}-?\\d{3,4}|0\\d{1,4}-\\d{1,4}-\\d{3,4}|0\\d{1,4}\\(\\d{1,4}\\)\\d{3,4}|0\\d{1,4}([. ])\\d{1,4}\\1\\d{3,4}|0\\d{9,10})(?![\\d-])'),
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: pattern('電話番号の形式'),
  },
  {
    id: 'postal',
    category: 'postalCode',
    re: re('(?:〒\\s?|郵便番号\\s*(?:[:：]|は)?\\s*)(\\d{3}-?\\d{4})(?!\\d)'),
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
    re: re('(?:ご?注文番号|注文ID|オーダー番号|受注番号|伝票番号|お?問い?合わ?せ番号|予約番号|追跡番号|お荷物番号|受付番号|管理番号|契約番号|申込番号)\\s*[:：は]?\\s*([A-Za-z0-9][A-Za-z0-9-]{3,})'),
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
    validate: (_v, text, start, end) =>
      !MODEL_NUMBER_BEFORE.test(text.slice(Math.max(0, start - 6), start)) && !MODEL_NUMBER_AFTER.test(text.slice(end, end + 12)),
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
    // ログの「user=kenta0412」「login: tanaka01」
    id: 'customer-id-log',
    category: 'customerId',
    re: re('(?<![A-Za-z])(?:user|username|userid|user_id|uid|login|account)\\s*[=:]\\s*([A-Za-z0-9._-]{3,})', 'gdui'),
    group: 1,
    tier: TIER.certainRule,
    certainty: '確定',
    evidence: label('直前に「user=」などのログの項目名'),
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
    // 先頭の「〒621-1514」は郵便番号として別に検出する
    adjust: (v, start) => {
      const head = /^〒?\s?\d{3}-?\d{4}\s*/u.exec(v)?.[0].length ?? 0;
      return head < v.length ? { start: start + head, end: start + v.length } : null;
    },
    // 「お届け先：山本裕子様」のように、見出しの後が宛名だけのものは住所ではない
    validate: (v) => /[都道府県市区町村郡0-9０-９]/u.test(v) && !new RegExp(`(?:${HONORIFICS})$`, 'u').test(v),
  },
  {
    id: 'address-shape',
    category: 'address',
    // 町名・建物名はひらがなを含みうる（美しが丘・ハイツみどり）
    re: re(`(?:${PREF_ALT})?[${HAN}${KATA}${HIRA}ヶケ]{1,15}?[0-9一二三四五六七八九十]{1,4}(?:丁目|番地|番|号|-)(?:[0-9]{1,5}(?:番地|番|号|-)?){0,3}(?:\\s?[${HAN}${KATA}${HIRA}A-Za-z]{1,15}?[0-9]{2,4}(?:号室)?)?`),
    tier: TIER.heuristicRule,
    certainty: '推定',
    evidence: pattern('丁目・番地などを含む住所の形'),
    validate: (v) => /[都道府県市区町村郡]/u.test(v.split(/[0-9一二三四五六七八九十]/u)[0] ?? ''),
    adjust: (v, start) => {
      // 「私の東京都…」のように前の語を巻き込んだら、都道府県か、市区町村の前の最後のひらがなの後から始める
      const pref = PREFECTURES.map((p) => v.indexOf(p)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
      if (pref !== undefined) return { start: start + pref, end: start + v.length };
      const head = v.split(/[0-9一二三四五六七八九十]/u)[0] ?? '';
      const cityIdx = head.search(/[市区町村郡]/u);
      let cut = 0;
      for (let i = cityIdx - 1; i >= 0; i--) {
        if (/\p{Script=Hiragana}/u.test(head[i] ?? '')) {
          cut = i + 1;
          break;
        }
      }
      return cut < cityIdx ? { start: start + cut, end: start + v.length } : null;
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
    validate: (v) => !NON_PLACE.has(v) && !SURNAME_LIKE_PLACE.has(v),
  },
  {
    // 市区町村の形から外した「村」で終わる姓（「ソラリスの中村ですが」）。地名の手がかり（在住・出身など）が続くときは除く
    id: 'surname-like-place',
    category: 'personName',
    re: re(`(?<![${HAN}])(?:${[...SURNAME_LIKE_PLACE].filter((s) => s.endsWith('村')).join('|')})(?![${HAN}]|在住|出身)`),
    tier: TIER.heuristicRule,
    certainty: '推定',
    evidence: { kind: 'vocabulary', detail: 'よくある姓' },
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
    // 法人の種類は名前の先頭にある（「三つ葉商事株式会社 経営企画室」の後半を社名にしない）。改行はまたがない
    re: re(`(?<![${NAME_CH}])(?:${ORG_FORM})[ \\u3000]?(?:${HIRA_NAME})?[${NAME_CH}]{1,20}`),
    tier: TIER.heuristicRule,
    certainty: '確定',
    evidence: pattern('法人の種類（株式会社など）を含む'),
    adjust: trimOrgTail,
  },
  {
    id: 'org-form-suffix',
    category: 'orgName',
    // 名前の途中のひらがな1文字（三つ葉商事）は許す
    re: re(`(?<![${NAME_CH}])(?:${HIRA_NAME})?[${NAME_CH}](?:[${NAME_CH}]|(?![のはがをにでへともや])[${HIRA}](?=[${NAME_CH}])){0,19}[ \\u3000]?(?:株式会社|有限会社|合同会社|（株）|\\(株\\)|（有）|\\(有\\))`),
    tier: TIER.heuristicRule,
    certainty: '確定',
    evidence: pattern('法人の種類（株式会社など）を含む'),
  },
  {
    id: 'org-suffix',
    category: 'orgName',
    // ひらがなで始まる名前（さくら内科クリニック・みなと信用金庫）も拾う
    re: re(`(?<![${NAME_CH}])(?:${HIRA_NAME})?[${NAME_CH}]{0,15}(?:${ORG_SUFFIX})`),
    tier: TIER.heuristicRule,
    certainty: '推定',
    evidence: pattern('銀行・学校・病院などの名前の形'),
    validate: (v) => !NON_ORG.has(v) && !NON_ORG_LEADING.test(v),
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
    // 名前の途中のひらがな（柏の葉店・国際通り店）は許す。「神戸市の川崎工場」「補聴器で来店」のように語はまたがない
    re: re(`(?<![${NAME_CH}])(?:[${HAN}${KATA}]{1,2}の(?=[${HAN}${KATA}]))?(?:[${HAN}${KATA}A-Za-z0-9]|(?![のはがをにでへともや])[${HIRA}](?=[${HAN}${KATA}])){1,10}(?:${STORE_SUFFIX})(?![${HAN}])`),
    tier: TIER.heuristicRule,
    certainty: '推定',
    evidence: pattern('店舗・拠点の名前の形（〜店など）'),
    validate: (v) => !NON_STORE.has(v) && !/^(?:[0-9]+|この|その|あの)/u.test(v),
  },
  {
    id: 'department',
    category: 'department',
    // 前に付く語は漢字・英字だけ（「第一営業部」「IT推進室」）。カタカナは社名の末尾のことが多い（ミナトシステム人事部）
    re: re(`[${HAN}A-Za-z]{0,6}?(?:${DEPARTMENT_CORE})(?:${DEPARTMENT_SUFFIX})`),
    tier: TIER.heuristicRule,
    certainty: '推定',
    evidence: { kind: 'vocabulary', detail: '部署名の語' },
    // 前の社名や「先方」は部署名に含めない。「〜物流センター」は拠点（店舗の規則で拾う）
    adjust: (v, start, text) => {
      // 社名の途中から始まることがあるため（「株式会社北斗物産人事部」）、少し前から社名の終わりを探す
      const from = Math.max(0, start - 8);
      const orgEnd = /^.*(?:株式会社|有限会社|合同会社|銀行|大学|病院|商事|物産)/u.exec(text.slice(from, start + v.length))?.[0].length ?? 0;
      let cut = Math.max(0, from + orgEnd - start);
      cut += /^(?:先方|弊社|当社|御社|貴社|同社)+/u.exec(v.slice(cut))?.[0].length ?? 0;
      return cut < v.length ? { start: start + cut, end: start + v.length } : null;
    },
    validate: (v) => !NON_DEPARTMENT.has(v) && !/物流センター$/u.test(v),
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
    re: re(`(?<![${HAN}${KATA}])((?:(?:[${HAN}]{1,4}(?:[ \\u3000]?[${HAN}]{1,3})?)|(?:[${KATA}]{2,10}(?:[ \\u3000・][${KATA}]{2,10})?))(?:[（(][${HIRA}${KATA} \\u3000]+[）)])?)(?=(?:${HONORIFICS})(?!${NOT_HONORIFIC_AFTER}))`),
    group: 1,
    tier: TIER.certainRule,
    certainty: '推定',
    evidence: { kind: 'honorific', detail: '直後に敬称（さん・様など）' },
    adjust: trimNameLeading,
    validate: (v) => isPersonName(v),
  },
  {
    // 漢字の姓＋ひらがなの名（中島あゆみ様・小鳥遊めぐみ様）
    id: 'name-honorific-kana-given',
    category: 'personName',
    re: re(`(?<![${HAN}${KATA}${HIRA}])([${HAN}]{1,4}[ \\u3000]?[${HIRA}]{2,4})(?=(?:さん|様|さま|氏|殿|くん|ちゃん|先生)(?!${NOT_HONORIFIC_AFTER}))`),
    group: 1,
    tier: TIER.certainRule,
    certainty: '推定',
    evidence: { kind: 'honorific', detail: '直後に敬称（さん・様など）' },
    adjust: trimNameLeading,
    // 「皆さん様」「お客さま」のように、ひらがなの部分が敬称そのもののものは除く
    validate: (v) => isPersonName(v) && !/(?:さん|さま|くん|ちゃん|たち|ども|どの)$/u.test(v),
  },
  {
    // 口座の名義やフリガナ（名義 エンドウ クミコ／岡本大輔（オカモト ダイスケ））
    id: 'name-kana-reading',
    category: 'personName',
    re: re(`(?:名義\\s*[:：]?\\s*|[${HAN}]{2,6}[（(])([${KATA}]{2,10}(?:[ \\u3000][${KATA}]{2,10})?)(?=[）)\\s、。,]|$)`),
    group: 1,
    tier: TIER.certainRule,
    certainty: '推定',
    evidence: label('口座の名義、または漢字の氏名に続くフリガナ'),
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
    id: 'confidential-amount-verb',
    category: 'confidential',
    re: re('(?<![0-9,.])((?:¥|￥)[0-9,]+|[0-9][0-9,]*(?:\\.[0-9]+)?\\s*(?:万|億)\\s*円|[0-9]{1,3}(?:,[0-9]{3})+\\s*円)(?=を?(?:返金|振込|振り込|入金|送金|融資|借入|借り入れ|貸付|支払|請求))'),
    group: 1,
    tier: TIER.heuristicRule,
    certainty: '推定',
    evidence: { kind: 'context', detail: '直後に返金・振込などお金の動きを示す語' },
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
    re: re(`(?:(?:${RARE_SCOPE})で?)?(?:${RARE_CUES})`),
    tier: TIER.heuristicRule,
    certainty: '推定',
    evidence: { kind: 'vocabulary', detail: '人物を絞り込める表現' },
  },
  ...SENSITIVE_WORDS.map(
    ({ kind, words }): Rule => ({
      id: `sensitive-${kind}`,
      category: 'sensitive',
      re: re(`(?:${SENSITIVE_PREFIX})?(?:${words})(?:${SENSITIVE_SUFFIX})?`),
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
        const adjusted = rule.adjust(value, start, norm);
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

export const RULE_ENGINE_VERSION = 'rule-2';
