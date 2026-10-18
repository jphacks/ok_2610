import { useEffect, useRef, type KeyboardEvent } from 'react';
import { ConditionsPanel } from './ConditionsPanel';
import { SettingsPanel } from './SettingsPanel';
import { Icon } from './Icon';

export type SettingsSection = 'preferences' | 'conditions';

/** 日常の作業から設定を分離。ネイティブ dialog でフォーカス制御と Escape を扱う。 */
export function SettingsDialog({ open, section, onSection, onClose }: {
  open: boolean;
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (open && !dialog?.open) dialog?.showModal();
    if (!open && dialog?.open) dialog.close();
  }, [open]);

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
        <div><span className="eyebrow">PREFERENCES</span><h2 id="settings-dialog-title">設定</h2></div>
        <button type="button" className="icon-button ghost" onClick={onClose} aria-label="設定を閉じる" autoFocus><Icon name="close" /></button>
      </div>
      <nav className="settings-tabs" aria-label="設定の種類">
        <button type="button" aria-pressed={section === 'preferences'} onClick={() => onSection('preferences')}>加工の設定</button>
        <button type="button" aria-pressed={section === 'conditions'} onClick={() => onSection('conditions')}>利用条件</button>
      </nav>
      <div className="settings-content">
        <div hidden={section !== 'preferences'}><SettingsPanel /></div>
        <div hidden={section !== 'conditions'}><ConditionsPanel expanded /></div>
      </div>
      <div className="settings-bottom"><span className="hint">変更は自動で反映されます</span><button type="button" className="primary" onClick={onClose}>文章に戻る</button></div>
    </dialog>
  );
}
