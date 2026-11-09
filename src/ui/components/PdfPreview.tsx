import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { PdfSource } from '../../infra/pdf/document';
import type { PdfRect } from '../../infra/pdf/mask';
import { useStore } from '../store';

/**
 * 加工後の PDF の仕上がりを、ページの画像で確かめる（Issue #9）。
 * OCR の読み間違いで隠しきれていない画像の部分は、ページの上をドラッグして四角形で隠せる。
 */
export function PdfPreview({ source }: { source: PdfSource }) {
  const result = useStore((s) => s.result);
  const rects = useStore((s) => s.pdfRects);
  const setPdfRects = useStore((s) => s.setPdfRects);
  const keptFaces = useStore((s) => s.keptFaces);
  const [pages, setPages] = useState<Awaited<ReturnType<typeof import('../../infra/pdf/browser').renderPdfPages>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const key = `${result?.contentId ?? ''}|${result?.masked.length ?? 0}|${JSON.stringify(rects)}|${keptFaces.join(',')}`;
  const shown = useRef<string | null>(null);

  useEffect(() => {
    if (!open || !result || shown.current === key) return;
    let cancelled = false;
    void (async () => {
      setBusy(true);
      setMessage(null);
      try {
        const { openPdfEnv, renderPdfPages } = await import('../../infra/pdf/browser');
        const { exportMaskedPdf } = await import('../../infra/pdf/mask');
        const env = await openPdfEnv({ ocr: false });
        try {
          const out = await exportMaskedPdf(source, result.segments, env, rects, keptFaces);
          const rendered = await renderPdfPages(out.bytes, 360, 30);
          if (cancelled) return;
          shown.current = key;
          setPages(rendered);
          if (source.pageCount > rendered.length) setMessage(`最初の ${rendered.length} ページを表示しています。`);
        } finally {
          await env.dispose();
        }
      } catch (e) {
        if (!cancelled) setMessage(e instanceof Error ? e.message : '仕上がりを表示できませんでした。');
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, key, result, source, rects, keptFaces]);

  return (
    <details className="pdf-preview" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>PDF の仕上がりを確認</summary>
      <p className="hint">
        画像の中で隠しきれていない所は、ページの上をドラッグして四角形で囲むと、その部分を塗りつぶします（画像の部分だけに効きます。文字は「手動でマスク」をお使いください）。
      </p>
      {busy && <p className="hint" role="status">仕上がりを作っています…</p>}
      {message && <p className="hint warn">{message}</p>}
      {rects.length > 0 && (
        <ul className="hint file-notes" aria-label="手動で隠す四角形">
          {rects.map((r, i) => (
            <li key={i}>
              {r.page + 1} ページの四角形 {i + 1}
              <button type="button" className="link" onClick={() => setPdfRects(rects.filter((_, k) => k !== i))}>
                取り消す
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="pdf-pages">
        {pages?.map((p, i) => (
          <PageImage key={`${key}:${i}`} page={p} index={i} onRect={(r) => setPdfRects([...rects, r])} />
        ))}
      </div>
    </details>
  );
}

type Rendered = { url: string; width: number; height: number; toPdf: (x: number, y: number) => [number, number] };

function PageImage({ page, index, onRect }: { page: Rendered; index: number; onRect: (r: PdfRect) => void }) {
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const local = (e: PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const sx = page.width / r.width;
    return [(e.clientX - r.left) * sx, (e.clientY - r.top) * sx] as const;
  };
  return (
    <div
      ref={box}
      className="pdf-page"
      aria-label={`${index + 1} ページの仕上がり`}
      onPointerDown={(e) => {
        const [x, y] = local(e);
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        setDrag({ x0: x, y0: y, x1: x, y1: y });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const [x, y] = local(e);
        setDrag({ ...drag, x1: x, y1: y });
      }}
      onPointerUp={() => {
        if (drag && Math.abs(drag.x1 - drag.x0) > 4 && Math.abs(drag.y1 - drag.y0) > 4) {
          const [ax, ay] = page.toPdf(drag.x0, drag.y0);
          const [bx, by] = page.toPdf(drag.x1, drag.y1);
          onRect({ page: index, x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) });
        }
        setDrag(null);
      }}
    >
      <img src={page.url} alt="" draggable={false} />
      {drag && (
        <span
          className="pdf-drag"
          style={{
            left: `${(Math.min(drag.x0, drag.x1) / page.width) * 100}%`,
            top: `${(Math.min(drag.y0, drag.y1) / page.height) * 100}%`,
            width: `${(Math.abs(drag.x1 - drag.x0) / page.width) * 100}%`,
            height: `${(Math.abs(drag.y1 - drag.y0) / page.height) * 100}%`,
          }}
        />
      )}
    </div>
  );
}
