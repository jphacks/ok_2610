import { useRef, useState, type DragEvent } from 'react';
import { MAX_PDF_BYTES, PDF_EXTENSION, PdfError, readPdfFile } from '../../infra/pdf';
import { IMAGE_EXTENSIONS, isImageFile } from '../../infra/image/image';
import { ACCEPTED_EXTENSIONS, readSpreadsheetFile, SpreadsheetError } from '../../infra/spreadsheet';
import { getActiveTab, importSelection } from '../../infra/tabs';
import { useStore, type FileSource } from '../store';
import { ConfirmDialog } from './ConfirmDialog';
import { Icon } from './Icon';

export function InputPanel() {
  const text = useStore((s) => s.text);
  const setText = useStore((s) => s.setText);
  const importFile = useStore((s) => s.importFile);
  const source = useStore((s) => s.source);
  // 読み込んだ Excel・CSV は、文章に直したものを見せず、ファイルとして扱う
  const fileSource = source && source.text === text ? source : null;
  const reset = useStore((s) => s.reset);
  const [message, setMessage] = useState<string | null>(null);
  const [fileNotes, setFileNotes] = useState<string[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // 解析が終わって入力欄から離れたら、加工した文章に場所を譲るため2行ぶんに畳む
  const [editing, setEditing] = useState(false);
  const [reading, setReading] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function onImport() {
    setMessage(null);
    setFileNotes([]);
    try {
      const tab = await getActiveTab();
      if (!tab) throw new Error();
      const selected = await importSelection(tab.id);
      if (!selected.trim()) setMessage('ページで文章を選んでから押してください。');
      else setText(selected);
    } catch {
      setMessage('このページの選択文は読めません。コピーして貼り付けてください。');
    }
  }

  // Excel・CSV はこの画面の中で読み、セルの文字だけを入力欄に入れる（Issue #10）
  // PDF はページ上の文字を取り出して、ふつうの文章として入力欄に入れる（Issue #9）
  async function onFile(file: File | undefined) {
    if (!file) return;
    setMessage(null);
    setFileNotes([]);
    if (file.name.toLowerCase().endsWith(PDF_EXTENSION)) {
      await onPdf(file);
      return;
    }
    if (isImageFile(file.name)) {
      await onImage(file);
      return;
    }
    try {
      const { text: imported, notes, source } = await readSpreadsheetFile(file);
      if (!imported.trim()) setMessage('ファイルに文字の入ったセルがありませんでした。');
      else {
        importFile(source);
        // ファイル名は上のカードに出るので、注意書きだけを並べる
        setFileNotes(notes);
      }
    } catch (e) {
      setMessage(e instanceof SpreadsheetError ? e.message : 'ファイルを読めませんでした。');
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  // PDF は形を保ったまま加工できるよう、文字の出どころを記録して取り込む。画像の中の文字は OCR で読む（Issue #9）
  async function onPdf(file: File) {
    const sessionId = useStore.getState().sessionId;
    setReading(true);
    setProgress('PDF を読み込み中…');
    try {
      if (file.size > MAX_PDF_BYTES) throw new PdfError(`ファイルが大きすぎます（上限 ${MAX_PDF_BYTES / 1024 / 1024}MB）。`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { openPdfEnv } = await import('../../infra/pdf/browser');
      const { importPdf } = await import('../../infra/pdf/document');
      const env = await openPdfEnv();
      try {
        const src = await importPdf(file.name, bytes, env.images, (done, total) => setProgress(`画像の文字を読み取り中（${done}/${total}）…`));
        if (useStore.getState().sessionId !== sessionId) return;
        importFile(src);
        setFileNotes([
          `「${file.name}」（${src.pageCount} ページ）の文字${src.images.some((i) => i.ocr) ? 'と画像の中の文字' : ''}を取り込みました。`,
          ...(src.blockers.length ? ['PDF の形では保存できません。理由は手順 3 に出ます。'] : []),
          ...src.notes,
        ]);
      } finally {
        await env.dispose();
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'PdfImportError') await onPdfTextOnly(file, e.message);
      else setMessage(e instanceof PdfError ? e.message : 'PDF を読めませんでした。');
    } finally {
      setReading(false);
      setProgress(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  // 画像は中の文字を端末内の OCR で読み、文字の位置を記録して取り込む。加工後は塗りつぶしてラベルを書いた画像で保存できる（Issue #11）
  async function onImage(file: File) {
    const sessionId = useStore.getState().sessionId;
    setReading(true);
    setProgress('画像の文字を読み取り中…');
    try {
      const { openImageEnv } = await import('../../infra/image/browser');
      const { importImage } = await import('../../infra/image/image');
      const env = await openImageEnv();
      try {
        const src = await importImage(file.name, new Uint8Array(await file.arrayBuffer()), env);
        if (useStore.getState().sessionId !== sessionId) return;
        importFile(src);
        setFileNotes([`「${file.name}」（${src.width}×${src.height}）を取り込みました。`, ...src.notes]);
      } finally {
        await env.dispose();
      }
    } catch (e) {
      setMessage(e instanceof Error && e.name === 'ImageImportError' ? e.message : '画像を読めませんでした。');
    } finally {
      setReading(false);
      setProgress(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  /** PDF の形では扱えないとき（暗号化など）は、文字だけを取り出す */
  async function onPdfTextOnly(file: File, reason: string) {
    try {
      const { text: imported, notes, pageCount } = await readPdfFile(file);
      setText(imported);
      setFileNotes([`「${file.name}」（${pageCount} ページ）の文字を取り込みました。`, `${reason}加工結果は文章として出力します。`, ...notes]);
    } catch (e) {
      setMessage(e instanceof PdfError ? e.message : 'PDF を読めませんでした。');
    }
  }

  function onDrop(e: DragEvent<HTMLElement>) {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    void onFile(e.dataTransfer.files[0]);
  }

  function onReset() {
    setMessage(null);
    setFileNotes([]);
    reset();
  }

  return (
    <section className="panel input-panel" aria-labelledby="input-title">
      <div className="step-heading">
        <span className="step-num" aria-hidden="true">1</span>
        <h2 id="input-title">文章を入れる</h2>
        <span className="step-meta">{fileSource ? fileSummary(fileSource) : text ? `${text.length.toLocaleString()} 文字` : ''}</span>
        {text && (
          <button type="button" className="ghost clear-button" onClick={() => setConfirmOpen(true)}>
            削除
          </button>
        )}
      </div>
      {fileSource ? (
        <div
          className="file-card"
          aria-label="読み込んだファイル"
          onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
          onDrop={onDrop}
        >
          <Icon name="file" />
          <div>
            <p className="file-name">{fileSource.fileName}</p>
            <p className="hint">{fileSource.kind === 'pdf' ? 'ページと画像の中の文字を検査' : fileSource.kind === 'image' ? '画像の中の文字と顔を検査' : 'セルの内容を検査'}</p>
          </div>
        </div>
      ) : (
        <textarea
          className={`input ${text.trim() && !editing ? 'collapsed' : ''}`}
          value={text}
          onFocus={() => setEditing(true)}
          onBlur={(e) => {
            e.currentTarget.scrollTop = 0;
            collapseAfterClick(() => setEditing(false));
          }}
          onChange={(e) => setText(e.target.value)}
          onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
          onDrop={onDrop}
          placeholder="文章を貼り付け（Excel・CSV・PDF・画像はドロップ）"
          rows={3}
          aria-label="解析する文章"
        />
      )}
      <div className="row input-actions">
        <button type="button" className="ghost" onClick={onImport}>
          <Icon name="import" />
          選択文を取り込む
        </button>
        <button type="button" className="ghost" onClick={() => fileInput.current?.click()} disabled={reading}>
          <Icon name="file" />
          {reading ? '読込中…' : fileSource ? '別のファイルを読込' : 'ファイルを読込'}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept={[...ACCEPTED_EXTENSIONS, PDF_EXTENSION, ...IMAGE_EXTENSIONS].join(',')}
          hidden
          aria-label="読み込む Excel・CSV・PDF・画像ファイル"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title="文章を削除しますか？"
        body="文章・加工結果・復元した回答を消します。元に戻せません。"
        confirmLabel="削除する"
        onConfirm={onReset}
        onClose={() => setConfirmOpen(false)}
      />
      {progress && <p className="hint" role="status">{progress}</p>}
      {message && <p className="hint warn">{message}</p>}
      {fileNotes.length > 0 && (
        <ul className="hint file-notes" aria-label="ファイルの取込結果">
          {fileNotes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 入力欄から離れたときに畳むのは、そのクリックが終わってからにする。
 * 押し下げた瞬間に畳むと画面が上にずれ、指を離した位置が別のボタンになってクリックが外れるため。
 */
function collapseAfterClick(collapse: () => void) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    window.removeEventListener('pointerup', finish, true);
    window.clearTimeout(timer);
    window.setTimeout(collapse, 0);
  };
  // キーボードで移ったときは pointerup が来ないので、少し待って畳む
  const timer = window.setTimeout(finish, 400);
  window.addEventListener('pointerup', finish, true);
}

function fileSummary(source: FileSource): string {
  if (source.kind === 'csv') return 'CSV';
  if (source.kind === 'pdf') return `PDF・${source.pageCount} ページ`;
  if (source.kind === 'image') return `画像・${source.width}×${source.height}`;
  const cells = source.sheets.reduce((n, s) => n + s.cells.length, 0);
  return `${source.sheets.length} シート・${cells.toLocaleString()} セル`;
}
