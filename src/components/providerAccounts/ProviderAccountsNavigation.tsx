import { Cpu, Layers, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useProviderAccountsStore } from '../../services/providerAccounts/store';
import { ACCOUNT_PROVIDERS } from '../../services/providerAccounts/types';
import { isTauriRuntime } from '../../services/runtime';

export function ProviderAccountsNavigation({ store = useProviderAccountsStore }: { store?: typeof useProviderAccountsStore }) {
  const { t } = useTranslation();
  const filter = store((state) => state.providerFilter);
  const selectProvider = store((state) => state.selectProvider);
  const addOpen = store((state) => state.providerToAdd !== null);
  const canAdd = store((state) => state.loaded && state.cardsLoaded && !state.loading && !state.savingCards);

  return <>
    <div className="nav-bar-header"><div className="nav-bar-toolbar">
      <button id="provider-accounts-add-button" type="button" className="ui-button nav-header-action"
        disabled={!isTauriRuntime() || !canAdd} aria-expanded={addOpen}
        aria-controls={addOpen ? 'provider-accounts-add-form' : undefined}
        onClick={() => { if (addOpen) store.getState().setProviderToAdd(null); else store.getState().openAddForm(); }}>
        <Plus aria-hidden="true" /><span>{t('providerAccounts.addAccount')}</span>
      </button>
    </div></div>
    <div className="scope-tabs provider-accounts-scope-tabs">
      <button type="button" className="ui-list-row scope-tab" aria-current={filter === null ? 'page' : undefined}
        onClick={() => selectProvider(null)}>
        <Layers aria-hidden="true" /><span>{t('providerAccounts.dashboard')}</span>
      </button>
      {ACCOUNT_PROVIDERS.map((provider) => <button key={provider.id} type="button" className="ui-list-row scope-tab"
        aria-current={filter === provider.id ? 'page' : undefined} onClick={() => selectProvider(provider.id)}>
        <Cpu aria-hidden="true" /><span>{provider.name}</span>
      </button>)}
    </div>
  </>;
}
