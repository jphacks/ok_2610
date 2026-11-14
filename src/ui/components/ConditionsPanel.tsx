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
  const left = QUESTIONS.filter((q) => !answers[q.id]).length;

  const chip =
    conditions.status === 'unanswered'
      ? { tone: 'muted', text: left === QUESTIONS.length ? '未回答' : `未回答 あと${left}問` }
      : conditions.status === 'selfDeclaredOk'
        ? { tone: 'info', text: '回答済み' }
        : { tone: conditions.status === 'restricted' ? 'danger' : 'warn', text: '要確認' };

  const status =
    conditions.status === 'restricted'
      ? { tone: 'danger', text: '制約がある可能性があります。送信を控え、下の項目を確認してください。' }
      : conditions.status === 'unknown'
        ? { tone: 'warn', text: `${MESSAGES.unresolved}。確認できるまで送信を控えてください。` }
        : conditions.status === 'selfDeclaredOk'
          ? { tone: 'info', text: `回答した範囲では制約は見当たりません（${MESSAGES.selfDeclared}。許可を示すものではありません）。` }
          : null;

  return (
    <section className="panel conditions-panel" aria-labelledby="cond-title">
      <div className="settings-group-head">
        <h3 id="cond-title" className="settings-group-title">利用条件の確認</h3>
        <span className={`chip chip-${chip.tone}`}>{chip.text}</span>
      </div>
      <p className="hint">回答は自己申告です。このツールは利用の可否を判定しません。</p>
      {QUESTIONS.map((q, i) => (
        <fieldset key={q.id} className="question">
          <legend id={`q-${q.id}`}><span className="q-num" aria-hidden="true">{i + 1}</span>{q.text}</legend>
          <div className="segmented small" role="radiogroup" aria-labelledby={`q-${q.id}`}>
            {(['yes', 'no', 'unknown'] as Answer[]).map((a) => (
              <button key={a} type="button" role="radio" aria-checked={answers[q.id] === a} className={answers[q.id] === a ? 'on' : ''} onClick={() => setAnswer(q.id, a)}>
                {ANSWER_LABEL[a]}
              </button>
            ))}
          </div>
        </fieldset>
      ))}
      {status && (
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
      )}
    </section>
  );
}
