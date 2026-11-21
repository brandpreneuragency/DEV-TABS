import type { CSSProperties } from 'react';
import { ArrowUpRight, Building2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { selectClientPortfolio } from '../../services/clients/selectors';

type Portfolio = ReturnType<typeof selectClientPortfolio>;

export function ClientDirectory({ entries, query, notesStatus, onSelect }: {
  entries: Portfolio;
  query: string;
  notesStatus: 'loading' | 'error' | 'ready';
  onSelect: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const normalized = query.trim().toLocaleLowerCase(i18n.language);
  const visible = entries.filter(({ client }) => client.name.toLocaleLowerCase(i18n.language).includes(normalized));
  return <section className="clients-directory" aria-label={t('clients.directory')}>
    <div className="clients-overview-section-heading">
      <h2>{t('clients.directory')}</h2>
      <span className="clients-muted">{t('clients.directoryCount', { shown: visible.length, total: entries.length })}</span>
    </div>
    {!visible.length ? <p className="clients-empty-state">{t(normalized ? 'clients.noMatchingClients' : 'clients.directoryEmpty')}</p>
      : <div className="clients-directory-grid">
        {visible.map(({ client, work, lastContact }) => <button key={client.id} type="button"
          className="ui-list-row clients-directory-card" aria-label={t('clients.openClient', { name: client.name })}
          onClick={() => onSelect(client.id)}>
          <span className="clients-summary-title">
            <Building2 className="clients-client-mark" style={{ '--client-color': client.color } as CSSProperties} aria-hidden="true" />
            <strong>{client.name}</strong><ArrowUpRight className="clients-row-arrow" aria-hidden="true" />
          </span>
          <span className="clients-row-meta">
            <span>{t('clients.projectCount', { count: work.projects.length })}</span>
            <span>{t('clients.openCount', { count: work.open })}</span>
            {work.overdue > 0 && <span className="clients-overdue">{t('clients.overdueCount', { count: work.overdue })}</span>}
          </span>
          <span className="clients-directory-contact">
            <span className="clients-muted">{t('clients.lastContact')}</span>
            {notesStatus !== 'ready' ? <span className="clients-muted">{t(notesStatus === 'loading' ? 'clients.loading' : 'clients.contactUnavailable')}</span>
              : lastContact ? <>
                <span className="clients-preview-text">{lastContact.title || t('clients.untitledNote')}</span>
                <span className="clients-muted">{new Date(lastContact.occurredAt).toLocaleDateString(i18n.language, { day: 'numeric', month: 'short', year: 'numeric' })}</span>
              </> : <span className="clients-muted">{t('clients.noRecordedContact')}</span>}
          </span>
        </button>)}
      </div>}
  </section>;
}
