import { useEffect, useMemo, useState } from 'react';
import { PRESETS, PREVIEW_TEXT, presetOf, type PresetId } from '../../shared/policy-presets';
import { analyze } from '../../src/core/analyze';
import { resolvePolicy } from '../../src/core/policy';
import { api, ApiError, type Coverage, type IssuedToken, type SetupState, type SetupSteps } from './api';

// 初回の案内（はじめての設定、SERVER_DESIGN.md §13）。
// システムに詳しくない管理者でも、専門用語（トークン・公開鍵・JSON）に触れずに、5つの手順で社員の端末にルールを届けられるようにする。

export const SETUP_STEPS: { key: keyof SetupSteps; label: string }[] = [
  { key: 'organization', label: '組織の情報' },
  { key: 'rules', label: 'ルールを選ぶ' },
  { key: 'departments', label: '部署を登録' },
  { key: 'distribute', label: '端末に配る' },
  { key: 'connected', label: 'つながったか確認' },
];

/** 最初のまだ済んでいない手順（すべて済んでいれば最後） */
export const firstOpenStep = (s: SetupState) => {
  const i = SETUP_STEPS.findIndex((x) => !s.steps[x.key]);
  return i < 0 ? SETUP_STEPS.length - 1 : i;
};

const message = (e: unknown, fallback: string) => (e instanceof ApiError && e.issues[0] ? e.issues[0].message : fallback);

export function Setup({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<SetupState | null>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const reload = async (moveTo?: number) => {
    const s = await api.setup();
    setState(s);
    if (moveTo !== undefined) setStep(moveTo);
    return s;
  };
  useEffect(() => {
    api.setup().then((s) => { setState(s); setStep(firstOpenStep(s)); }).catch(() => setError('設定の状態を読み込めませんでした。'));
  }, []);

  if (error) return <p className="banner danger" role="alert">{error}</p>;
  if (!state) return null;
  const next = () => void reload(Math.min(step + 1, SETUP_STEPS.length - 1));
  const back = () => setStep(Math.max(step - 1, 0));

  return (
    <section className="setup" aria-labelledby="setup-title">
      <nav className="card setup-steps" aria-label="設定の手順">
        <p id="setup-title" className="setup-steps-title">はじめての設定</p>
        <ol>
          {SETUP_STEPS.map((s, i) => (
            <li key={s.key}>
              <button type="button" aria-current={i === step ? 'step' : undefined} onClick={() => setStep(i)} className={state.steps[s.key] ? 'done' : ''}>
                <span className="step-mark" aria-hidden="true">{state.steps[s.key] ? <Check /> : i + 1}</span>
                <span>{s.label}</span>
                <span className="visually-hidden">{state.steps[s.key] ? '（済み）' : '（まだ）'}</span>
              </button>
            </li>
          ))}
        </ol>
        <p className="hint">途中でやめても、概要の画面から続きを始められます。</p>
      </nav>

      <div className="card setup-main">
        <p className="setup-progress">ステップ {step + 1} / {SETUP_STEPS.length}</p>
        {step === 0 && <OrganizationStep state={state} onNext={next} onLater={onDone} />}
        {step === 1 && <RulesStep state={state} onNext={next} onBack={back} />}
        {step === 2 && <DepartmentsStep state={state} onNext={next} onBack={back} />}
        {step === 3 && <DistributeStep state={state} onNext={next} onBack={back} />}
        {step === 4 && <CheckStep state={state} onReload={() => void reload()} onBack={back} onDone={onDone} />}
      </div>
    </section>
  );
}

function Check() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7" /></svg>;
}

function Actions({ back, next, nextLabel, disabled, busy }: { back: { label: string; onClick: () => void }; next: { onClick: () => void } | null; nextLabel: string; disabled?: boolean; busy?: boolean }) {
  return (
    <div className="setup-actions">
      <button type="button" className="ghost" onClick={back.onClick}>{back.label}</button>
      {next && <button type="button" className="primary large" disabled={disabled || busy} onClick={next.onClick}>{busy ? '保存しています…' : nextLabel}</button>}
    </div>
  );
}

