import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { db } from '../../services/db';
import { useProviderModelVisibility, visibleProviderModels } from '../../services/providers/modelVisibility';
import { openCodeSessionService } from '../../services/openCode/sessionService';
import { useOpenCodeStore } from '../../stores/openCodeStore';
import './ChatModelControls.css';

export interface ChatModelControlsProps { threadId: string; locked?: boolean }

export function ChatModelControls({ threadId, locked = false }: ChatModelControlsProps) {
  const { t } = useTranslation();
  const start = useOpenCodeStore((state) => state.start);
  const status = useOpenCodeStore((state) => state.connection);
  const discoveredModels = useOpenCodeStore((state) => state.models);
  const discoveredAgents = useOpenCodeStore((state) => state.agents);
  const discovered = discoveredModels.filter((model) => model.enabled);
  const agents = discoveredAgents.filter((agent) => !agent.hidden);
  const visibility = useProviderModelVisibility('openCode');
  const models = visibility ? visibleProviderModels(discovered, visibility) : discovered;
  const [modelId, setModelId] = useState('');
  const [agentId, setAgentId] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { void start().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'OpenCode connection failed.')); }, [start]);
  useEffect(() => {
    let active = true;
    void Promise.all([db.settings.get('openCodeModelId'), db.settings.get('openCodeAgentId')]).then(([model, agent]) => {
      if (!active) return;
      setModelId(typeof model?.value === 'string' ? model.value : '');
      setAgentId(typeof agent?.value === 'string' ? agent.value : '');
    });
    return () => { active = false; };
  }, []);

  return <div className="chat-model-controls">
    <label className="open-code-model-select">
      <select aria-label={t('openCode.model')} title={models.find((model) => model.id === (modelId || models[0]?.id))?.name || t('openCode.connectForModels')}
        value={modelId || models[0]?.id || ''} disabled={locked || !models.length}
        onChange={(event) => {
          const id = event.target.value;
          const model = models.find((item) => item.id === id);
          if (!model) return;
          setModelId(id); setError('');
          void db.settings.put({ key: 'openCodeModelId', value: id });
          void openCodeSessionService.setModel(threadId, { id: model.modelId, providerId: model.providerId })
            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : t('openCode.requestFailed')));
        }}>
        {!models.length && <option value="">{t('openCode.model')}</option>}
        {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select>
      <ChevronDown className="ui-icon open-code-select-chevron" aria-hidden="true" />
    </label>
    <label className="open-code-model-select open-code-model-select--agent">
      <select aria-label={t('openCode.agent')} title={agents.find((agent) => agent.id === agentId)?.name || t('openCode.agent')}
        value={agentId} disabled={locked || !agents.length}
        onChange={(event) => {
          const id = event.target.value;
          setAgentId(id); setError('');
          void db.settings.put({ key: 'openCodeAgentId', value: id });
          if (id) void openCodeSessionService.setAgent(threadId, id)
            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : t('openCode.requestFailed')));
        }}>
        <option value="">{t('openCode.agent')}</option>
        {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
      </select>
      <ChevronDown className="ui-icon open-code-select-chevron" aria-hidden="true" />
    </label>
    {(error || (status !== 'connected' && status !== 'degraded')) && <div className="chat-model-feedback">
      {status !== 'connected' && status !== 'degraded' && <span className="chat-model-status" role="status" title={status}>{status}</span>}
      {error && <span role="alert" className="chat-model-status chat-model-status--error" title={error}>{error}</span>}
    </div>}
  </div>;
}
