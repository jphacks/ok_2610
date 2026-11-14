import { useRef, useState } from 'react';
import type { RestoreResult } from '../../core/restore';
import { copyText } from '../../infra/clipboard';
import { saveFile } from '../../infra/download';
import { workerClient } from '../../infra/analysis-session';
import { ACCEPTED_EXTENSIONS, readSpreadsheetFile, SpreadsheetError } from '../../infra/spreadsheet';
import { restoreSpreadsheet, type SpreadsheetRestore } from '../../infra/spreadsheet-restore';
import { PDF_EXTENSION } from '../../infra/pdf';
import { IMAGE_EXTENSIONS, isImageFile } from '../../infra/image/image';
import { log } from '../../infra/logger';
import { useStore } from '../store';
import { Icon } from './Icon';
import './review.css';

/** 手順4「回答を元に戻す」（任意）。AIの回答の復元（ARCHITECTURE.md §11-3）。貼付け → 復元 → コピー、または Excel・CSV → 復元 → 保存。AIサイトには挿入しない */
export function RestorePanel() {
  const result = useStore((s) => s.result);
  const current = useStore((s) => !s.analyzing && !s.error && s.resultRevision === s.revision);
  const [answer, setAnswer] = useState('');
  const [restored, setRestored] = useState<RestoreResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [restoredFile, setRestoredFile] = useState<SpreadsheetRestore | null>(null);
  const [fileMessage, setFileMessage] = useState<string | null>(null);
  // 文字のラベルがなくても、画像・PDF の顔や、保存した塗りつぶし済みの画像はファイルから戻せる（顔写真だけの画像など）
  const fileOnly = useStore((s) => (s.source?.kind === 'image' || s.source?.kind === 'pdf') && (s.source.faces.length > 0 || s.maskedImageDigest !== null || s.pdfMaskedImages.length > 0));
  const fileInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  if (!result) return null;
  const hasLabels = Object.keys(result.restoreMap).length > 0 || Object.keys(result.generalizedMap).length > 0;
  if (!hasLabels && !fileOnly) return null;

  async function restore() {
    const before = useStore.getState();
    if (!before.result || before.analyzing || before.error || before.resultRevision !== before.revision) return;
    try {
      const value = await workerClient().call('restore', {
        text: answer,
        restoreMap: before.result.restoreMap,
        generalizedMap: before.result.generalizedMap,
      });
      if (useStore.getState().revision === before.revision) setRestored(value);
    } catch {
      if (useStore.getState().revision === before.revision) setMessage('復元できませんでした。もう一度お試しください。');
    }
  }

  // AIが作った Excel・CSV のセルを戻す。加工して渡したファイルと同じ形でなくてよい
  // PDF は、ラベルを同じ場所で元の語に書き換える。自分が加工した PDF の画像は元の画素に戻す（Issue #9）
  async function restoreFile(file: File | undefined) {
    if (!file) return;
    const before = useStore.getState();
    setRestoredFile(null);
    setFileMessage(null);
    try {
      if (!before.result || before.analyzing || before.error || before.resultRevision !== before.revision) return;
      if (file.name.toLowerCase().endsWith(PDF_EXTENSION)) {
        setFileMessage('PDF を元に戻しています…');
        const { openPdfEnv } = await import('../../infra/pdf/browser');
        const { restorePdf } = await import('../../infra/pdf/restore');
        const env = await openPdfEnv();
        try {
          const src = before.source?.kind === 'pdf' ? before.source : null;
          const value = await restorePdf(
            {
              fileName: file.name,
              bytes: new Uint8Array(await file.arrayBuffer()),
              restoreMap: before.result.restoreMap,
              generalizedMap: before.result.generalizedMap,
              ...(src
                ? {
                    original: {
                      base: src.base,
                      maskedImages: useStore.getState().pdfMaskedImages,
                      faces: src.faces.map((f) => ({ objectNumber: src.images[f.image]!.objectNumber, generation: src.images[f.image]!.generation, box: f.box })),
                    },
                  }
                : {}),
            },
            env,
          );
          if (useStore.getState().revision !== before.revision) return;
          setFileMessage(null);
          setRestoredFile({
            bytes: value.bytes,
            fileName: value.fileName,
            mimeType: 'application/pdf',
            cellCount: value.replaced + value.images,
            replacedCount: value.replaced,
            generalized: [],
            unmatched: value.unmatched,
            notes: [...(value.images ? [`画像 ${value.images} 枚を元に戻しました。`] : []), ...value.notes],
          });
          log('restore', { pdf: true, replaced: value.replaced });
        } finally {
          await env.dispose();
        }
        return;
      }
      if (isImageFile(file.name)) {
        // 画像は、このパネルで加工した画像なら元の画素に戻し、それ以外は OCR でラベルを探して元の語を描く（Issue #11）
        setFileMessage('画像を元に戻しています…');
        const { openImageEnv } = await import('../../infra/image/browser');
        const { restoreImage } = await import('../../infra/image/image');
        const env = await openImageEnv();
        try {
          const src = before.source?.kind === 'image' ? before.source : null;
          const value = await restoreImage(
            {
              fileName: file.name,
              bytes: new Uint8Array(await file.arrayBuffer()),
              restoreMap: before.result.restoreMap,
              generalizedMap: before.result.generalizedMap,
              ...(src ? { original: { base: src.base, digest: useStore.getState().maskedImageDigest, faces: src.faces } } : {}),
            },
            env,
          );
          if (useStore.getState().revision !== before.revision) return;
          setFileMessage(null);
          setRestoredFile({
            bytes: value.bytes,
            fileName: value.fileName,
            mimeType: 'image/png',
            cellCount: value.replaced + value.images,
            replacedCount: value.replaced,
            generalized: [],
            unmatched: value.unmatched,
            notes: value.notes,
          });
          log('restore', { image: true, replaced: value.replaced });
        } finally {
          await env.dispose();
        }
        return;
      }
      const { source } = await readSpreadsheetFile(file);
      const value = restoreSpreadsheet(source, before.result.restoreMap, before.result.generalizedMap);
      if (useStore.getState().revision !== before.revision) return;
      setRestoredFile(value);
      log('restore', { file: true, cells: value.cellCount });
    } catch (e) {
      if (useStore.getState().revision === before.revision) setFileMessage(e instanceof SpreadsheetError || (e instanceof Error && (e.name === 'PdfRestoreError' || e.name === 'ImageRestoreError')) ? (e as Error).message : 'ファイルを復元できませんでした。');
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const generalizedNote = (list: { from: string; to: string }[]) =>
    list.length > 0 && <p className="hint">一般化から戻した語: {list.map((g) => `${g.from}→${g.to}`).join('、')}（一般的な意味の語も戻るので確かめてください）</p>;
  const unmatchedNote = (list: string[]) => list.length > 0 && <p className="hint warn">戻せなかったラベル: {list.join('、')}（AIが書き換えた可能性があります）</p>;

  // 結果の1行と同じことを言う注記は、詳しい方を結果の1行にして重ねない
  const fileStatus = restoredFile && (() => {
    const text =
      restoredFile.cellCount === 0
        ? '戻せるラベルが見つかりませんでした。'
        : restoredFile.mimeType === 'image/png' && restoredFile.replacedCount === 0
          ? '元の画像に戻しました。'
          : restoredFile.mimeType === 'application/pdf' || restoredFile.mimeType === 'image/png'
            ? `${restoredFile.replacedCount}箇所を戻しました。`
            : `${restoredFile.cellCount}セル・${restoredFile.replacedCount}箇所を戻しました。`;
    const merged = restoredFile.notes.find((n) => n !== text && n.endsWith(text));
    return { text: merged ?? text, notes: restoredFile.notes.filter((n) => n !== merged && n !== text) };
  })();

  return (
    <section className={`panel restore-panel ${open ? 'open' : ''}`} aria-labelledby="restore-title">
      <div className="step-heading">
        <span className="step-num" aria-hidden="true">4</span>
        <h2 id="restore-title">
          <button type="button" className="disclosure" aria-expanded={open} aria-controls="restore-body" onClick={() => setOpen(!open)}>
            回答を元に戻す
            <Icon name="chevron" className="disclosure-icon" />
          </button>
        </h2>
        <span className="step-meta">任意</span>
      </div>
      <div id="restore-body" hidden={!open}>
        {hasLabels && (
          <div className="restore-flow">
            <h3>文章で戻す</h3>
            <p className="hint">AIの回答の「人物A」などを元の語に戻します。</p>
            <details className="more">
              <summary>詳しく</summary>
              <p className="hint">「30代」などに一般化した語も戻します。加工後の文章のほかの所にも同じ語がある一般化と、削除した情報は戻せません。</p>
            </details>
            <textarea rows={5} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="AIの回答を貼り付け" aria-label="AIの回答" />
            <button type="button" className="primary" disabled={!answer.trim() || !current} onClick={() => void restore()}>
              ラベルを元の語に戻す
            </button>
            {restored && (
              <>
                <div className="output-preview" aria-label="元に戻した文章">
                  {restored.restored}
                </div>
                <p className="hint">{restored.replacedCount}箇所を戻しました。</p>
                {generalizedNote(restored.generalized)}
                {unmatchedNote(restored.unmatched)}
                <button
                  type="button"
                  disabled={!current}
                  onClick={async () => setMessage((await copyText(restored.restored)) ? 'コピーしました。原文を含むので、外部のサービスには貼り付けないでください。' : 'コピーできませんでした。')}
                >
                  <Icon name="copy" />
                  コピーする
                </button>
              </>
            )}
            {message && <p className="hint" role="status">{message}</p>}
          </div>
        )}
        <div className="restore-flow restore-file">
          {hasLabels && <h3>ファイルで戻す</h3>}
          <p className="hint">{hasLabels ? 'AIが返した Excel・CSV・PDF・画像のラベルも戻せます。' : '保存した画像・PDF の「[顔1]」などを元に戻せます。'}</p>
          <details className="more">
            <summary>詳しく</summary>
            <p className="hint">
              {hasLabels
                ? 'PDF はレイアウトを保ったまま戻します。画像の中のラベルは OCR で探して元の語を描き込みます。'
                : 'AIが手を加えた画像では、ラベルを OCR で探して戻します。'}
            </p>
          </details>
          <button type="button" disabled={!current} onClick={() => fileInput.current?.click()}>
            <Icon name="file" />
            ファイルを選んで戻す
          </button>
          <input
            ref={fileInput}
            type="file"
            accept={[...ACCEPTED_EXTENSIONS, PDF_EXTENSION, ...IMAGE_EXTENSIONS].join(',')}
            hidden
            aria-label="復元する Excel・CSV・PDF・画像ファイル"
            onChange={(e) => void restoreFile(e.target.files?.[0])}
          />
          {fileMessage && !restoredFile && <p className="hint warn">{fileMessage}</p>}
          {restoredFile && (
            <>
              <p className="hint" role="status">{fileStatus?.text}</p>
              {generalizedNote(restoredFile.generalized)}
              {unmatchedNote(restoredFile.unmatched)}
              {fileStatus && fileStatus.notes.length > 0 && (
                <ul className="hint file-notes">
                  {fileStatus.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              {restoredFile.cellCount > 0 && (
                <button
                  type="button"
                  className="primary"
                  disabled={!current}
                  onClick={() => {
                    saveFile(restoredFile.bytes, restoredFile.fileName, restoredFile.mimeType);
                    setFileMessage('保存しました。原文を含むので、外部のサービスにはアップロードしないでください。');
                  }}
                >
                  「{restoredFile.fileName}」を保存
                </button>
              )}
              {fileMessage && <p className="hint">{fileMessage}</p>}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
