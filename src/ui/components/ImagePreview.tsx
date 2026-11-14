import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { ImageRect, ImageSource } from '../../infra/image/image';
import { useStore } from '../store';

/**
 * 加工後の画像の仕上がりを確かめる（Issue #11）。PDF の仕上がりの確認（PdfPreview）と同じ操作で、
 * OCR の読み間違いで隠しきれていない所は、画像の上をドラッグして四角形で隠せる。
 */
export function ImagePreview({ source }: { source: ImageSource }) {
  const result = useStore((s) => s.result);
  const rects = useStore((s) => s.imageRects);
  const setImageRects = useStore((s) => s.setImageRects);
  const keptFaces = useStore((s) => s.keptFaces);
  const [url, setUrl] = useState<string | null>(null);
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
        const { openImageEnv, pngUrl } = await import('../../infra/image/browser');
        const { exportMaskedImage } = await import('../../infra/image/image');
        const env = await openImageEnv({ ocr: false });
        try {
          const out = await exportMaskedImage(source, result.segments, env, rects, keptFaces);
          if (cancelled) return;
          shown.current = key;
          setUrl(pngUrl(out.bytes));
        } finally {
          await env.dispose();
        }
      } catch (e) {
        if (!cancelled) setMessage(e instanceof Error && e.message ? e.message : '仕上がりを表示できませんでした。');
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, key, result, source, rects, keptFaces]);

  // 表示を差し替えたら、前の画像の URL を解放する（原文の一部を含みうるため長く残さない）
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  return (
    <details className="pdf-preview" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>画像の仕上がりを確認</summary>
      <p className="hint">隠れていない所や顔は、ドラッグで囲むと塗りつぶします。</p>
      {busy && <p className="hint" role="status">仕上がりを作っています…</p>}
      {message && <p className="hint warn">{message}</p>}
      {rects.length > 0 && (
        <ul className="hint file-notes" aria-label="手動で隠す四角形">
          {rects.map((_, i) => (
            <li key={i}>
              四角形 {i + 1}
              <button type="button" className="link" onClick={() => setImageRects(rects.filter((_, k) => k !== i))}>
                取り消す
              </button>
            </li>
          ))}
        </ul>
      )}
      {url && (
        <div className="pdf-pages">
          <DrawableImage url={url} width={source.width} height={source.height} onRect={(r) => setImageRects([...rects, r])} />
        </div>
      )}
    </details>
  );
}

function DrawableImage({ url, width, height, onRect }: { url: string; width: number; height: number; onRect: (r: ImageRect) => void }) {
  const [drag, setDrag] = useState<ImageRect | null>(null);
  const box = useRef<HTMLDivElement>(null);
  // 表示の座標を、画像の画素に直す
  const local = (e: PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * width, ((e.clientY - r.top) / r.height) * height] as const;
  };
  return (
    <div
      ref={box}
      className="pdf-page"
      aria-label="画像の仕上がり"
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
        const minW = width / 100;
        const minH = height / 100;
        if (drag && Math.abs(drag.x1 - drag.x0) > minW && Math.abs(drag.y1 - drag.y0) > minH) {
          onRect({ x0: Math.min(drag.x0, drag.x1), y0: Math.min(drag.y0, drag.y1), x1: Math.max(drag.x0, drag.x1), y1: Math.max(drag.y0, drag.y1) });
        }
        setDrag(null);
      }}
    >
      <img src={url} alt="" draggable={false} />
      {drag && (
        <span
          className="pdf-drag"
          style={{
            left: `${(Math.min(drag.x0, drag.x1) / width) * 100}%`,
            top: `${(Math.min(drag.y0, drag.y1) / height) * 100}%`,
            width: `${(Math.abs(drag.x1 - drag.x0) / width) * 100}%`,
            height: `${(Math.abs(drag.y1 - drag.y0) / height) * 100}%`,
          }}
        />
      )}
    </div>
  );
}
