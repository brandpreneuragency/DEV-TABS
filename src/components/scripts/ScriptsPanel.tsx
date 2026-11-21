import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export function ScriptsPanel({ title, onClose, children, dialog = false }: {
  title: string; onClose: () => void; children: ReactNode; dialog?: boolean;
}) {
  const { t } = useTranslation();
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const previous = document.activeElement;
    const element = ref.current;
    if (!element) return;
    const controls = () => Array.from(element.querySelectorAll<HTMLElement>('*')).filter((node) =>
      node.matches('button, input, textarea, select, summary, [tabindex="0"]') && !node.matches(':disabled')
      && (!node.closest('details:not([open])') || node.tagName === 'SUMMARY'));
    (element.querySelector<HTMLElement>('[data-initial-focus]') ?? controls()[0] ?? element).focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
      if (!dialog || event.key !== 'Tab') return;
      const items = controls();

      const first = items[0]; const last = items[items.length - 1];
      if (!first) { event.preventDefault(); element.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    };
    element.addEventListener('keydown', keydown);
    return () => {
      element.removeEventListener('keydown', keydown);
      if (previous instanceof HTMLElement && previous.isConnected && !previous.closest('[hidden], [inert]')) previous.focus();
    };
  }, [dialog]);
  return <section ref={ref} className="scripts-detail-panel" role={dialog ? 'dialog' : 'region'}
      aria-labelledby={id} tabIndex={-1}>
      <header className="scripts-panel-header"><h2 id={id}>{title}</h2>
        <button className="ui-icon-button scripts-button" type="button" aria-label={t('scripts.close')} onClick={onClose}><X /></button>
      </header>
      {children}
    </section>;
}
