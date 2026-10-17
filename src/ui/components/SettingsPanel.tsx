import type { Purpose, Stage } from '../../core/model/types';
import { startNanoDownload } from '../../engines/nano';
import { clearCustomDictionary } from '../../infra/storage';
import { PURPOSE_LABEL, STAGE_INFO } from '../labels';
import { useStore } from '../store';

const KEEP_LABEL = { relationships: '人物の関係', dates: '業務上の日付', amounts: '金額', organizations: '組織の区別' } as const;

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

  return (
    <section className="panel" aria-labelledby="settings-title">
      <h2 id="settings-title">2. 用途と段階</h2>

      <label className="field">
        <span>AIに頼む作業</span>
        <select value={prefs.purpose} onChange={(e) => setPrefs({ purpose: e.target.value as Purpose })}>
          {(Object.keys(PURPOSE_LABEL) as Purpose[]).map((p) => (
            <option key={p} value={p}>
              {PURPOSE_LABEL[p]}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="field">
        <legend>残したい情報</legend>
        <div className="checks">
          {(Object.keys(KEEP_LABEL) as (keyof typeof KEEP_LABEL)[]).map((k) => (
            <label key={k}>
              <input type="checkbox" checked={prefs.keep[k]} onChange={(e) => setPrefs({ keep: { ...prefs.keep, [k]: e.target.checked } })} />
              {KEEP_LABEL[k]}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="field">
        <legend>段階</legend>
        <div className="segmented" role="radiogroup" aria-label="段階">
          {(['A', 'B', 'C'] as Stage[]).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={prefs.stage === s}
              className={prefs.stage === s ? 'on' : ''}
              onClick={() => setPrefs({ stage: s })}
            >
              {STAGE_INFO[s].name}
            </button>
          ))}
        </div>
        <p className="hint">{STAGE_INFO[prefs.stage].note}</p>
        {policyMin && policyMin !== 'A' && <p className="hint">組織ポリシーにより、段階 {policyMin} より弱い加工は適用されません。</p>}
      </fieldset>

      {rec && rec.stage !== prefs.stage && (
        <div className="callout" role="status">
          <strong>おすすめ: 段階 {rec.stage}</strong>
          <ul>
            {rec.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <button type="button" onClick={() => setPrefs({ stage: rec.stage })}>
            段階 {rec.stage} にする
          </button>
          <p className="hint">切り替えるかどうかはご自身で判断してください。</p>
        </div>
      )}

      <details className="sub">
        <summary>検査の設定</summary>
        <label className="check-line">
          <input type="checkbox" checked disabled />
          規則（メール・電話・番号など）: 常に実行
        </label>
        <label className="check-line">
          <input type="checkbox" checked={prefs.useNer} onChange={(e) => setPrefs({ useNer: e.target.checked })} />
          NER（敬称のない人名・組織・地名）: {nerStatus ? (nerStatus.ok ? '利用できます' : nerStatus.reason) : '確認中'}
        </label>
        <label className="check-line">
          <input
            type="checkbox"
            checked={prefs.useNano}
            disabled={nanoStatus !== 'available'}
            onChange={(e) => setPrefs({ useNano: e.target.checked })}
          />
          Gemini Nano（文脈の補助判定・AI推定）:{' '}
          {nanoStatus === 'available'
            ? '利用できます'
            : nanoStatus === 'downloadable'
              ? 'モデルの取得が必要です'
              : nanoStatus === 'downloading'
                ? '取得中です'
                : nanoStatus === 'unsupported'
                  ? 'このブラウザでは使えません'
                  : nanoStatus === 'unavailable'
                    ? 'この端末では使えません'
                    : '確認中'}
        </label>
        {nanoStatus === 'downloadable' && (
          <div className="row">
            <button type="button" onClick={onDownloadNano} disabled={nanoProgress !== null}>
              {nanoProgress !== null ? `取得中 ${Math.round(nanoProgress * 100)}%` : 'Gemini Nano を取得する'}
            </button>
            <p className="hint">Chrome がモデル（数GB）を取得します。文章は送信されません。</p>
          </div>
        )}
        <p className="hint">設定したエンジンが使えないときは、出力を止めます（低リスクとは扱いません）。</p>

        <label className="field">
          <span>カスタム辞書（1行1語。「語=&gt;置換語」で置換語を指定）</span>
          <textarea rows={3} value={prefs.customText} onChange={(e) => setPrefs({ customText: e.target.value })} placeholder={'取引先A社\n山田太郎=>担当者'} />
        </label>
        <p className="hint">
          カスタム辞書はこのブラウザに保存されます。実名を含む場合は、使い終えたら削除してください。
          <button type="button" className="link" onClick={() => void clearCustomDictionary(prefs).then((p) => setPrefs(p))}>
            辞書を削除
          </button>
        </p>
      </details>
    </section>
  );
}