// ---- 1. 組織の情報 -------------------------------------------------------------------------

function OrganizationStep({ state, onNext, onLater }: { state: SetupState; onNext: () => void; onLater: () => void }) {
  const [name, setName] = useState(state.organization.name);
  const [contact, setContact] = useState(state.organization.contact ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.saveOrganization({ name: name.trim(), contact: contact.trim() });
      onNext();
    } catch (e) {
      setError(message(e, '保存できませんでした。'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div>
        <h1>組織の情報</h1>
        <p className="lead">ここに入れた内容は、社員の画面に出ます。あとから変えられます。</p>
      </div>
      <label className="field"><span>組織名</span><input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></label>
      <label className="field">
        <span>社員が困ったときの相談先</span>
        <input value={contact} onChange={(e) => setContact(e.target.value)} maxLength={120} placeholder="情報システム部 内線 1234" />
        <small className="hint">例：部署名と内線番号、社内チャットのチャンネル名など</small>
      </label>
      <div className="sample-box">
        <p className="sample-title">社員の画面ではこう出ます</p>
        <div className="sample-row">
          <span className="pill">組織ポリシー：{name.trim() || '（組織名）'}</span>
          {contact.trim() && <span>困ったときは <strong>{contact.trim()}</strong> へ</span>}
        </div>
      </div>
      {error && <p className="banner danger" role="alert">{error}</p>}
      <Actions back={{ label: 'あとで設定する', onClick: onLater }} next={{ onClick: () => void save() }} nextLabel="次へ：ルールを選ぶ" disabled={!name.trim()} busy={busy} />
    </>
  );
}

// ---- 2. ルールを選ぶ ------------------------------------------------------------------------

type Segment = { text: string; masked: boolean };

/** 見本の文章を、そのひな形のルールで実際に解析して、AI に渡る文章を作る（拡張と同じ判定を使う） */
async function previewOf(presetId: PresetId): Promise<Segment[]> {
  const preset = presetOf(presetId)!;
  const policy = resolvePolicy({ version: 'preview', ...preset.rules }, new Date().toISOString());
  const result = await analyze({
    text: PREVIEW_TEXT,
    settings: { stage: preset.rules.minStage ?? 'A', purpose: 'summary', keep: { relationships: true, dates: true, amounts: true, organizations: false }, profile: ['rule'], customTerms: [], includeHistory: false },
    ops: [],
    engineOutputs: [],
    policy,
    conditions: { status: 'unanswered', restricted: [], consult: [] },
  });
  const segments: Segment[] = [];
  let at = 0;
  for (const c of [...result.candidates].sort((a, b) => a.start - b.start)) {
    if (c.output === c.text || c.start < at) continue;
    if (c.start > at) segments.push({ text: PREVIEW_TEXT.slice(at, c.start), masked: false });
    segments.push({ text: c.output, masked: true });
    at = c.end;
  }
  if (at < PREVIEW_TEXT.length) segments.push({ text: PREVIEW_TEXT.slice(at), masked: false });
  return segments;
}

function RulesStep({ state, onNext, onBack }: { state: SetupState; onNext: () => void; onBack: () => void }) {
  const [picked, setPicked] = useState<PresetId>(state.defaultPreset ?? 'standard');
  const [collectUsage, setCollectUsage] = useState(state.collectUsage);
  const [preview, setPreview] = useState<Segment[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = presetOf(picked)!;

  useEffect(() => {
    let live = true;
    previewOf(picked).then((p) => { if (live) setPreview(p); }).catch(() => { if (live) setPreview(null); });
    return () => { live = false; };
  }, [picked]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.saveRules({ preset: picked, collectUsage });
      onNext();
    } catch (e) {
      setError(message(e, '保存できませんでした。'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div>
        <h1>ルールを選ぶ</h1>
        <p className="lead">社員が AI に文章を貼る前に、どこまで隠すかを選びます。迷ったら「標準」で始めて、あとから変えられます。</p>
      </div>
      <div className="preset-grid" role="radiogroup" aria-label="ルールのひな形">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={picked === p.id} className="preset-card" onClick={() => setPicked(p.id)}>
            <span className="preset-head">
              <strong>{p.name}</strong>
              {picked === p.id && <span className="check-dot"><Check /></span>}
            </span>
            {p.recommended && <span className="pill">おすすめ</span>}
            <span className="preset-summary">{p.summary}</span>
          </button>
        ))}
      </div>

      <section className="preview" aria-labelledby="preview-title">
        <div className="preview-head">
          <h2 id="preview-title">社員の画面での見え方（例）</h2>
          <span>「{current.name}」を選んだとき</span>
        </div>
        <div className="preview-body">
          <div>
            <p className="sample-title">社員が貼った文章</p>
            <p>{PREVIEW_TEXT}</p>
          </div>
          <div>
            <p className="sample-title">AI に渡る文章</p>
            <p aria-live="polite">{preview ? preview.map((s, i) => (s.masked ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>)) : '…'}</p>
          </div>
        </div>
        <ul className="preview-points">{current.points.map((t) => <li key={t}>{t}</li>)}</ul>
      </section>

      <label className="check">
        <input type="checkbox" checked={collectUsage} onChange={(e) => setCollectUsage(e.target.checked)} />
        どんな情報をどれだけ隠したかの件数も集める（文章そのものは集めません）
      </label>
      <p className="hint">情報の種類ごとに細かく決めたいときは、設定が終わったあと「ポリシー」の画面で直せます。</p>
      {error && <p className="banner danger" role="alert">{error}</p>}
      <Actions back={{ label: '戻る', onClick: onBack }} next={{ onClick: () => void save() }} nextLabel="次へ：部署を登録" busy={busy} />
    </>
  );
}

// ---- 3. 部署を登録 --------------------------------------------------------------------------

type Row = { key: number; code?: string; name: string; preset: PresetId };

function DepartmentsStep({ state, onNext, onBack }: { state: SetupState; onNext: () => void; onBack: () => void }) {
  const [mode, setMode] = useState<'split' | 'whole'>(state.departmentMode ?? 'split');
  const [rows, setRows] = useState<Row[]>(() =>
    state.departments.length
      ? state.departments.map((d, i) => ({ key: i, code: d.code, name: d.name, preset: d.preset }))
      : [{ key: 0, name: '', preset: state.defaultPreset ?? 'standard' }],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: number, patch: Partial<Row>) => setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const filled = rows.filter((r) => r.name.trim());
  const names = filled.map((r) => r.name.trim());
  const duplicate = new Set(names).size !== names.length;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.saveDepartments({ mode, departments: mode === 'whole' ? [] : filled.map((r) => ({ ...(r.code ? { code: r.code } : {}), name: r.name.trim(), preset: r.preset })) });
      onNext();
    } catch (e) {
      setError(message(e, '保存できませんでした。'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div>
        <h1>部署を登録</h1>
        <p className="lead">部署ごとにルールを変えたり、部署ごとに届いたかを確かめたりできます。全社で同じでよければ、分けなくてかまいません。</p>
      </div>
      <div className="choice-row" role="radiogroup" aria-label="部署の分け方">
        <button type="button" role="radio" aria-checked={mode === 'split'} className="choice" onClick={() => setMode('split')}>部署ごとに分ける</button>
        <button type="button" role="radio" aria-checked={mode === 'whole'} className="choice" onClick={() => setMode('whole')}>全社で同じにする</button>
      </div>

      {mode === 'split' ? (
        <div className="dept-rows">
          <div className="dept-row dept-head" aria-hidden="true"><span>部署名（社内での呼び方）</span><span>配るルール</span><span /></div>
          {rows.map((r) => (
            <div key={r.key} className="dept-row">
              <div className="field">
                <input aria-label="部署名" value={r.name} onChange={(e) => set(r.key, { name: e.target.value })} maxLength={40} placeholder="営業部" />
                <small className="hint">{r.code ? `管理用の名前 ${r.code}` : '管理用の名前は保存するときに自動で付けます'}</small>
              </div>
              <select aria-label={`${r.name || 'この部署'}に配るルール`} value={r.preset} onChange={(e) => set(r.key, { preset: e.target.value as PresetId })}>
                {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button type="button" className="icon-only" aria-label={`${r.name || 'この行'}を外す`} onClick={() => setRows(rows.filter((x) => x.key !== r.key))}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
          ))}
          <button type="button" className="add-row" onClick={() => setRows([...rows, { key: Math.max(-1, ...rows.map((r) => r.key)) + 1, name: '', preset: state.defaultPreset ?? 'standard' }])}>＋ 部署を足す</button>
          <p className="hint">ここにない部署の社員には、ステップ 2 で選んだルール（全社の既定）が届きます。</p>
          {duplicate && <p className="banner danger" role="alert">同じ部署名が2回あります。</p>}
        </div>
      ) : (
        <div className="sample-box">全社の社員に、ステップ 2 で選んだ「{presetOf(state.defaultPreset ?? 'standard')!.name}」を配ります。次のステップでコピーする設定も1つだけになります。</div>
      )}
      {error && <p className="banner danger" role="alert">{error}</p>}
      <Actions back={{ label: '戻る', onClick: onBack }} next={{ onClick: () => void save() }} nextLabel="次へ：端末に配る" disabled={mode === 'split' && (filled.length === 0 || duplicate)} busy={busy} />
    </>
  );
}

// ---- 4. 端末に配る --------------------------------------------------------------------------

const GOOGLE_STEPS = [
  'Google 管理コンソール（admin.google.com）で、「デバイス」→「Chrome」→「アプリと拡張機能」→「ユーザーとブラウザ」を開きます。',
  '左の一覧で、配る部署（組織部門）を選びます。',
  '右下の「＋」から「Chrome ウェブストアから追加」を選び、「テキストクリーナー」を追加します。',
  'インストールの方法を「強制インストール」にします。社員が外せなくなります。',
  '右側の「拡張機能に適用するポリシー」の欄に、下のボタンでコピーした設定を貼り付けて保存します。',
];
const INTUNE_STEPS = [
  'Intune 管理センターで、Chrome の拡張を配る構成プロファイルを開きます（ない場合は作ります）。',
  '配る部署のグループを割り当て先に選びます。',
  '強制インストールする拡張の一覧に「テキストクリーナー」を足します。',
  '拡張に配るポリシーの欄に、下のボタンでコピーした設定を貼り付けて保存します。',
];

/** 配る先。部署ごと＋全社の既定（部署なしのトークン） */
function targetsOf(state: SetupState): { code: string | null; name: string; preset: PresetId }[] {
  const base = state.defaultPreset ?? 'standard';
  if (state.departmentMode !== 'split') return [{ code: null, name: '全社', preset: base }];
  return [...state.departments.map((d) => ({ code: d.code, name: d.name, preset: d.preset })), { code: null, name: 'ほかの部署（全社の既定）', preset: base }];
}

function DistributeStep({ state, onNext, onBack }: { state: SetupState; onNext: () => void; onBack: () => void }) {
  const [tool, setTool] = useState<'google' | 'intune'>('google');
  const [issued, setIssued] = useState<Record<string, IssuedToken>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const targets = targetsOf(state);
  const steps = tool === 'google' ? GOOGLE_STEPS : INTUNE_STEPS;

  /** 初めて押したときにその部署の合言葉（登録トークン）を作り、貼る設定をコピーする。作った合言葉はこの画面にいる間だけ持つ */
  async function copy(t: { code: string | null; name: string }, format: 'google' | 'raw') {
    setError(null);
    const key = t.code ?? '';
    try {
      const token = issued[key] ?? (await api.createToken(`はじめての設定（${t.name}）`, t.code));
      setIssued((m) => ({ ...m, [key]: token }));
      await navigator.clipboard.writeText(JSON.stringify(format === 'google' ? token.bootstrapGoogle : token.bootstrap, null, 2));
      setCopied(`${key}:${format}`);
    } catch {
      setError('コピーできませんでした。下の「うまくコピーできないとき」から設定を選んでコピーしてください。');
    }
  }

  return (
    <>
      <div>
        <h1>端末に配る</h1>
        <p className="lead">ふだん PC の設定を配っている管理ツールで、拡張と設定を社員の Chrome に配ります。使っているツールを選んでください。</p>
      </div>
      <div className="choice-row" role="tablist" aria-label="使っている管理ツール">
        <button type="button" role="tab" aria-selected={tool === 'google'} className="choice" onClick={() => setTool('google')}>Google 管理コンソール</button>
        <button type="button" role="tab" aria-selected={tool === 'intune'} className="choice" onClick={() => setTool('intune')}>Microsoft Intune</button>
      </div>
      <ol className="howto">
        {steps.map((s, i) => <li key={s}><span className="howto-no">{i + 1}</span><span>{s}</span></li>)}
      </ol>

      <section className="copy-box" aria-labelledby="copy-title">
        <h2 id="copy-title">部署ごとの設定（手順 {steps.length} で貼る）</h2>
        <ul>
          {targets.map((t) => {
            const key = t.code ?? '';
            return (
              <li key={key}>
                <span><strong>{t.name}</strong><span className="muted rule-note">ルール：{presetOf(t.preset)!.name}</span></span>
                <span className="copy-buttons">
                  <button type="button" className={copied === `${key}:${tool === 'google' ? 'google' : 'raw'}` ? 'copied' : ''} onClick={() => void copy(t, tool === 'google' ? 'google' : 'raw')}>
                    {copied === `${key}:${tool === 'google' ? 'google' : 'raw'}` ? 'コピーしました' : `${t.name.replace('（全社の既定）', '')}の設定をコピー`}
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
        <p className="hint">設定には、その部署だけの合言葉が入っています。社外の人には見せないでください。漏れたときは「登録トークン」の画面から取り消せます。</p>
        {Object.keys(issued).length > 0 && (
          <details>
            <summary>うまくコピーできないとき</summary>
            {targets.filter((t) => issued[t.code ?? '']).map((t) => (
              <label key={t.code ?? ''} className="field">
                <span>{t.name}</span>
                <textarea readOnly rows={7} value={JSON.stringify(tool === 'google' ? issued[t.code ?? '']!.bootstrapGoogle : issued[t.code ?? '']!.bootstrap, null, 2)} onFocus={(e) => e.currentTarget.select()} />
              </label>
            ))}
          </details>
        )}
      </section>
      {error && <p className="banner danger" role="alert">{error}</p>}
      <Actions back={{ label: '戻る', onClick: onBack }} next={{ onClick: onNext }} nextLabel="貼り付けた：つながったか確かめる" disabled={Object.keys(issued).length === 0 && !state.steps.distribute} />
    </>
  );
}

// ---- 5. つながったか確認 ---------------------------------------------------------------------

function CheckStep({ state, onReload, onBack, onDone }: { state: SetupState; onReload: () => void; onBack: () => void; onDone: () => void }) {
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [checking, setChecking] = useState(false);
  const targets = useMemo(() => targetsOf(state), [state]);
  const refresh = async () => {
    setChecking(true);
    try {
      setCoverage(await api.coverage());
      onReload();
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    let live = true;
    api.coverage().then((c) => { if (live) setCoverage(c); }).catch(() => undefined);
    return () => { live = false; };
  }, []);

  const rows = targets.map((t) => {
    const c = coverage?.departments.find((d) => (d.department ?? null) === t.code);
    return { ...t, devices: c?.devices ?? 0, current: c?.current ?? 0 };
  });
  const connected = rows.filter((r) => r.devices > 0).length;

  return (
    <>
      <div className="setup-title-row">
        <div>
          <h1>つながったか確認</h1>
          <p className="lead">社員が Chrome のサイドパネルを開くと、ルールが届いて、ここに台数が出ます。</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={checking}>{checking ? '確かめています…' : 'もう一度確かめる'}</button>
      </div>
      <div className="connected-summary"><strong>{connected} / {rows.length}</strong> 部署がつながりました</div>
      <ul className="status-list">
        {rows.map((r) => (
          <li key={r.code ?? ''}>
            <span className={r.devices > 0 ? 'status-mark ok' : 'status-mark waiting'} aria-hidden="true">{r.devices > 0 ? <Check /> : null}</span>
            <span><strong>{r.name}</strong><br /><small className="muted">ルール「{presetOf(r.preset)!.name}」{r.devices > 0 && r.current < r.devices ? `・まだ古いルールの端末 ${r.devices - r.current} 台` : ''}</small></span>
            <span className={r.devices > 0 ? 'status-badge ok' : 'status-badge waiting'}>{r.devices > 0 ? `${r.devices}台つながりました` : 'まだつながっていません'}</span>
          </li>
        ))}
      </ul>
      {connected < rows.length && (
        <section className="help-box" aria-labelledby="help-title">
          <h2 id="help-title">まだつながらない部署があるとき</h2>
          <ul>
            <li>管理ツールの設定が社員の PC に届くまで、数分から数時間かかることがあります</li>
            <li>その部署の社員に、Chrome のサイドパネルを一度開いてもらってください</li>
            <li>ステップ 4 で、設定を貼った部署（組織部門）が合っているか確かめてください</li>
          </ul>
        </section>
      )}
      <Actions back={{ label: '戻る', onClick: onBack }} next={{ onClick: onDone }} nextLabel="設定を終えて概要へ" />
    </>
  );
}

/** 概要の画面の「はじめにやること」 */
export function SetupChecklist({ state, onResume }: { state: SetupState; onResume: () => void }) {
  const done = SETUP_STEPS.filter((s) => state.steps[s.key]).length;
  const nextStep = SETUP_STEPS[firstOpenStep(state)]!;
  return (
    <section className="card setup-checklist" aria-labelledby="todo-title">
      <div className="setup-title-row">
        <div>
          <h2 id="todo-title">はじめにやること</h2>
          <p className="muted">あと {SETUP_STEPS.length - done} つで、社員の端末にルールが届いたことを確かめられます。</p>
        </div>
        <div className="progress-row">
          <strong>{done} / {SETUP_STEPS.length}</strong>
          <span className="progress-track" role="img" aria-label={`${SETUP_STEPS.length}つのうち${done}つ終わりました`}><span style={{ width: `${(done / SETUP_STEPS.length) * 100}%` }} /></span>
        </div>
      </div>
      <ol className="todo-list">
        {SETUP_STEPS.map((s) => (
          <li key={s.key} className={state.steps[s.key] ? 'done' : ''}>
            <span className="step-mark" aria-hidden="true">{state.steps[s.key] ? <Check /> : null}</span>
            {s.label}<span className="visually-hidden">{state.steps[s.key] ? '（済み）' : '（まだ）'}</span>
          </li>
        ))}
      </ol>
      <button type="button" className="primary large" onClick={onResume}>続きから始める：{nextStep.label}</button>
    </section>
  );
}

