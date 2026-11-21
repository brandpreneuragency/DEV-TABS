import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { db } from '../../services/db';
import { setAllProviderModelsVisible, setProviderModelVisible, useProviderModelVisibility, visibleProviderModels } from '../../services/providers/modelVisibility';
import { useOpenCodeStore } from '../../stores/openCodeStore';

export function OpenCodeSettingsPanel() {
  const { t } = useTranslation();
  const { models, agents, connection, detail, start, refresh } = useOpenCodeStore();
  const visibility = useProviderModelVisibility('openCode');
  const [modelId, setModelId] = useState('');
  const [agentId, setAgentId] = useState('');
  const shown = visibleProviderModels(models.filter((model) => model.enabled), visibility ?? { allHidden: false, hiddenModelIds: [] });
  useEffect(() => {
    void start().catch(() => undefined);
    void Promise.all([db.settings.get('openCodeModelId'), db.settings.get('openCodeAgentId')]).then(([model, agent]) => {
      setModelId(typeof model?.value === 'string' ? model.value : '');
      setAgentId(typeof agent?.value === 'string' ? agent.value : '');
    });
  }, [start]);
  const allModels = models.filter((model) => model.enabled);
  return <div className="codex-provider-detail codex-provider-detail--open-code ui-page-body"><div className="codex-provider-detail__inner">
    <header className="codex-provider-header"><div className="codex-provider-header__copy"><h2>OpenCode</h2></div>
      <span className={`codex-status-badge${connection === 'connected' ? ' codex-status-badge--connected' : ''}`} role="status">{detail ?? connection}</span>
    </header>
    {connection !== 'connected' && connection !== 'degraded' && <section className="codex-card ui-card"><p className="codex-inline-notice" role="status">{detail ?? t('cliProviders.status.desktopOnly')}</p><button className="ui-button" type="button" onClick={() => void refresh()}>{t('cliProviders.refresh')}</button></section>}
    <section className="codex-card ui-card" aria-labelledby="open-code-model-settings"><div className="codex-card__head"><div><h3 id="open-code-model-settings">{t('codex.models')}</h3><p>{t('codex.modelsShown', { shown: shown.length, total: allModels.length })}</p></div>
      <label className="codex-toggle-label"><span>{t('codex.showAllModels')}</span><input className="codex-switch" type="checkbox" checked={allModels.length > 0 && shown.length === allModels.length} disabled={!visibility || !allModels.length} onChange={(event) => void setAllProviderModelsVisible('openCode', event.target.checked)} /></label>
    </div>
      {allModels.map((model) => { const visible = shown.some((item) => item.id === model.id); return <div className={`codex-model-row${visible ? '' : ' codex-model-row--hidden'}`} key={model.id}>
        <div className="codex-model-row__info"><strong>{model.name}</strong><span className="codex-model-row__id">{model.id}</span></div>
        <label className="codex-toggle-label"><span>{visible ? t('codex.shown') : t('codex.hidden')}</span><input className="codex-switch" type="checkbox" role="switch" checked={visible} disabled={!visibility} aria-label={t('cliProviders.showModel', { model: model.name, provider: 'OpenCode' })} onChange={(event) => void setProviderModelVisible('openCode', model.id, event.target.checked, allModels.map((item) => item.id))} /></label>
      </div>; })}
    </section>
    <section className="codex-card ui-card"><div className="codex-card__head"><div><h3>{t('codex.preferences')}</h3></div></div>
      <label className="ui-field"><span>{t('codex.defaultModel')}</span><select className="ui-input" value={modelId} onChange={(event) => { setModelId(event.target.value); void db.settings.put({ key: 'openCodeModelId', value: event.target.value }); }}>{shown.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
      <label className="ui-field"><span>{t('openCode.agent')}</span><select className="ui-input" value={agentId} onChange={(event) => { setAgentId(event.target.value); void db.settings.put({ key: 'openCodeAgentId', value: event.target.value }); }}><option value="">{t('openCode.agent')}</option>{agents.filter((agent) => !agent.hidden).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
    </section>
  </div></div>;
}
