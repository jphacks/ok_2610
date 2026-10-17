import { categoryLabel } from './model/categories';
import type { Candidate, CustomTerm, RecheckFinding } from './model/types';
import { detectTerms } from './detect/dictionary';
import { comparisonKey } from './detect/normalize';
import { detectRules } from './detect/rules';
import { TIER } from './model/types';

export type RecheckInput = {
  masked: string;
  candidates: Candidate[];
  outputs: Map<string, string>;
  generatedLabels: string[];
  orgTerms: CustomTerm[];
  customTerms: CustomTerm[];
};

/**
 * 加工後の文章を再検査する（FR-21）。
 * - 隠したはずの原文が残っていないか
 * - 手で入れた置換語に新しい氏名や秘密情報がないか
 * - 生成したラベルと同じ文字列が原文由来で紛れていないか
 */
export function recheck({ masked, candidates, outputs, generatedLabels, orgTerms, customTerms }: RecheckInput): RecheckFinding[] {
  const findings: RecheckFinding[] = [];
  const maskedKey = comparisonKey(masked);

  // 1. 原文の残存。隠した語が、別の箇所で残っていないか（2文字以上の語だけ）
  const hidden = candidates.filter((c) => c.action.kind !== 'keep' && comparisonKey(c.text).length >= 2);
  const reported = new Set<string>();
  for (const c of hidden) {
    const key = comparisonKey(c.text);
    if (reported.has(key)) continue;
    const out = outputs.get(c.id) ?? '';
    if (comparisonKey(out).includes(key)) continue;
    if (maskedKey.includes(key)) {
      reported.add(key);
      findings.push({
        kind: 'residual',
        text: c.text,
        category: c.categories[0],
        message: `隠したはずの「${c.text}」が、加工後の文章の別の場所に残っています。`,
        blocking: c.categories.includes('credential'),
      });
    }
  }

  // 2. 新しい検出。意図して残したもの・生成したラベルは除く
  const keptKeys = new Set(candidates.filter((c) => c.action.kind === 'keep').map((c) => comparisonKey(c.text)));
  // 利用者が手で入れた置換語は「生成した文字列」に含めない（そこに氏名などを入れていないかを見るため）
  const automatic = candidates.filter((c) => !(c.manual && c.action.kind === 'replace')).map((c) => outputs.get(c.id) ?? '');
  const generated = new Set([...generatedLabels, ...automatic].map(comparisonKey));
  const fresh = [
    ...detectRules(masked),
    ...detectTerms(masked, orgTerms, 'orgTerm', TIER.orgDictionary),
    ...detectTerms(masked, customTerms, 'custom', TIER.customDictionary),
  ];
  const seen = new Set<string>();
  for (const s of fresh) {
    const text = masked.slice(s.start, s.end);
    const key = comparisonKey(text);
    if (keptKeys.has(key) || generated.has(key) || seen.has(key)) continue;
    if ([...generated].some((g) => g.length > 0 && (g.includes(key) || key.includes(g)))) continue;
    // 準識別子は組合せ評価で扱うので、ここでは直接識別子・秘密・辞書語だけを見る
    if (!['personName', 'phone', 'email', 'credential', 'creditCard', 'myNumber', 'idNumber', 'bankAccount', 'orgTerm', 'custom', 'address', 'url'].includes(s.category)) continue;
    seen.add(key);
    findings.push({
      kind: 'newDetection',
      text,
      category: s.category,
      message: `加工後の文章に新しい${categoryLabel(s.category)}「${text}」が見つかりました。置換語を確認してください。`,
      blocking: s.category === 'credential' || s.category === 'orgTerm',
    });
  }

  // 3. ラベル衝突。生成したラベルが、加工後の文章に想定より多く現れていないか
  for (const label of new Set(generatedLabels)) {
    const expected = [...outputs.values()].filter((o) => o === label).length;
    const actual = masked.split(label).length - 1;
    if (actual > expected) {
      findings.push({
        kind: 'labelCollision',
        text: label,
        message: `ラベル「${label}」と同じ文字列が原文にも含まれています。復元時に取り違えるおそれがあります。`,
        blocking: false,
      });
    }
  }
  return findings;
}
