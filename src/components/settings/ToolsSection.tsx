import { SettingsPanels } from './SettingsPanels';
import { OpenCodeSettingsPanel } from './OpenCodeSettingsPanel';
import './codexSettings.css';

/** Chat execution uses OpenCode. Provider account management remains separate. */
export function ToolsSection() {
  return <SettingsPanels leftMain={null} centerMain={<OpenCodeSettingsPanel />} />;
}
