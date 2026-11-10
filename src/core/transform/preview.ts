import { CATEGORY_INFO, categoryLabel, primaryCategory } from '../model/categories';
import type { Action, Candidate, Category, GeneralizeLevel } from '../model/types';
import { generalize } from './generalize';
import { partialMask } from './render';

// 項目ごとに選べる処理と、その処理にしたときの仕上がりの文字（DetailPanel の選択肢に見本として出す）。
// その語に効かない処理（数字のない語の年代化など）は null を返し、選択肢に出さない。

/** 一部だけ隠す意味がある、番号や連絡先のような種類 */
const PARTIAL_MASKABLE: Category[] = ['phone', 'email', 'myNumber', 'idNumber', 'creditCard', 'bankAccount', 'orderNumber', 'customerId', 'postalCode', 'ipAddress', 'accountName', 'url'];

/**
 * 一般化の段ごとに、意味のある種類。generalize() は文字の形だけで変換するので、
 * これで絞らないと「1958年4月12日」の年齢帯が「190代」のような意味のない見本になる
 */
const GENERALIZE_FOR: Record<GeneralizeLevel, Category[]> = {
  year: ['date'],
  decade: ['date'],
  month: ['date'],
  ageBand: ['age'],
  prefecture: ['address', 'place'],
  region: ['address', 'place'],
  industry: ['orgName', 'store'],
  role: ['position', 'department'],
  abstract: ['sensitive', 'place', 'orgName', 'store'],
};

/**
 * 処理 action を候補 c に当てたときの仕上がり。削除は空文字。使えない処理は null。
 * 仮の名前・ラベルの番号は今の加工結果から借りる（実際の採番は解析し直したときに決まる）。
 */
export function previewAction(c: Candidate, action: Action, entityLabel?: string): string | null {
  const category = primaryCategory(c.categories);
  const info = CATEGORY_INFO[category];
  switch (action.kind) {
    case 'keep':
      return c.text;
    case 'delete':
      return '';
    case 'replace':
      return action.text;
    case 'pseudonym':
      if (entityLabel) return entityLabel;
      if (c.action.kind === 'pseudonym' && c.output) return c.output;
      return info.pseudonymPrefix ? `${info.pseudonymPrefix}A` : null;
    case 'categoryLabel':
      return c.action.kind === 'categoryLabel' && c.output ? c.output : `[${categoryLabel(category)}1]`;
    case 'partialMask':
      return PARTIAL_MASKABLE.includes(category) ? partialMask(c.text, action.visible) : null;
    case 'generalize': {
      // 今かかっている一般化は、種類の判定と違っていても選ばれた状態で見せる
      const current = c.action.kind === 'generalize' && c.action.level === action.level;
      if (!current && !GENERALIZE_FOR[action.level].includes(category)) return null;
      const g = generalize(c.text, category, action.level, c.sensitiveKind);
      return g === null || g === c.text ? null : g;
    }
  }
}
