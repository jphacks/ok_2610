import type { Action, ManualOp } from '../../core/model/types';
import { RISK_TONE } from '../labels';
import { useStore } from '../store';

/** 組合せリスク（FR-08〜10）。確率は出さず、根拠と追加加工の提案を示す */
export function RiskPanel() {
  const result = useStore((s) => s.result);
  const addOps = useStore((s) => s.addOps);
  if (!result || !result.text.trim()) return null;
  const finding = result.risks[0];
  const byId = new Map(result.candidates.map((c) => [c.id, c]));

  if (!finding) {
    return (
      <p className="risk-quiet">組合せの手がかりは少なめです。</p>
    );
  }

  function apply(candidateIds: string[], action: Action) {
    const ops: ManualOp[] = candidateIds.flatMap((id) => {
      const c = byId.get(id);
      return c ? [{ kind: 'setAction' as const, start: c.start, end: c.end, action }] : [];
    });
    addOps(ops);
  }

  /** 対策をまとめて1回の操作として適用する（元に戻すときも、まとめて戻る） */
  function applyPlan() {
    if (!result?.riskPlan) return;
    const ops: ManualOp[] = result.riskPlan.steps.flatMap((step) =>
      step.candidateIds.flatMap((id) => {
        const c = byId.get(id);
        return c ? [{ kind: 'setAction' as const, start: c.start, end: c.end, action: step.action }] : [];
      }),
    );
    addOps(ops);
  }

  return (
    <div className={`card risk-card tone-${RISK_TONE[finding.level]}`}>
      <h3>
        組合せの手がかり: <span className="level">{finding.level}</span>
      </h3>
      {result.riskPlan && (
        <div className="risk-plan">
          <p>
            追加加工で「{result.riskPlan.levelAfter}」になる見込みです。
          </p>
          <button type="button" className="risk-action" onClick={() => applyPlan()}>
            対策をまとめて適用（{result.riskPlan.steps.length}件）
          </button>
        </div>
      )}
      <details className="risk-details"><summary>理由と個別の対策</summary>
        {finding.attributes.length > 0 && (
          <div className="risk-attributes">
            <h4>残っている手がかり</h4>
            <ul className="attrs" aria-label="残っている手がかり">
              {[...new Map(finding.attributes.map((a) => [a.text, a])).values()].map((a) => (
                <li key={a.candidateId} className={a.weight < 1 ? 'weak' : ''} title={a.weight < 1 ? '一般化済み（弱い手がかり）' : 'そのまま残っている'}>
                  {byId.get(a.candidateId)?.output || a.text}
                </li>
              ))}
            </ul>
          </div>
        )}
        <ul>
          {finding.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        {finding.suggestions.length > 0 && (
          <>
            <h4>効果の大きい追加加工</h4>
            <ul className="suggestions">
              {finding.suggestions.map((s) => (
                <li key={s.candidateIds.join(',')}>
                  <span>{s.effect}</span>
                  <button type="button" onClick={() => apply(s.candidateIds, s.action)}>
                    適用
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </details>
    </div>
  );
}
