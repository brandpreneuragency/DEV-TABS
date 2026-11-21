import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

/** Notes-local accessible overlay, using the app's existing confirmation surfaces. */
export function NotesDialog({ title, children, onClose, alert = false, anchorRef, placement = 'bottom' }: {
  title: string; children: ReactNode; onClose: () => void; alert?: boolean; anchorRef?: RefObject<HTMLElement | null>;
  placement?: 'top' | 'bottom';
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!anchorRef) return;
    const reposition = () => {
      const anchor = anchorRef.current;
      const dialog = ref.current;
      if (!anchor || !dialog) return;
      const bounds = anchor.getBoundingClientRect();
      const size = dialog.getBoundingClientRect();
      const left = Math.max(8, Math.min(bounds.left, window.innerWidth - size.width - 8));
      const below = bounds.bottom + 8;
      const above = bounds.top - size.height - 8;
      const preferred = placement === 'top'
        ? (above >= 8 ? above : below)
        : (below + size.height <= window.innerHeight - 8 ? below : above);
      const top = Math.max(8, Math.min(
        preferred,
        window.innerHeight - size.height - 8,
      ));
      dialog.style.left = `${left}px`;
      dialog.style.top = `${top}px`;
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [anchorRef, placement]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLElement>('[data-autofocus], button, input')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div className={`confirm-overlay notes-dialog-overlay${anchorRef ? ' notes-dialog-overlay--anchored' : ''}`} onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div ref={ref} className="ui-panel-body confirm-box notes-dialog" role={alert ? 'alertdialog' : 'dialog'}
      aria-modal="true" aria-label={title} onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); onClose(); }
        if (event.key !== 'Tab') return;
        const elements = ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]');
        if (!elements?.length) return;
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <h2>{title}</h2>
      {children}
    </div>
  </div>, document.body);
}

export function NotesConfirmation({ title, message, confirmLabel, onConfirm, onClose, anchorRef }: {
  title: string; message: string; confirmLabel: string; onConfirm: () => Promise<void>; onClose: () => void;
  anchorRef?: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const busy = useRef(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  return <NotesDialog title={title} onClose={() => { if (!busy.current) onClose(); }} alert anchorRef={anchorRef} placement="top">
    <p>{message}</p>
    {failed && <p role="alert" className="notes-danger">{t('notes.error_storage')}</p>}
    <div className="notes-dialog-actions">
      <button type="button" className="ui-button notes-button" data-autofocus disabled={saving} onClick={() => { if (!busy.current) onClose(); }}>{t('notes.cancel')}</button>
      <button type="button" className="ui-button ui-button--danger notes-button notes-button--danger" disabled={saving} onClick={() => {
        if (busy.current) return;
        busy.current = true;
        setSaving(true); setFailed(false);
        void onConfirm().then(onClose).catch(() => setFailed(true)).finally(() => { busy.current = false; setSaving(false); });
      }}>{saving ? t('notes.saving') : confirmLabel}</button>
    </div>
  </NotesDialog>;
}
