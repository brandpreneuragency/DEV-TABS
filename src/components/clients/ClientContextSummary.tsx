import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { Globe, Mail, Phone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ClientRecordsAdapter } from '../../hooks/useClientAutosave';
import type { ClientContact, ClientProfile } from '../../types/clients';

type ContextState =
  | { clientId: string; status: 'loading' | 'error' }
  | { clientId: string; status: 'ready'; profile: ClientProfile | null; contacts: ClientContact[] };

export function ClientContextSummary({ clientId, records, onProfile }: {
  clientId: string;
  records: ClientRecordsAdapter;
  onProfile?: () => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<ContextState>({ clientId, status: 'loading' });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    const subscription = liveQuery(async () => {
      const [profile, contacts] = await Promise.all([records.getProfile(clientId), records.listContacts(clientId)]);
      return profile.ok && contacts.ok
        ? { clientId, status: 'ready' as const, profile: profile.value, contacts: contacts.value }
        : { clientId, status: 'error' as const };
    }).subscribe({
      next: (result) => { if (active) setState(result); },
      error: () => { if (active) setState({ clientId, status: 'error' }); },
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, [clientId, records, retry]);
  const visible = state.clientId === clientId ? state : { clientId, status: 'loading' as const };
  const profile = visible.status === 'ready' ? visible.profile : null;
  const primary = visible.status === 'ready'
    ? visible.contacts.find((contact) => contact.id === profile?.primaryContactId && contact.clientId === clientId && !contact.deletedAt)
    : null;

  return <section className="ui-card clients-overview-section" aria-label={t('clients.clientContext')}>
    <div className="clients-overview-section-heading">
      <h2>{t('clients.clientContext')}</h2>
      {onProfile && <button type="button" className="ui-button clients-link-button" onClick={onProfile}>{t('clients.profile')}</button>}
    </div>
    {visible.status === 'loading' ? <p className="clients-muted" role="status">{t('clients.loading')}</p>
      : visible.status === 'error' ? <div className="clients-action-error">
        <p className="clients-error" role="alert">{t('clients.loadFailed')}</p>
        <button type="button" className="ui-button clients-button" onClick={() => setRetry((value) => value + 1)}>{t('clients.retry')}</button>
      </div> : <>
        <p className="clients-context-description">{profile?.description || t('clients.contextHint')}</p>
        {profile?.website && <p className="clients-context-line"><Globe aria-hidden="true" /><span>{profile.website}</span></p>}
        <div className="clients-context-contact">
          <span className="clients-muted">{t('clients.primaryContact')}</span>
          {primary ? <>
            <strong>{primary.name}</strong>
            {primary.role && <span className="clients-muted">{primary.role}</span>}
            {primary.email && <p className="clients-context-line"><Mail aria-hidden="true" /><span>{primary.email}</span></p>}
            {primary.phone && <p className="clients-context-line"><Phone aria-hidden="true" /><span>{primary.phone}</span></p>}
          </> : <p className="clients-muted">{t('clients.noPrimaryContact')}</p>}
        </div>
      </>}
  </section>;
}
