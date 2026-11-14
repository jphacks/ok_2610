import { useEffect, useRef, type KeyboardEvent } from 'react';
import { MESSAGES } from '../../core/explain/messages';
import { ConditionsPanel } from './ConditionsPanel';
import { SettingsPanel } from './SettingsPanel';
import { UsageNotice } from './UsageNotice';
import { Icon } from './Icon';
import './settings.css';

export type SettingsSection = 'preferences' | 'conditions';

/**
 * 日常の作業から設定を分離。ネイティブ dialog でフォーカス制御と Escape を扱う。
 * タブで隠さず1枚に並べ、いまの設定がひと目で分かるようにする（加工の設定 → 利用条件 → 注意点）。
 * section は開いたときにどこを見せるか。onSection は呼び出し側との互換のために受け取る。
 */
export function SettingsDialog({ open, section, onClose }: {
  open: boolean;
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const conditionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog?.open) dialog?.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    if (section === 'conditions') conditionsRef.current?.scrollIntoView({ block: 'start' });
    else contentRef.current?.scrollTo({ top: 0 });
  }, [open, section]);

  function keepFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab') return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button, input, select, textarea, summary, a[href], [tabindex]')]
      .filter(el => el.tabIndex >= 0 && !el.matches(':disabled') && el.getClientRects().length > 0);
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }

  return (
    <dialog ref={ref} className="settings-dialog" aria-labelledby="settings-dialog-title" onCancel={onClose} onClose={onClose} onKeyDown={keepFocus}>
      <div className="settings-header">
        <h2 id="settings-dialog-title">設定</h2>
        <button type="button" className="icon-button ghost" onClick={onClose} aria-label="設定を閉じる" autoFocus><Icon name="close" /></button>
      </div>
      <div className="settings-content" ref={contentRef}>
        <SettingsPanel />
        <div ref={conditionsRef} className="settings-group">
          <ConditionsPanel />
        </div>
        <UsageNotice open={open} />
        {/* 限界の明示（FR-09, FR-17）は作業画面から外し、ここで読めるようにする */}
        <details className="settings-advanced">
          <summary>データの扱いと注意点</summary>
          <ul>{[MESSAGES.sessionScope, MESSAGES.clipboardNote, MESSAGES.noGuarantee, MESSAGES.externalNotChecked].map((m) => <li key={m}>{m}</li>)}</ul>
        </details>
      </div>
      <div className="settings-bottom">
        <span className="hint">変更はすぐ反映されます</span>
        <button type="button" className="primary" onClick={onClose}>文章に戻る</button>
      </div>
    </dialog>
  );
}
