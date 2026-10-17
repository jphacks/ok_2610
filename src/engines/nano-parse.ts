import type { Category, Role, Span } from '../core/model/types';
import { TIER } from '../core/model/types';

// Gemini Nano の出力を span にする純粋関数（tests/unit/nano-parse.test.ts で固定）。
// LLM は位置計算が苦手なので、オフセットは答えさせず、抽出語を原文に突き合わせる（ARCHITECTURE.md §5-1）。

export type NanoAnswer = {
  persons: string[];
  organizations: string[];
  places: string[];
  dates: { text: string; role: 'birth' | 'business' | 'sensitive' | 'unknown' }[];
};

export const NANO_SCHEMA = {
  type: 'object',
  properties: {
    persons: { type: 'array', items: { type: 'string' } },
    organizations: { type: 'array', items: { type: 'string' } },
    places: { type: 'array', items: { type: 'string' } },
    dates: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, role: { type: 'string', enum: ['birth', 'business', 'sensitive', 'unknown'] } },
        required: ['text', 'role'],
      },
    },
  },
  required: ['persons', 'organizations', 'places', 'dates'],
} as const;

export const NANO_SYSTEM_PROMPT = [
  'あなたは日本語の文章から情報を抜き出す道具です。説明や前置きは書かず、指定された JSON だけを返します。',
  'persons: 実在の人物の氏名（敬称は含めない）。',
  'organizations: 会社・店舗・学校・病院などの固有の名前。',
  'places: 市区町村・地名などの固有の地名。',
  'dates: 文中の日付と、その役割。role は birth（生年月日）、business（注文日・配達日・期限・会議など業務の日付）、sensitive（受診・入院など健康に関わる日付）、unknown（判断できない）。',
  '文章に書かれている文字列をそのまま抜き出し、言い換えたり補ったりしないでください。',
].join('\n');

const ROLE: Record<NanoAnswer['dates'][number]['role'], Role> = {
  birth: 'birthDate',
  business: 'businessDate',
  sensitive: 'sensitiveDate',
  unknown: 'unknownDate',
};

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** 壊れた JSON や想定外の形は null。前後に余計な文字があっても JSON 部分だけを読む */
export function parseNanoAnswer(raw: string): NanoAnswer | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const dates = Array.isArray(d.dates)
    ? d.dates.filter(
        (x): x is NanoAnswer['dates'][number] =>
          typeof x === 'object' && x !== null && typeof (x as { text?: unknown }).text === 'string' && (x as { role?: unknown }).role !== undefined && (x as { role: string }).role in ROLE,
      )
    : [];
  return {
    persons: isStringArray(d.persons) ? d.persons : [],
    organizations: isStringArray(d.organizations) ? d.organizations : [],
    places: isStringArray(d.places) ? d.places : [],
    dates,
  };
}

function locateAll(text: string, term: string): number[] {
  const out: number[] = [];
  if (!term) return out;
  let from = 0;
  for (;;) {
    const at = text.indexOf(term, from);
    if (at < 0) return out;
    out.push(at);
    from = at + term.length;
  }
}

/** 抽出語を原文に突き合わせて span にする。原文にない語（言い換え・幻覚）は捨てる */
export function answerToSpans(text: string, answer: NanoAnswer, offset = 0): Span[] {
  const spans: Span[] = [];
  const push = (terms: string[], category: Category, minLength: number) => {
    for (const raw of new Set(terms.map((t) => t.trim()))) {
      if (raw.length < minLength) continue;
      for (const at of locateAll(text, raw)) {
        spans.push({
          start: at + offset,
          end: at + raw.length + offset,
          category,
          source: 'nano',
          certainty: '推定',
          evidence: [{ kind: 'model', detail: 'AIが文脈から推定（未検証）' }],
          tier: TIER.nano,
        });
      }
    }
  };
  push(answer.persons, 'personName', 2);
  push(answer.organizations, 'orgName', 2);
  push(answer.places, 'place', 2);
  for (const d of answer.dates) {
    for (const at of locateAll(text, d.text.trim())) {
      spans.push({
        start: at + offset,
        end: at + d.text.trim().length + offset,
        category: 'date',
        source: 'nano',
        certainty: '推定',
        evidence: [{ kind: 'model', detail: 'AIが日付の役割を推定（未検証）' }],
        tier: TIER.nano,
        role: ROLE[d.role],
      });
    }
  }
  return spans;
}
