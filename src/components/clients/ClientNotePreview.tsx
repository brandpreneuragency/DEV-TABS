import { CalendarDays, Phone, Pin, StickyNote, CircleCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ClientNote } from '../../types/clients';

const noteKinds = {
  call: { icon: Phone, label: 'clients.kindCall' },
  meeting: { icon: CalendarDays, label: 'clients.kindMeeting' },
  decision: { icon: CircleCheck, label: 'clients.kindDecision' },
  note: { icon: StickyNote, label: 'clients.kindNote' },
} as const;

export function ClientNotePreview({ note, clientName, onOpen }: {
  note: ClientNote;
  clientName?: string;
  onOpen: (note: ClientNote) => void;
}) {
  const { t, i18n } = useTranslation();
  const { icon: Icon, label } = noteKinds[note.kind];
  const date = new Date(note.occurredAt);
  const validDate = Number.isFinite(date.getTime());
  return <button type="button" className="ui-list-row clients-summary-row clients-note-preview"
    aria-label={t('clients.openNote', { title: note.title || t('clients.untitledNote') })} onClick={() => onOpen(note)}>
    <span className="clients-summary-title"><Icon aria-hidden="true" />
      <span>{note.title || t('clients.untitledNote')}</span>
      {note.pinned && <Pin aria-label={t('clients.pinnedLabel')} />}
    </span>
    {note.bodyText && <span className="clients-preview-text">{note.bodyText}</span>}
    <span className="clients-row-meta">
      <span>{t(label)}</span>
      {clientName && <span>{clientName}</span>}
      {note.contactSnapshot?.name && <span>{note.contactSnapshot.name}</span>}
      {validDate && <time dateTime={date.toISOString()} title={date.toLocaleString(i18n.language)}>
        {date.toLocaleDateString(i18n.language, { day: 'numeric', month: 'short', year: 'numeric' })}
      </time>}
    </span>
  </button>;
}
