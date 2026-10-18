import { useEffect, useRef } from 'react';

/** 取り消せない操作の前に出す確認。ネイティブ dialog でフォーカスの閉じ込めと Escape を扱う。 */
export function ConfirmDialog({ open, title, body, confirmLabel, onConfirm, onClose }: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog?.open) dialog?.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);

  return (
    <dialog ref={ref} className="confirm-dialog" aria-labelledby="confirm-title" aria-describedby="confirm-body" onCancel={onClose} onClose={onClose}>
      <h2 id="confirm-title">{title}</h2>
      <p id="confirm-body">{body}</p>
      <div className="confirm-actions">
        <button type="button" onClick={onClose} autoFocus>キャンセル</button>
        <button type="button" className="danger" onClick={() => { onConfirm(); onClose(); }}>{confirmLabel}</button>
      </div>
    </dialog>
  );
}
