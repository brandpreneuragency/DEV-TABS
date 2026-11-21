import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scriptsClient } from './desktopClient';

const { invoke, desktop } = vi.hoisted(() => ({ invoke: vi.fn(), desktop: vi.fn(() => true) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('../runtime', () => ({ isTauriRuntime: desktop }));
beforeEach(() => { invoke.mockReset(); desktop.mockReturnValue(true); });

describe('Scripts desktop boundary', () => {
  it('rejects browser preview before any native execution', async () => {
    desktop.mockReturnValue(false);
    await expect(scriptsClient.start('script', 3, 'receipt', false)).rejects.toThrow('desktop app');
    expect(invoke).not.toHaveBeenCalled();
  });
  it('sends the exact selected revision, receipt and explicit confirmation to the fixed command', async () => {
    invoke.mockResolvedValue({ id: 'actual-native-run' });
    await scriptsClient.start('selected-script', 7, 'stable-receipt', false);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('scripts_start', {
      id: 'selected-script', expectedRevision: 7, requestId: 'stable-receipt', confirmed: false,
    });
  });
  it('normalizes native string errors instead of returning fake success', async () => {
    invoke.mockRejectedValue('The runner could not stop the owned process tree.');
    await expect(scriptsClient.cancel('run-a')).rejects.toThrow('could not stop');
    expect(invoke).toHaveBeenCalledWith('scripts_cancel', { runId: 'run-a' });
  });
  it('preserves code and explicitly represents creation without an existing id/revision', async () => {
    const input = { name: 'Example', description: '', code: 'Write-Output "hi"\r\n', runtime: 'powershell' as const,
      workingDirectory: '', confirmationRequired: false, timeoutSeconds: 3600 };
    await scriptsClient.save(input);
    expect(invoke).toHaveBeenCalledWith('scripts_save', { input, id: null, expectedRevision: null });
  });
});
