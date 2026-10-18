import { useState } from 'react';
import { siteForUrl } from '../../adapters/sites';
import { MESSAGES } from '../../core/explain/messages';
import { copyText } from '../../infra/clipboard';
import { saveFile } from '../../infra/download';
import { exportSpreadsheet } from '../../infra/spreadsheet-export';
import { log } from '../../infra/logger';
import { getActiveTab, insertToTab, requestSitePermission } from '../../infra/tabs';
import { canConfirm, canOutput, destinationKey, useStore } from '../store';
import { Icon } from './Icon';

/** 出力（FR-22, FR-23）。確認した版と送信先が一致するときだけ、コピー・挿入できる */
export function OutputPanel() {
  const state = useStore();
  const { result, confirmed, destination, conditions, analyzing, source } = state;
  const [message, setMessage] = useState<string | null>(null);
  if (!result || !result.text.trim()) return null;

  const stale = state.confirmationInvalidated || (confirmed !== null && (confirmed.contentId !== result.contentId || confirmed.destinationKey !== destinationKey(destination)));
  const ready = canOutput(state);
  const policy = result.policy;
  const originNotAllowed =
    destination.kind === 'insert' && policy.status === 'active' && policy.allowedOrigins !== undefined && !policy.allowedOrigins.includes(destination.origin);
  const blocked = !canConfirm(state);
  // 読み込んだファイルの本文のまま解析した結果だけを、同じ形式で保存できる
  const fileSource = source && result.text === source.text ? source : null;
  const fileLabel = fileSource ? `元と同じ形式（.${fileSource.fileName.split('.').pop()?.toLowerCase()}）で保存` : '';

  async function chooseInsert() {
    const sessionId = useStore.getState().sessionId;
    setMessage(null);
    const tab = await getActiveTab();
    const site = siteForUrl(tab?.url) ?? undefined;
    if (!tab) return setMessage('タブを取得できませんでした。');
    if (!site) {
      // URL が読めない（権限がない）場合も含め、対応サイトの権限を求めてから判定し直す
      return setMessage('対応しているAIサイト（Gemini・ChatGPT・Claude）のタブを表示してから押してください。');
    }
    const granted = await requestSitePermission(site);
    if (useStore.getState().sessionId !== sessionId) return;
    if (!granted) return setMessage('権限が許可されなかったため、コピーで貼り付けてください。');
    state.setDestination({ kind: 'insert', tabId: tab.id, origin: site.origin, siteId: site.id, siteName: site.name });
  }

  async function onOutput() {
    const current = useStore.getState();
    if (!current.result || !canOutput(current)) return;
    const { result, destination } = current;
    if (destination.kind === 'copy') {
      const ok = await copyText(result.masked);
      setMessage(ok ? MESSAGES.copied : 'コピーできませんでした。');
      log('output', { copy: ok });
      return;
    }
    if (destination.kind === 'file') {
      const src = current.source;
      if (!src || src.text !== result.text) return setMessage('読み込んだファイルの本文が変わったため、同じ形式では保存できません。');
      try {
        const out = exportSpreadsheet(src, result.segments);
        saveFile(out.bytes, out.fileName, out.mimeType);
        setMessage([`確認した加工文を「${out.fileName}」として保存しました。保存先の扱いにご注意ください。`, ...out.notes].join('\n'));
        log('output', { file: true });
      } catch {
        setMessage('ファイルを書き出せませんでした。コピーをお使いください。');
        log('output', { file: false });
      }
      return;
    }
    const site = siteForUrl(destination.origin);
    if (!site) return;
    const tab = await getActiveTab();
    const latest = useStore.getState();
    if (!canOutput(latest) || latest.revision !== current.revision || latest.confirmed !== current.confirmed || destinationKey(latest.destination) !== destinationKey(destination)) return;
    if (!tab || tab.id !== destination.tabId || siteForUrl(tab.url)?.origin !== destination.origin) {
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
    <section className="panel output-panel" aria-labelledby="output-title">
      <div className="section-heading">
        <div>
          <h2 id="output-title">4. 出力</h2>
          <p className="hint">内容を確認してから、AIで使う文章をコピーします。</p>
        </div>
        <span className={`chip chip-${ready ? 'ok' : blocked ? 'danger' : 'muted'}`}>{ready ? '確認済み' : analyzing ? '解析中' : blocked ? '出力停止中' : '未確認'}</span>
      </div>
      <fieldset className="field destination-options">
        <legend>出力先</legend>
        <label className="check-line">
          <input type="radio" name="dest" checked={destination.kind === 'copy'} onChange={() => state.setDestination({ kind: 'copy' })} />
          クリップボードにコピー
        </label>
        <label className="check-line">
          <input type="radio" name="dest" checked={destination.kind === 'insert'} onChange={() => void chooseInsert()} />
          表示中のAIサイトの入力欄に挿入
        </label>
        {fileSource && (
          <label className="check-line">
            <input type="radio" name="dest" checked={destination.kind === 'file'} onChange={() => state.setDestination({ kind: 'file' })} />
            {fileLabel}
          </label>
        )}
        {destination.kind === 'file' && fileSource && (
          <p className="hint">
            加工した値のセルだけを書き換え、書式・列幅・シート構成は元のまま残します。画像・コメント・グラフ・作成者などの情報は検査していないため取り除きます。
          </p>
        )}
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
      <div className="output-actions">
        <button
          type="button"
          className={ready ? 'confirmed-button' : 'primary'}
          disabled={blocked}
          onClick={() => state.confirm({ contentId: result.contentId, destinationKey: destinationKey(destination), masked: result.masked })}
        >
          <Icon name="check" />
          {MESSAGES.confirmButton}
        </button>
        <Icon name="arrow" className="action-arrow" />
        <button type="button" className={ready ? 'primary' : ''} disabled={!ready} onClick={() => void onOutput()}>
          <Icon name={destination.kind === 'copy' ? 'copy' : destination.kind === 'file' ? 'file' : 'arrow'} />
          {destination.kind === 'copy' ? MESSAGES.outputCopy : destination.kind === 'file' ? '確認した加工文をファイルに保存' : MESSAGES.outputInsert}
        </button>
      </div>
      {stale && <p className="hint warn">{MESSAGES.invalidated}</p>}
      {ready && <p className="hint">{MESSAGES.confirmed}</p>}
      {!ready && !blocked && !stale && <p className="hint">加工文を確認すると、コピー・挿入できるようになります。</p>}
      {message && <p className="hint pre-line" role="status">{message}</p>}
      <p className="hint">{MESSAGES.clipboardNote}</p>
    </section>
  );
}
