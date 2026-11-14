import { useEffect, useState } from 'react';
import { MESSAGES } from '../../core/explain/messages';
import { copyText } from '../../infra/clipboard';
import { saveFile } from '../../infra/download';
import { exportSpreadsheet } from '../../infra/spreadsheet-export';
import { log } from '../../infra/logger';
import { canConfirm, canOutput, destinationKey, useStore, type Destination } from '../store';
import { reportOutput } from '../usage';
import { Icon } from './Icon';
import './review.css';

const NEWLINE = String.fromCharCode(10);
const toDestination = (kind: 'file' | 'copy'): Destination => (kind === 'file' ? { kind: 'file' } : { kind: 'copy' });

/**
 * 手順3「AI に渡す」（FR-22, FR-23）。出力先は選ばせず、入力の形で決める。
 * 文章はコピー、読み込んだファイル（PDF・画像・Excel・CSV）は同じ形式で保存する。
 * 押した時点の版と出力先を確認済みにし、その版だけを出す。
 * 顔の選択と仕上がりの確認（FacesPanel・PdfPreview・ImagePreview）は、手順2（Preview）に置く。
 */
export function OutputPanel({ onConditions, showingOriginal, onShowMasked }: { onConditions: () => void; showingOriginal: boolean; onShowMasked: () => void }) {
  const state = useStore();
  const { result, destination, conditions, source, setDestination } = state;
  const [message, setMessage] = useState<string | null>(null);

  const fileSource = result && source && result.text === source.text ? source : null;
  const pdfBlockers = fileSource?.kind === 'pdf' ? fileSource.blockers : [];
  // PDF のまま保存できないときは、文章としてコピーする
  const wanted: 'file' | 'copy' = fileSource && pdfBlockers.length === 0 ? 'file' : 'copy';

  // 出力先は入力の形に合わせる（選ばせない）
  useEffect(() => {
    if (destination.kind !== wanted) setDestination(toDestination(wanted));
  }, [destination.kind, wanted, setDestination]);

  if (!result || !result.text.trim()) return null;

  const blocked = !canConfirm(state);
  const unresolved = conditions.status === 'unknown' || conditions.status === 'restricted';
  const isFile = wanted === 'file' && fileSource !== null;
  const ext = fileSource && fileSource.kind !== 'pdf' && fileSource.kind !== 'image' ? fileSource.fileName.split('.').pop()?.toLowerCase() ?? fileSource.kind : '';
  const action = !isFile ? 'コピーする' : fileSource.kind === 'pdf' ? 'PDF を保存する' : fileSource.kind === 'image' ? '画像を保存する' : `.${ext} で保存する`;

  async function onOutput() {
    // 出力先がまだ入力の形に追いついていなければ、ここで合わせてから確認する
    if (useStore.getState().destination.kind !== wanted) useStore.getState().setDestination(toDestination(wanted));
    const before = useStore.getState();
    if (showingOriginal || !before.result || !canConfirm(before)) return;
    // 確認と出力を1回の操作にまとめる。押した時点で表示中の版と出力先を確認済みにしてから出す
    before.confirm({ contentId: before.result.contentId, destinationKey: destinationKey(before.destination), masked: before.result.masked });
    const current = useStore.getState();
    if (!current.result || !canOutput(current)) return;
    const { result } = current;
    if (current.destination.kind !== 'file') {
      const ok = await copyText(result.masked);
      setMessage(ok ? 'コピーしました' : 'コピーできませんでした。');
      log('output', { copy: ok });
      if (ok) reportOutput();
      return;
    }
    const src = current.source;
    if (!src || src.text !== result.text) return setMessage('読み込んだファイルの本文が変わったため、同じ形式では保存できません。');
    if (src.kind === 'pdf') {
      setMessage('PDF を書き出しています…');
      try {
        const { openPdfEnv } = await import('../../infra/pdf/browser');
        const { exportMaskedPdf } = await import('../../infra/pdf/mask');
        const env = await openPdfEnv({ ocr: false });
        try {
          const out = await exportMaskedPdf(src, result.segments, env, current.pdfRects, current.keptFaces);
          const latest = useStore.getState();
          if (!canOutput(latest) || latest.revision !== current.revision) return setMessage('書き出しの間に内容が変わりました。もう一度押してください。');
          saveFile(out.bytes, out.fileName, 'application/pdf');
          latest.setPdfMaskedImages(out.maskedImages);
          setMessage([`「${out.fileName}」を保存しました。保存先の扱いにご注意ください。`, ...out.notes].join(NEWLINE));
          log('output', { pdf: true });
        } finally {
          await env.dispose();
        }
      } catch (e) {
        setMessage(e instanceof Error && e.message ? e.message : 'PDF を書き出せませんでした。');
        log('output', { pdf: false });
      }
      return;
    }
    if (src.kind === 'image') {
      setMessage('画像を書き出しています…');
      try {
        const { openImageEnv } = await import('../../infra/image/browser');
        const { exportMaskedImage } = await import('../../infra/image/image');
        const env = await openImageEnv({ ocr: false });
        try {
          const out = await exportMaskedImage(src, result.segments, env, current.imageRects, current.keptFaces);
          const latest = useStore.getState();
          if (!canOutput(latest) || latest.revision !== current.revision) return setMessage('書き出しの間に内容が変わりました。もう一度押してください。');
          saveFile(out.bytes, out.fileName, 'image/png');
          latest.setMaskedImageDigest(out.digest);
          setMessage([`「${out.fileName}」を保存しました。保存先の扱いにご注意ください。`, ...out.notes].join(NEWLINE));
          log('output', { image: true });
          reportOutput();
        } finally {
          await env.dispose();
        }
      } catch (e) {
        setMessage(e instanceof Error && e.name === 'ImageExportError' ? e.message : '画像を書き出せませんでした。');
        log('output', { image: false });
      }
      return;
    }
    try {
      const out = exportSpreadsheet(src, result.segments);
      saveFile(out.bytes, out.fileName, out.mimeType);
      setMessage([`「${out.fileName}」を保存しました。保存先の扱いにご注意ください。`, ...out.notes].join(NEWLINE));
      log('output', { file: true });
      reportOutput();
    } catch {
      setMessage('ファイルを書き出せませんでした。');
      log('output', { file: false });
    }
  }

  return (
    <section className="panel output-panel" aria-labelledby="output-title">
      {/* 画面の下に貼り付くので、見出しと出力ボタンを1行に並べて本文を隠しすぎないようにする */}
      <div className="output-top">
        <div className="step-heading">
          <span className="step-num" aria-hidden="true">3</span>
          <h2 id="output-title">AI に渡す</h2>
        </div>
        <div className="output-actions">
          {/* 利用条件が未確認のときは「送信をやめる」を最も目立つ操作にする（FR-16）ので、出力は通常のボタンに下げる */}
          <button
            type="button"
            className={unresolved ? 'output-main' : 'primary output-main'}
            aria-label={isFile ? MESSAGES.outputFile : MESSAGES.outputCopy}
            disabled={blocked || showingOriginal}
            onClick={() => void onOutput()}
          >
            <Icon name={isFile ? 'file' : 'copy'} />
            {action}
          </button>
        </div>
      </div>

      {pdfBlockers.length > 0 ? (
        <>
          <p className="hint warn">PDF のままでは保存できないため、文章でコピーします。</p>
          <details className="more">
            <summary>詳しく</summary>
            <ul className="hint file-notes" aria-label="PDF のまま保存できない理由">
              {pdfBlockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          </details>
        </>
      ) : !isFile ? (
        <p className="hint">コピーして、AI の入力欄に貼り付けます。</p>
      ) : fileSource.kind === 'pdf' ? (
        <>
          <p className="hint">隠す語をラベルに置き換え、レイアウトは保ちます。</p>
          <details className="more">
            <summary>詳しく</summary>
            <p className="hint">画像の中の語は塗りつぶしてラベルを書きます。作成者などのファイル情報・しおり・注釈・フォームは取り除きます。保存した PDF は手順4で元に戻せます。</p>
          </details>
        </>
      ) : fileSource.kind === 'image' ? (
        <>
          <p className="hint">隠す語を塗りつぶしてラベルを書き、PNG で保存します。</p>
          <details className="more">
            <summary>詳しく</summary>
            <p className="hint">撮影日時・位置などのファイル情報は含めません。保存した画像は手順4で元に戻せます。</p>
          </details>
        </>
      ) : (
        <>
          <p className="hint">加工したセルだけ書き換え、書式は元のまま残します。</p>
          <details className="more">
            <summary>詳しく</summary>
            <p className="hint">画像・コメント・グラフ・作成者などの情報は検査していないため取り除きます。</p>
          </details>
        </>
      )}

      {unresolved && (
        <div className="callout warn conditions-callout">
          <p><strong>{MESSAGES.unresolved}</strong> 確認が済むまで送信は控えてください。</p>
          <div className="row">
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
            <button type="button" onClick={onConditions}>利用条件を確認</button>
          </div>
        </div>
      )}

      {showingOriginal && <p className="hint warn">原文を表示中です。<button type="button" className="link" onClick={onShowMasked}>加工後に戻って確認</button></p>}
      {message && <p className="hint pre-line" role="status">{message}</p>}
    </section>
  );
}
