import { useRef, useState, type DragEvent } from 'react';
import { ACCEPTED_EXTENSIONS, readSpreadsheetFile, SpreadsheetError, type SpreadsheetSource } from '../../infra/spreadsheet';
import { getActiveTab, importSelection } from '../../infra/tabs';
import { useStore } from '../store';
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
  const fileInput = useRef<HTMLInputElement>(null);

  async function onImport() {
    setMessage(null);
    setFileNotes([]);
    try {
      const tab = await getActiveTab();
      if (!tab) throw new Error();
      const selected = await importSelection(tab.id);
      if (!selected.trim()) setMessage('ページで文章を選択してから押してください。');
      else setText(selected);
    } catch {
      setMessage('このページの選択テキストは読めませんでした。文章をコピーして貼り付けてください。');
    }
  }

  // Excel・CSV はこの画面の中で読み、セルの文字だけを入力欄に入れる（Issue #10）
  async function onFile(file: File | undefined) {
    if (!file) return;
    setMessage(null);
    setFileNotes([]);
    try {
      const { text: imported, notes, source } = await readSpreadsheetFile(file);
      if (!imported.trim()) setMessage('ファイルに文字の入ったセルがありませんでした。');
      else {
        importFile(source);
        setFileNotes([`「${file.name}」を取り込みました。`, ...notes]);
      }
    } catch (e) {
      setMessage(e instanceof SpreadsheetError ? e.message : 'ファイルを読めませんでした。');
    } finally {
      if (fileInput.current) fileInput.current.value = '';
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
      <div className="section-heading">
        <div>
          <h2 id="input-title">{fileSource ? '元のファイル' : '元の文章'}</h2>
        </div>
        <span className="text-count">{fileSource ? fileSummary(fileSource) : `${text.length.toLocaleString()} 文字`}</span>
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
            <p className="hint">セルの内容を検査しています。結果は下の表で確認できます。</p>
          </div>
        </div>
      ) : (
        <textarea
          className="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
          onDrop={onDrop}
          placeholder="文章を貼り付け、またはExcel・CSVをドロップ"
          rows={3}
          aria-label="解析する文章"
        />
      )}
      <div className="row">
        <button type="button" onClick={onImport}>
          <Icon name="import" />
          選択文を取り込む
        </button>
        <button type="button" onClick={() => fileInput.current?.click()}>
          <Icon name="file" />
          {fileSource ? '別のファイルを読込' : 'Excel・CSV を読込'}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPTED_EXTENSIONS.join(',')}
          hidden
          aria-label="読み込む Excel・CSV ファイル"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <button type="button" className="ghost clear-button" onClick={() => setConfirmOpen(true)} disabled={!text}>
          削除
        </button>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title="文章を削除しますか？"
        body="入力した文章、加工結果、復元した回答をこの画面から消します。元に戻せません。"
        confirmLabel="削除する"
        onConfirm={onReset}
        onClose={() => setConfirmOpen(false)}
      />
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

function fileSummary(source: SpreadsheetSource): string {
  if (source.kind === 'csv') return 'CSV';
  const cells = source.sheets.reduce((n, s) => n + s.cells.length, 0);
  return `${source.sheets.length} シート・${cells.toLocaleString()} セル`;
}
