import type { Purpose, Stage } from '../../core/model/types';
import { startNanoDownload } from '../../engines/nano';
import { clearCustomDictionary } from '../../infra/storage';
import { PURPOSE_LABEL, STAGE_EXAMPLES, STAGE_INFO, STAGES } from '../labels';
import { useStore } from '../store';

/**
 * 残したい情報。どれも段階 B でだけ効く（src/core/transform/stages.ts の decideOne）ので、B のときだけ出す。
 * 「人物の関係」は処理のどこからも参照されていないため、選択肢から外した（保存値はそのまま）。
 */
const KEEP_OPTIONS = [
  { key: 'dates', label: '業務の日付' },
  { key: 'amounts', label: '金額' },
  { key: 'organizations', label: '組織の区別' },
] as const;

const NANO_STATUS: Record<string, string> = {
  available: '利用できます',
  downloadable: 'モデルの取得が必要です',
  downloading: '取得中です',
  unsupported: 'このブラウザでは使えません',
  unavailable: 'この端末では使えません',
};

/** 加工の設定。大事な順に「隠す強さ → 残したい情報 → AIに頼む作業」、細かい設定は「詳しい設定」に畳む */
export function SettingsPanel() {
  const prefs = useStore((s) => s.prefs);
  const setPrefs = useStore((s) => s.setPrefs);
  const result = useStore((s) => s.result);
  const nerStatus = useStore((s) => s.nerStatus);
  const nanoStatus = useStore((s) => s.nanoStatus);
  const nanoProgress = useStore((s) => s.nanoProgress);
  const policyMin = result?.policy.status === 'active' ? (result.policy.minStage as Stage) : null;
  const rec = result?.recommendation;

  function onDownloadNano() {
    // ユーザー操作の有効期限を切らさないよう、await を挟まずに取得を始める
    const { setNanoProgress, setNanoStatus } = useStore.getState();
    setNanoProgress(0);
    void startNanoDownload((r) => setNanoProgress(r)).then((ok) => {
      setNanoProgress(null);
      setNanoStatus(ok ? 'available' : 'unavailable');
    });
  }

  const cell = (from: string, to: string) => (to === from ? <span className="ex-same">そのまま</span> : to);

  return (
    <section className="panel settings-panel" aria-labelledby="settings-title">
      <h3 id="settings-title" className="settings-group-title">加工の設定</h3>

      <fieldset className="field">
        <legend>隠す強さ</legend>
        <div className="stage-cards" role="radiogroup" aria-label="隠す強さ">
          {STAGES.map((s) => {
            const blocked = policyMin === 'B' && s === 'A';
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={prefs.stage === s}
                aria-label={STAGE_INFO[s].name}
                aria-describedby={`stage-note-${s}`}
                className={`stage-card${prefs.stage === s ? ' on' : ''}`}
                disabled={blocked}
                onClick={() => setPrefs({ stage: s })}
              >
                <span className="stage-card-mark" aria-hidden="true" />
                <span className="stage-card-letter" aria-hidden="true">{s}</span>
                <span className="stage-card-body">
                  <span className="stage-card-name">
                    {STAGE_INFO[s].name.slice(2)}
                    {rec?.stage === s && <span className="chip chip-info">おすすめ</span>}
                  </span>
                  <span id={`stage-note-${s}`} className="stage-card-note">{STAGE_INFO[s].note}</span>
                </span>
              </button>
            );
          })}
        </div>
        {policyMin && policyMin !== 'A' && <p className="hint">組織ポリシーにより、段階 {policyMin} より弱い加工は適用されません。</p>}

        <table className="stage-examples">
          <caption>加工の例</caption>
          <thead>
            <tr>
              <th scope="col">元の語</th>
              {STAGES.map((s) => (
                <th key={s} scope="col" className={prefs.stage === s ? 'on' : ''}>{s}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {STAGE_EXAMPLES.map((ex) => (
              <tr key={ex.from}>
                <th scope="row">{ex.from}</th>
                <td className={prefs.stage === 'A' ? 'on' : ''}>{cell(ex.from, ex.A)}</td>
                <td className={prefs.stage === 'B' ? 'on' : ''}>{cell(ex.from, prefs.keep.organizations && ex.orgB ? ex.orgB : ex.B)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {rec && rec.stage !== prefs.stage && (
          <div className="callout settings-rec" role="status">
            <p><strong>この文章には {rec.stage} がおすすめです</strong></p>
            <details className="more">
              <summary>詳しく</summary>
              <ul>{rec.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
              <p>切り替えるかどうかはご自身で判断してください。</p>
            </details>
          </div>
        )}
      </fieldset>

      {prefs.stage === 'B' && (
        <fieldset className="field">
          <legend>B でもぼかさずに残す情報</legend>
          <div className="checks">
            {KEEP_OPTIONS.map(({ key, label }) => (
              <label key={key}>
                <input type="checkbox" checked={prefs.keep[key]} onChange={(e) => setPrefs({ keep: { ...prefs.keep, [key]: e.target.checked } })} />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="field">
        <label>
          <span className="field-label">AIに頼む作業</span>
          <select value={prefs.purpose} onChange={(e) => setPrefs({ purpose: e.target.value as Purpose })} aria-describedby="purpose-hint">
            {(Object.keys(PURPOSE_LABEL) as Purpose[]).map((p) => (
              <option key={p} value={p}>
                {PURPOSE_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <p id="purpose-hint" className="hint">表示と記録のための項目です。加工の結果は変わりません。</p>
      </div>

      <details className="settings-advanced">
        <summary>詳しい設定（検出の方法・カスタム辞書）</summary>

        <h4>検出の方法</h4>
        <p className="hint">メール・電話・番号などは常に規則で探します。</p>
        <label className="check-line">
          <input type="checkbox" checked={prefs.useNer} onChange={(e) => setPrefs({ useNer: e.target.checked })} />
          <span>
            敬称のない人名・組織名・地名も探す（NER）
            <small className="engine-status">{nerStatus ? (nerStatus.ok ? '利用できます' : nerStatus.reason) : '確認中'}</small>
          </span>
        </label>
        <label className="check-line">
          <input type="checkbox" checked={prefs.useNano} disabled={nanoStatus !== 'available'} onChange={(e) => setPrefs({ useNano: e.target.checked })} />
          <span>
            文脈をAIで補助判定する（Gemini Nano）
            <small className="engine-status">{(nanoStatus && NANO_STATUS[nanoStatus]) ?? '確認中'}</small>
          </span>
        </label>
        {nanoStatus === 'downloadable' && (
          <div className="row">
            <button type="button" onClick={onDownloadNano} disabled={nanoProgress !== null}>
              {nanoProgress !== null ? `取得中 ${Math.round(nanoProgress * 100)}%` : 'Gemini Nano を取得する'}
            </button>
            <p className="hint">モデル（数GB）を取得します。文章は送信されません。</p>
          </div>
        )}
        <p className="hint">選んだ方法が使えないときは、出力を止めます。</p>

        <h4>カスタム辞書</h4>
        <label className="field">
          <span>必ず隠す語（1行に1語）</span>
          <textarea rows={3} value={prefs.customText} onChange={(e) => setPrefs({ customText: e.target.value })} placeholder={'取引先A社\n山田太郎=>担当者'} aria-describedby="dict-hint" />
        </label>
        <p id="dict-hint" className="hint">「語=&gt;置換語」で置き換え後の語も指定できます。</p>
        <p className="hint warn">
          このブラウザに保存されます。実名を含む場合は、使い終えたら削除してください。
          {prefs.customText !== '' && (
            <button type="button" className="link" onClick={() => void clearCustomDictionary(prefs).then((p) => setPrefs(p))}>
              辞書を削除
            </button>
          )}
        </p>
      </details>
    </section>
  );
}
