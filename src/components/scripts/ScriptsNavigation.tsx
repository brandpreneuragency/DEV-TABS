import { History, List, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useScriptsStore } from '../../stores/scriptsStore';
import { isActiveRun } from '../../services/scripts/types';
import './scripts.css';

export function ScriptsNavigation() {
  const { t } = useTranslation();
  const view = useScriptsStore((state) => state.view);
  const count = useScriptsStore((state) => state.runs.filter(isActiveRun).length);
  return <div className="scripts-navigation scope-tabs">
    {(['all', 'running', 'history'] as const).map((value) => {
      const Icon = value === 'all' ? List : value === 'running' ? Play : History;
      return <button key={value} type="button" className="ui-list-row scope-tab scripts-nav-row"
        aria-label={value === 'running' ? `${t('scripts.running')} ${count}` : undefined}
        aria-current={view === value ? 'page' : undefined} onClick={() => useScriptsStore.getState().setView(value)}>
        <Icon /><span>{t(`scripts.${value}`)}</span>{value === 'running' && <span className="scripts-count">{count}</span>}
      </button>;
    })}
  </div>;
}
