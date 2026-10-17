import { useState } from 'react';
import { siteForUrl } from '../../adapters/sites';
import { MESSAGES } from '../../core/explain/messages';
import { copyText } from '../../infra/clipboard';
import { log } from '../../infra/logger';
import { getActiveTab, insertToTab, requestSitePermission } from '../../infra/tabs';
import { canOutput, destinationKey, useStore } from '../store';

/** 出力（FR-22, FR-23）。確認した版と送信先が一致するときだけ、コピー・挿入できる */
export function OutputPanel() {
  const state = useStore();
  const { result, confirmed, destination, conditions, analyzing } = state;
  const [message, setMessage] = useState<string | null>(null);
  if (!result || !result.text.trim()) return null;

  const stale = confirmed !== null && (confirmed.contentId !== result.contentId || confirmed.destinationKey !== destinationKey(destination));
  const ready = canOutput(state);
  const policy = result.policy;
  const originNotAllowed =
    destination.kind === 'insert' && policy.status === 'active' && policy.allowedOrigins !== undefined && !policy.allowedOrigins.includes(destination.origin);
  const blocked = result.blockers.length > 0 || analyzing || originNotAllowed;

  async function chooseInsert() {
    setMessage(null);
    const tab = await getActiveTab();
    const site = siteForUrl(tab?.url) ?? undefined;
    if (!tab) return setMessage('タブを取得できませんでした。');
    if (!site) {
      // URL が読めない（権限がない）場合も含め、対応サイトの権限を求めてから判定し直す
      return setMessage('対応しているAIサイト（Gemini・ChatGPT・Claude）のタブを表示してから押してください。');
    }
    const granted = await requestSitePermission(site);
    if (!granted) return setMessage('権限が許可されなかったため、コピーで貼り付けてください。');
    state.setDestination({ kind: 'insert', tabId: tab.id, origin: site.origin, siteId: site.id, siteName: site.name });
  }

  async function onOutput() {
    if (!result || !ready) return;
    if (destination.kind === 'copy') {
      const ok = await copyText(result.masked);
      setMessage(ok ? MESSAGES.copied : 'コピーできませんでした。');
      log('output', { copy: ok });
      return;
    }
    const site = siteForUrl(destination.origin);
    if (!site) return;
    const tab = await getActiveTab();
    if (!tab || tab.id !== destination.tabId) {
      setMessage('挿入先のタブが切り替わりました。挿入先を設定し直してください。');
      state.setDestination({ kind: 'copy' });
      return;
    }
    const outcome = await insertToTab(destination.tabId, site, result.masked);
    setMessage(outcome.ok ? MESSAGES.inserted : outcome.reason);
    log('output', { insert: outcome.ok });
  }

  const site = destination.kind === 'insert' ? siteForUrl(destination.origin) : undefined;

  return (
    <section className="panel" aria-labelledby="output-title">
      <h2 id="output-title">4. 出力</h2>
      <fieldset className="field">
        <legend>出力先</legend>
        <label className="check-line">
          <input type="radio" name="dest" checked={destination.kind === 'copy'} onChange={() => state.setDestination({ kind: 'copy' })} />
          クリップボードにコピー
        </label>
        <label className="check-line">
          <input type="radio" name="dest" checked={destination.kind === 'insert'} onChange={() => void chooseInsert()} />
          表示中のAIサイトの入力欄に挿入
        </label>
        {destination.kind === 'insert' && site && (
          <p className="hint">
            挿入先: {site.name}（{new URL(site.origin).host}）の入力欄。送信ボタンは押しません。
            {site.verifiedAt ? `動作確認日 ${site.verifiedAt}。` : 'このサイトでの挿入は未確認です。失敗したらコピーをお使いください。'}
            未対応: {site.unsupported.join('・')}
          </p>
        )}
        {originNotAllowed && <p className="hint warn">組織ポリシーで許可されていないサイトです。</p>}
      </fieldset>

      {(conditions.status === 'unknown' || conditions.status === 'restricted') && (
        <div className="callout warn">
          <strong>{MESSAGES.unresolved}</strong>
          <p>利用条件に分からない点・制約があります。確認が済むまで送信を控えることをおすすめします。</p>
          <button
            type="button"
            className="primary"
            onClick={() => {
              state.confirm(null);
              setMessage('送信をやめました。確認事項を担当者に相談してください。');
            }}
          >
            {MESSAGES.stopSending}
          </button>
        </div>
      )}

      <div className="output-preview" aria-label="出力される文章">
        {result.masked}
      </div>
      <div className="row">
        <button
          type="button"
          disabled={blocked}
          onClick={() => state.confirm({ contentId: result.contentId, destinationKey: destinationKey(destination), masked: result.masked })}
        >
          {MESSAGES.confirmButton}
        </button>
        <button type="button" className="primary" disabled={!ready} onClick={() => void onOutput()}>
          {destination.kind === 'copy' ? MESSAGES.outputCopy : MESSAGES.outputInsert}
        </button>
      </div>
      {stale && <p className="hint warn">{MESSAGES.invalidated}</p>}
      {ready && <p className="hint">{MESSAGES.confirmed}</p>}
      {message && <p className="hint" role="status">{message}</p>}
      <p className="hint">{MESSAGES.clipboardNote}</p>
    </section>
  );
}
