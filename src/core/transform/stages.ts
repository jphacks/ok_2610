import type { Action, Category, KeepFlags, Purpose, Role, Stage } from '../model/types';

type StageRow = Record<Stage, Action>;

const keep: Action = { kind: 'keep' };
const del: Action = { kind: 'delete' };
const label: Action = { kind: 'categoryLabel' };
const pseudo: Action = { kind: 'pseudonym' };
const gen = (level: Extract<Action, { kind: 'generalize' }>['level']): Action => ({ kind: 'generalize', level });

const row = (a: Action, b: Action, c: Action): StageRow => ({ A: a, B: b, C: c });

// 識別子は C でも削除せずラベルにする（削除すると「注文番号：」だけが残り文が崩れるため）
const IDENTIFIER = row(label, label, label);

/**
 * 段階×種別の初期案（ARCHITECTURE.md §6-1。D-02 で確定）。
 * 段階は検出対象を狭めず、処理方針だけを変える。A→C で表に出る情報は増えない。
 */
const MATRIX: Record<Exclude<Category, 'date'>, StageRow> = {
  personName: row(pseudo, pseudo, pseudo),
  accountName: IDENTIFIER,
  address: row(gen('prefecture'), gen('region'), del),
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
  orgName: row(keep, gen('industry'), gen('abstract')),
  store: row(keep, gen('industry'), gen('industry')),
  place: row(gen('prefecture'), gen('region'), gen('abstract')),
  age: row(keep, gen('ageBand'), gen('ageBand')),
  gender: row(keep, keep, del),
  department: row(keep, gen('role'), del),
  position: row(keep, gen('role'), del),
  rareTrait: row(keep, keep, del),
  sensitive: row(keep, keep, gen('abstract')),
  credential: row(del, del, del),
  confidential: row(keep, keep, label),
  custom: row(label, label, label),
  orgTerm: row(label, label, label),
};

const DATE_MATRIX: Record<Role, StageRow> = {
  birthDate: row(gen('year'), gen('decade'), del),
  businessDate: row(keep, keep, gen('month')),
  sensitiveDate: row(gen('month'), gen('month'), del),
  unknownDate: row(keep, gen('month'), gen('month')),
  example: row(keep, gen('month'), gen('month')),
  quote: row(keep, gen('month'), gen('month')),
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

const STAGE_ORDER: Stage[] = ['A', 'B', 'C'];

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
  const { stage, keepFlags, purpose, role, hasPrefecture } = input;
  if (category === 'date') {
    const r = role ?? 'unknownDate';
    // 用途で日付を残したいときは、業務日を B でも残す（C は月単位）
    if (r === 'businessDate' && !keepFlags.dates && stage === 'B') return gen('month');
    return DATE_MATRIX[r][stage];
  }
  if ((category === 'place' || category === 'address') && !hasPrefecture) {
    if (category === 'address') return stage === 'C' ? del : label;
    return stage === 'A' ? keep : stage === 'B' ? pseudo : gen('abstract');
  }
  if (category === 'orgName' && keepFlags.organizations && stage !== 'C') return stage === 'A' ? keep : pseudo;
  if (category === 'confidential' && !keepFlags.amounts && stage === 'B') return label;
  // 分類の用途なら、人物の区別より種別が分かれば足りる
  if (category === 'personName' && purpose === 'classify' && stage === 'C') return label;
  return MATRIX[category][stage];
}

/** 推奨処理を決める。複数分類なら最も強い処理を採る */
export function decideAction(input: DecideInput): Action {
  if (input.forcedText !== undefined) return { kind: 'replace', text: input.forcedText };
  return strongest(input.categories.map((c) => decideOne(c, input)));
}
