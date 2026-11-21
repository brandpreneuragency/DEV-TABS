import i18n from '../../i18n';
import { parseEditorFontSize } from '../../stores/editorFontSize';
import { getSetting } from '../db';

export interface TrayWindowClient {
  listenOpened(callback: () => void): Promise<() => void>;
  ready(width: number, height: number): Promise<void>;
  hide(): Promise<void>;
}


export const trayWindowClient: TrayWindowClient = {
  async listenOpened(callback) {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    return getCurrentWebviewWindow().listen('tabs://accounts-tray-opened', callback);
  },
  async ready(width, height) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('tray_popup_ready', { width, height });
  },
  async hide() {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('tray_popup_hide');
  },
};

/** Read only the shared appearance settings; never mount the main shell/store bootstrap here. */
export async function loadTrayAppearance(): Promise<void> {
  const [theme, size, language] = await Promise.all([
    getSetting<unknown>('theme', 'default'), getSetting<unknown>('editorFontSize', 12),
    getSetting<unknown>('language', 'en'),
  ]);
  const root = document.documentElement;
  if (theme === 'purple-neon') root.dataset.theme = theme;
  else delete root.dataset.theme;
  const textSize = parseEditorFontSize(size);
  if (textSize === 12) delete root.dataset.textSize;
  else root.dataset.textSize = String(textSize);
  const locale = language === 'tr' ? 'tr' : 'en';
  root.lang = locale;
  await i18n.changeLanguage(locale);
}
