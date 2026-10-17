import type { Category, GeneralizeLevel, SensitiveKind } from '../model/types';
import { CITY_PREFECTURE, PREFECTURE_REGION, PREFECTURES } from '../detect/vocab';
import { normalizeForDetection } from '../detect/normalize';

const WAREKI_BASE: Record<string, number> = { 昭和: 1925, 平成: 1988, 令和: 2018 };

function parseYearMonth(text: string): { year?: number; month?: number } {
  const t = normalizeForDetection(text);
  const wareki = /(昭和|平成|令和)\s*(元|\d{1,2})\s*年\s*(\d{1,2})\s*月/u.exec(t);
  if (wareki) {
    const base = WAREKI_BASE[wareki[1] ?? ''] ?? 0;
    const y = wareki[2] === '元' ? 1 : Number(wareki[2]);
    return { year: base + y, month: Number(wareki[3]) };
  }
  const ymd = /((?:19|20)\d{2})\s*[年/.-]\s*(\d{1,2})/u.exec(t);
  if (ymd) return { year: Number(ymd[1]), month: Number(ymd[2]) };
  const md = /(\d{1,2})\s*月/u.exec(t);
  if (md) return { month: Number(md[1]) };
  return {};
}

export function prefectureOf(text: string): string | undefined {
  const t = normalizeForDetection(text);
  const pref = PREFECTURES.find((p) => t.includes(p));
  if (pref) return pref;
  const city = Object.keys(CITY_PREFECTURE).find((c) => t.includes(c));
  return city ? CITY_PREFECTURE[city] : undefined;
}

const INDUSTRY: [RegExp, string][] = [
  [/銀行|信用金庫|信用組合|証券|生命|損保|保険|海上火災/u, '金融機関'],
  [/大学|高等学校|高校|中学校|小学校|幼稚園|保育園|学校法人/u, '教育機関'],
  [/病院|クリニック|医院|診療所|歯科|薬局|医療法人/u, '医療機関'],
  [/役所|役場|県庁|都庁|府庁/u, '行政機関'],
  [/店|営業所|出張所/u, '店舗'],
  [/工場|倉庫|物流センター|事業所/u, '事業所'],
];

const SENSITIVE_ABSTRACT: Record<SensitiveKind, string> = {
  health: '健康上の事情',
  disability: '身体上の事情',
  family: '家庭の事情',
  finance: '経済的な事情',
  crime: 'トラブル',
  belief: '個人的な信条',
};

const AIDS = /車椅子|車いす|白杖|補聴器|義足|義手|杖/u;

const MANAGER = /長|取締役|役員|マネージャー|リーダー|チーフ|会長|社長|専務|常務/u;

/**
 * 一般化する。事実を足さず、粒度を広げるだけ（FR-12）。
 * 変換できないときは null を返し、呼び出し側でカテゴリラベルに切り替える。
 */
export function generalize(
  text: string,
  category: Category,
  level: GeneralizeLevel,
  sensitiveKind?: SensitiveKind,
): string | null {
  switch (level) {
    case 'year': {
      const { year } = parseYearMonth(text);
      return year ? `${year}年` : null;
    }
    case 'decade': {
      const { year } = parseYearMonth(text);
      return year ? `${Math.floor(year / 10) * 10}年代` : null;
    }
    case 'month': {
      const { year, month } = parseYearMonth(text);
      if (!month) return null;
      return year ? `${year}年${month}月` : `${month}月`;
    }
    case 'ageBand': {
      const m = /(\d{1,3})/u.exec(normalizeForDetection(text));
      if (!m) return /代/u.test(text) ? text : null;
      const age = Number(m[1]);
      return age < 10 ? '10歳未満' : `${Math.floor(age / 10) * 10}代`;
    }
    case 'prefecture':
      return prefectureOf(text) ?? null;
    case 'region': {
      const pref = prefectureOf(text);
      return pref ? (PREFECTURE_REGION[pref] ?? null) : null;
    }
    case 'industry': {
      const hit = INDUSTRY.find(([re]) => re.test(text));
      if (hit) return category === 'store' ? 'ある店舗' : `ある${hit[1]}`;
      if (category === 'store') return 'ある店舗';
      if (category === 'orgName') return 'ある企業';
      return null;
    }
    case 'role':
      if (category === 'position') return MANAGER.test(text) ? '管理職' : '担当者';
      if (category === 'department') return 'ある部署';
      return null;
    case 'abstract':
      if (category === 'sensitive' && sensitiveKind === 'disability' && AIDS.test(text)) return '補助具';
      if (category === 'sensitive' && sensitiveKind) return SENSITIVE_ABSTRACT[sensitiveKind];
      if (category === 'place') return 'ある地域';
      if (category === 'orgName') return 'ある組織';
      if (category === 'store') return 'ある店舗';
      return null;
  }
}
