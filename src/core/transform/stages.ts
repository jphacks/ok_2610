import type { Action, Category, KeepFlags, Purpose, Role, Stage } from '../model/types';

type StageRow = Record<Stage, Action>;

const keep: Action = { kind: 'keep' };
const del: Action = { kind: 'delete' };
const label: Action = { kind: 'categoryLabel' };
const pseudo: Action = { kind: 'pseudonym' };
const gen = (level: Extract<Action, { kind: 'generalize' }>['level']): Action => ({ kind: 'generalize', level });

const row = (a: Action, b: Action): StageRow => ({ A: a, B: b });

const IDENTIFIER = row(label, label);

/**
 * 段階×種別の初期案（ARCHITECTURE.md §6-1。D-02 で確定）。
 * 段階は検出対象を狭めず、処理方針だけを変える。A→B で表に出る情報は増えない。
 * 段階 C（一律に削除・抽象化）は廃止した。残るリスクへの対策は、組合せ評価の提案
 * （原因になっている項目だけを加工する）で行う（§7）。
 */
const MATRIX: Record<Exclude<Category, 'date'>, StageRow> = {
  personName: row(pseudo, pseudo),
  accountName: IDENTIFIER,
  address: row(gen('prefecture'), gen('region')),
  postalCode: IDENTIFIER,
  phone: IDENTIFIER,
  email: IDENTIFIER,
  url: IDENTIFIER,
  ipAddress: IDENTIFIER,
  myNumber: IDENTIFIER,
  idNumber: IDENTIFIER,
  creditCard: IDENTIFIER,
  bankAccount: IDENTIFIER,
  orderNumber: IDENTIFIER,
  customerId: IDENTIFIER,
  orgName: row(keep, gen('industry')),
  store: row(keep, gen('industry')),
  place: row(gen('prefecture'), gen('region')),
  age: row(keep, gen('ageBand')),
  gender: row(keep, keep),
  department: row(keep, gen('role')),
  position: row(keep, gen('role')),
  rareTrait: row(keep, keep),
  sensitive: row(keep, keep),
  credential: row(del, del),
  confidential: row(keep, keep),
  custom: row(label, label),
  orgTerm: row(label, label),
};

const DATE_MATRIX: Record<Role, StageRow> = {
  birthDate: row(gen('year'), gen('decade')),
  businessDate: row(keep, keep),
  sensitiveDate: row(gen('month'), gen('month')),
  unknownDate: row(keep, gen('month')),
  example: row(keep, gen('month')),
  quote: row(keep, gen('month')),
};

/** 処理の強さ。数が大きいほど原文の情報を多く隠す */
export function actionStrength(action: Action): number {
  switch (action.kind) {
    case 'keep':
      return 0;
    case 'partialMask':
      return 1;
    case 'generalize':
      return 2;
    case 'replace':
      return 3;
    case 'pseudonym':
    case 'categoryLabel':
      return 4;
    case 'delete':
      return 5;
  }
}

export function strongest(actions: Action[]): Action {
  return actions.reduce((a, b) => (actionStrength(b) > actionStrength(a) ? b : a), keep);
}

const STAGE_ORDER: Stage[] = ['A', 'B'];

export function maxStage(a: Stage, b: Stage): Stage {
  return STAGE_ORDER.indexOf(a) >= STAGE_ORDER.indexOf(b) ? a : b;
}

export type DecideInput = {
  categories: Category[];
  role?: Role;
  forcedText?: string;
  stage: Stage;
  purpose: Purpose;
  keepFlags: KeepFlags;
  /** 都道府県が判定できるか（できなければ一般化の代わりに別の処理を選ぶ） */
  hasPrefecture: boolean;
};

function decideOne(category: Category, input: DecideInput): Action {
  const { stage, keepFlags, role, hasPrefecture } = input;
  if (category === 'date') {
    const r = role ?? 'unknownDate';
    // 用途で日付を残さない設定なら、業務日も B では月単位にする
    if (r === 'businessDate' && !keepFlags.dates && stage === 'B') return gen('month');
    return DATE_MATRIX[r][stage];
  }
  if ((category === 'place' || category === 'address') && !hasPrefecture) {
    if (category === 'address') return label;
    return stage === 'A' ? keep : pseudo;
  }
  if (category === 'orgName' && keepFlags.organizations) return stage === 'A' ? keep : pseudo;
  if (category === 'confidential' && !keepFlags.amounts && stage === 'B') return label;
  return MATRIX[category][stage];
}

/** 推奨処理を決める。複数分類なら最も強い処理を採る */
export function decideAction(input: DecideInput): Action {
  if (input.forcedText !== undefined) return { kind: 'replace', text: input.forcedText };
  return strongest(input.categories.map((c) => decideOne(c, input)));
}
