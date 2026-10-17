import type { Action, ManualOp } from '../../core/model/types';
import { MESSAGES } from '../../core/explain/messages';
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
      <div className="card risk-card">
        <h3>組合せの手がかり</h3>
        <p>加工後に残る組合せの手がかりは少なめです。</p>
        <p className="hint">{MESSAGES.externalNotChecked}</p>
      </div>
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
      {finding.attributes.length > 0 && (
        <details className="risk-attributes">
          <summary>残っている手がかりを見る</summary>
          <ul className="attrs" aria-label="残っている手がかり">
            {[...new Map(finding.attributes.map((a) => [a.text, a])).values()].map((a) => (
              <li key={a.candidateId} className={a.weight < 1 ? 'weak' : ''} title={a.weight < 1 ? '一般化済み（弱い手がかり）' : 'そのまま残っている'}>
                {byId.get(a.candidateId)?.output || a.text}
              </li>
            ))}
          </ul>
        </details>
      )}
      <ul>
        {finding.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {result.riskPlan && (
        <div className="risk-plan">
          <p>
            原因になっている {result.riskPlan.steps.length} か所だけを加工すると、注意度が「{result.riskPlan.levelBefore}」→「{result.riskPlan.levelAfter}」になる見込みです。
          </p>
          <button type="button" className="primary" onClick={() => applyPlan()}>
            対策をまとめて適用（{result.riskPlan.steps.length}件）
          </button>
          <p className="hint">適用後も、項目ごとに戻せます。要約に必要な情報まで消えていないか確認してください。</p>
        </div>
      )}
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
    </div>
  );
}
