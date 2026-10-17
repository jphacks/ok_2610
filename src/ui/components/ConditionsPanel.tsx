import { QUESTIONS, type Answer } from '../../core/conditions';
import { MESSAGES } from '../../core/explain/messages';
import { useStore } from '../store';

const ANSWER_LABEL: Record<Answer, string> = { yes: 'はい', no: 'いいえ', unknown: '分からない' };

/** 利用条件の確認（FR-16, UC-02）。回答は自己申告。「不明」を許可に変えない */
export function ConditionsPanel() {
  const answers = useStore((s) => s.answers);
  const setAnswer = useStore((s) => s.setAnswer);
  const conditions = useStore((s) => s.conditions);
  const policy = useStore((s) => s.result?.policy);

  const status =
    conditions.status === 'restricted'
      ? { tone: 'danger', text: '制約がある可能性があります。送信を控え、確認してください。' }
      : conditions.status === 'unknown'
        ? { tone: 'warn', text: `${MESSAGES.unresolved}。確認できるまで送信を控えることをおすすめします。` }
        : conditions.status === 'selfDeclaredOk'
          ? { tone: 'info', text: `回答した範囲では制約は見当たりません（${MESSAGES.selfDeclared}。許可を示すものではありません）。` }
          : { tone: 'muted', text: 'まだ回答していません。' };

  return (
    <section className="panel" aria-labelledby="cond-title">
      <details open={conditions.status === 'restricted' || conditions.status === 'unknown'}>
        <summary>
          <h2 id="cond-title">3. 利用条件の確認</h2>
        </summary>
        <p className="hint">ツールは利用の可否を判定しません。分からない項目は確認先を一覧にします。</p>
        {QUESTIONS.map((q) => (
          <fieldset key={q.id} className="question">
            <legend>{q.text}</legend>
            <div className="segmented small" role="radiogroup">
              {(['yes', 'no', 'unknown'] as Answer[]).map((a) => (
                <button key={a} type="button" role="radio" aria-checked={answers[q.id] === a} className={answers[q.id] === a ? 'on' : ''} onClick={() => setAnswer(q.id, a)}>
                  {ANSWER_LABEL[a]}
                </button>
              ))}
            </div>
          </fieldset>
        ))}
        <div className={`callout ${status.tone}`} role="status">
          <p>{status.text}</p>
          {conditions.consult.length > 0 && (
            <>
              <strong>確認すること</strong>
              <ul>
                {conditions.consult.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              {policy?.status === 'active' && policy.contact && <p>相談先: {policy.contact}</p>}
            </>
          )}
        </div>
      </details>
    </section>
  );
}
