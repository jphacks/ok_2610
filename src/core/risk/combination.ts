import { CATEGORY_INFO } from '../model/categories';
import type { Action, Candidate, QuasiType, RiskFinding, RiskLevel, RiskSuggestion } from '../model/types';
import { comparisonKey } from '../detect/normalize';
import { actionStrength } from '../transform/stages';

const QUASI_NAME: Record<QuasiType, string> = {
  residence: '居住地域',
  organization: '勤務先・組織',
  store: '店舗・拠点',
  time: '出来事の時期',
  age: '年齢・生年',
  gender: '性別',
  department: '部署',
  position: '役職',
  trait: '身体や健康の特徴',
  rare: '絞り込める表現',
};

const GENERALIZE_WEIGHT: Record<string, number> = {
  year: 0.5,
  decade: 0.3,
  month: 0.5,
  ageBand: 0.5,
  prefecture: 0.5,
  region: 0.3,
  industry: 0.3,
  role: 0.3,
  abstract: 0.2,
};

/** 加工後に、その属性がどれだけ手がかりとして残るか（1 = そのまま残る） */
export function residualWeight(action: Action): number {
  switch (action.kind) {
    case 'keep':
      return 1;
    case 'partialMask':
      return 0.5;
    case 'generalize':
      return GENERALIZE_WEIGHT[action.level] ?? 0.5;
    case 'pseudonym':
    case 'replace':
      return 0.2;
    case 'categoryLabel':
    case 'delete':
      return 0;
  }
}

function quasiTypeOf(c: Candidate): QuasiType | undefined {
  if (c.categories.includes('date')) {
    if (c.role === 'birthDate') return 'age';
    return 'time';
  }
  for (const cat of c.categories) {
    const q = CATEGORY_INFO[cat].quasi;
    if (q) return q;
  }
  return undefined;
}

/** 一段強い処理。提案に使う */
function strongerAction(c: Candidate): Action | null {
  const current = c.action;
  const ladder: Action[] = c.categories.includes('date')
    ? [{ kind: 'generalize', level: 'month' }, { kind: 'delete' }]
    : c.categories.includes('place') || c.categories.includes('address')
      ? [{ kind: 'generalize', level: 'prefecture' }, { kind: 'generalize', level: 'region' }, { kind: 'delete' }]
      : c.categories.includes('age')
        ? [{ kind: 'generalize', level: 'ageBand' }, { kind: 'delete' }]
        : c.categories.includes('orgName') || c.categories.includes('store')
          ? [{ kind: 'generalize', level: 'industry' }, { kind: 'delete' }]
          : c.categories.includes('sensitive')
            ? [{ kind: 'generalize', level: 'abstract' }, { kind: 'delete' }]
            : [{ kind: 'delete' }];
  const w = residualWeight(current);
  return ladder.find((a) => residualWeight(a) < w && actionStrength(a) >= actionStrength(current)) ?? null;
}

type Attr = { type: QuasiType; candidate: Candidate; weight: number };

function score(attrs: Attr[]): { effective: number; rare: boolean } {
  const byType = new Map<QuasiType, number>();
  for (const a of attrs) byType.set(a.type, Math.max(byType.get(a.type) ?? 0, a.weight));
  let effective = 0;
  for (const [type, w] of byType) if (type !== 'rare') effective += w;
  const rare = (byType.get('rare') ?? 0) >= 0.5;
  return { effective: Math.round(effective * 10) / 10, rare };
}

function levelOf(effective: number, rare: boolean): RiskLevel {
  if (effective >= 3 || (rare && effective >= 2)) return '要注意';
  if (effective >= 2 || (rare && effective >= 1)) return '注意';
  return '情報';
}

function actionLabel(a: Action): string {
  switch (a.kind) {
    case 'delete':
      return '削除する';
    case 'generalize':
      return { year: '年だけにする', decade: '年代にする', month: '月単位にする', ageBand: '年齢帯にする', prefecture: '都道府県まで広げる', region: '地方まで広げる', industry: '業種にする', role: '役割名にする', abstract: '抽象化する' }[a.level];
    default:
      return '加工';
  }
}

export type RiskInput = {
  candidates: Candidate[];
  /** 評価に必要な解析が失敗したか（失敗なら「評価不能」。低リスクにしない） */
  analysisFailed: boolean;
};

/**
 * 組合せリスクを評価する（FR-08〜10）。規則ベースで決定的。
 * 確率は出さず、根拠（どの属性が残っているか）と、効果の大きい追加加工を示す。
 */
export function evaluateCombination({ candidates, analysisFailed }: RiskInput): RiskFinding[] {
  if (analysisFailed) {
    return [
      {
        level: '評価不能',
        scope: -1,
        attributes: [],
        reasons: ['検出の一部が失敗したため、組合せを評価できませんでした。低リスクという意味ではありません。'],
        suggestions: [],
      },
    ];
  }

  const attrs: Attr[] = [];
  for (const c of candidates) {
    const type = quasiTypeOf(c);
    if (!type) continue;
    const weight = residualWeight(c.action);
    if (weight > 0) attrs.push({ type, candidate: c, weight });
  }
  const { effective, rare } = score(attrs);
  const level = levelOf(effective, rare);
  if (level === '情報') return [];

  const types = [...new Set(attrs.map((a) => a.type))];
  const reasons = [
    `次の手がかりが加工後も残っています: ${types.map((t) => QUASI_NAME[t]).join('、')}。`,
    rare
      ? '「唯一の」「いつも同じ」のような表現があると、少ない手がかりでも人物を絞り込めます。'
      : 'これらが同時に分かると、該当する人を絞り込める場合があります。',
    '外部の公開情報や、連携先が持つ情報との照合はしていません。',
  ];

  // 同じ語は全出現をまとめて試す。絞り込める表現（rare）は種類ごとまとめる
  const groups = new Map<string, Attr[]>();
  for (const a of attrs) {
    const key = a.type === 'rare' ? 'rare' : `${a.type}|${comparisonKey(a.candidate.text)}`;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  const ranked: { suggestion: RiskSuggestion; drop: number }[] = [];
  for (const group of groups.values()) {
    const first = group[0];
    if (!first) continue;
    const next = strongerAction(first.candidate);
    if (!next) continue;
    const trial = attrs.map((x) => (group.includes(x) ? { ...x, weight: residualWeight(next) } : x)).filter((x) => x.weight > 0);
    const after = score(trial);
    const drop = effective - after.effective + (rare && !after.rare ? 1 : 0);
    if (drop <= 0) continue;
    const texts = [...new Set(group.map((g) => `「${g.candidate.text}」`))].join('');
    ranked.push({
      drop,
      suggestion: {
        candidateIds: group.map((g) => g.candidate.id),
        action: next,
        effect:
          after.effective < effective
            ? `${texts}を${actionLabel(next)}と、手がかりの量が ${effective} → ${after.effective} に減ります${rare && !after.rare ? '（絞り込める表現もなくなります）' : ''}。`
            : `${texts}を${actionLabel(next)}と、少ない手がかりで人物を絞り込める表現がなくなります。`,
      },
    });
  }
  ranked.sort((x, y) => y.drop - x.drop);

  return [
    {
      level,
      scope: -1,
      attributes: attrs.map((a) => ({ type: a.type, candidateId: a.candidate.id, text: a.candidate.text, weight: a.weight })),
      reasons,
      suggestions: ranked.slice(0, 3).map((r) => r.suggestion),
    },
  ];
}

export function riskRank(level: RiskLevel | 'なし'): number {
  return { なし: 0, 情報: 0, 注意: 1, 要注意: 2, 評価不能: 3 }[level];
}
