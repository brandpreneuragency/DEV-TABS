// Isolated native acceptance entry. Not imported by production App/main.
import { createRoot } from 'react-dom/client';
import type { CSSProperties } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ScriptsPage } from '../../components/scripts/ScriptsPage';
import { ScriptsNavigation } from '../../components/scripts/ScriptsNavigation';
import { ModeNavigation } from '../../components/header/ModeNavigation';
import { useScriptsStore } from '../../stores/scriptsStore';
import { selectActiveWorkspaceMode, useUIStore } from '../../stores/uiStore';
import { scriptsClient } from './desktopClient';
import { isActiveRun, type SavedScript, type ScriptInput, type ScriptOutput, type ScriptRun } from './types';
import i18n from '../../i18n';
import '../../index.css';
import '../../components/layout/navigation.css';

declare global {
  interface Window {
    __TABS_SCRIPTS_ACCEPTANCE__?: { phase: 'first' | 'reopen'; hold?: boolean };
    __TABS_SCRIPTS_CAPTURE_READY__?: boolean;
    __TABS_SCRIPTS_CAPTURE_CONTINUE__?: boolean;
  }
}

const context = window.__TABS_SCRIPTS_ACCEPTANCE__;
if (!import.meta.env.DEV || !context || !('__TAURI_INTERNALS__' in window)) {
  throw new Error('This acceptance entry requires the isolated native Scripts executable.');
}
useUIStore.getState().setActiveView('scripts');
export function AcceptanceSurface() {
  const active = useUIStore(selectActiveWorkspaceMode) === 'scripts';
  return <div className="app-shell" style={{ '--sidebar-width': `${useUIStore.getState().navigationWidth}px` } as CSSProperties}>
  <header className="app-titlebar"><div className="app-titlebar__main"><ModeNavigation /></div></header>
  <div className="app-shell-main"><div className="workspace">
    <div className="sidebar-panel"><nav id="nav-bar" className="nav-bar scope-navigation"><ScriptsNavigation /></nav></div>
    <div className="workspace-panels"><ScriptsPage active={active} />{!active && <p>Other workspace — isolated fixture</p>}</div>
  </div></div>
</div>;
}
createRoot(document.getElementById('root')!).render(<AcceptanceSurface />);

const checks: string[] = [];
function check(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
  checks.push(label);
}
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string, timeout = 30000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}
const input = (name: string, code: string): ScriptInput => ({ name, code, description: 'Isolated harmless native acceptance',
  runtime: 'powershell', workingDirectory: '', confirmationRequired: false, timeoutSeconds: 60 });
const receipt = (name: string) => `native-acceptance-${name}`.padEnd(32, '0').slice(0, 32);
async function start(script: SavedScript, key: string): Promise<ScriptRun> {
  return scriptsClient.start(script.id, script.revision, receipt(key), false);
}
async function finished(run: ScriptRun) {
  return until(() => scriptsClient.output(run.id), output => !isActiveRun(output.run), 'native run completion');
}

async function exercise() {
  await i18n.changeLanguage('en');
  const initial = await scriptsClient.snapshot();
  check(!initial.executionBlocked, 'native execution permitted without elevation');
  check(initial.runtimes.some(runtime => runtime.id === 'powershell'), 'actual PowerShell discovered');
  if (context?.phase === 'reopen') {
    const stopped = initial.runs.find(run => run.scriptName === 'Acceptance shutdown');
    check(stopped?.status === 'interrupted', 'full application exit interrupted the owned job and persisted status');
    const successful = initial.runs.find(run => run.scriptName === 'Acceptance stdout');
    check(successful?.status === 'succeeded', 'history persisted across native process restart');
    const savedOutput = await scriptsClient.output(successful.id);
    check(savedOutput.stdout.includes('TABS_SCRIPTS_SMOKE_OK'), 'stdout persisted after script deletion and restart');
    check(savedOutput.snapshot.name === 'Acceptance stdout', 'historical source/name snapshot persisted');
    await useScriptsStore.getState().refresh();
    useScriptsStore.getState().setView('history');
    await useScriptsStore.getState().openOutput(successful.id);
    await until(async () => document.body.textContent ?? '', text => text.includes('TABS_SCRIPTS_SMOKE_OK'), 'actual Output component renders persisted stdout');
    check(true, 'real Output component rendered native persisted stdout');
    if (context.hold) {
      window.__TABS_SCRIPTS_CAPTURE_READY__ = true;
      await until(async () => window.__TABS_SCRIPTS_CAPTURE_CONTINUE__ === true, value => value, 'bounded reopen visual capture', 120000);
    }
    return;
  }
  check(initial.scripts.length === 0 && initial.runs.length === 0, 'isolated initially empty native store');
  const saved = await scriptsClient.save(input('Acceptance stdout', "[Console]::Out.WriteLine('TABS_SCRIPTS_SMOKE_OK'); [Console]::Error.WriteLine('TABS_SCRIPTS_SMOKE_STDERR')"));
  await useScriptsStore.getState().refresh();
  const runButton = await until(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Run Acceptance stdout"]'),
    button => !!button && !button.disabled, 'actual Run button readiness');
  const buttonRect = runButton!.getBoundingClientRect();
  check(document.elementFromPoint(buttonRect.x + buttonRect.width / 2, buttonRect.y + buttonRect.height / 2)?.closest('button') === runButton,
    'Run button is visibly hit-testable in the native WebView');
  runButton!.click();
  const started = await until(() => scriptsClient.snapshot(), value => value.runs.some(run => run.scriptId === saved.id), 'Run button launches a native job');
  const first = started.runs.find(run => run.scriptId === saved.id)!;
  check(true, 'actual React Run button created a native execution');
  const good = await finished(first);
  check(good.run.status === 'succeeded' && good.run.exitCode === 0, 'real PowerShell success and exit code 0');
  check(good.stdout.includes('TABS_SCRIPTS_SMOKE_OK') && good.stderr.includes('TABS_SCRIPTS_SMOKE_STDERR'), 'real separated stdout and stderr');
  const same = await scriptsClient.start(saved.id, saved.revision, first.requestId, false);
  check(same.id === first.id, 'repeated receipt does not execute again even after completion');
  const edited = await scriptsClient.save(input('Acceptance edited', 'Write-Output "EXPECTED_FAILURE"; exit 7'), saved.id, saved.revision);
  const failure = await finished(await start(edited, 'failed'));
  check(failure.run.status === 'failed' && failure.run.exitCode === 7, 'real nonzero exit remains failed');
  const copy = await scriptsClient.duplicate(edited.id);
  check(copy.id !== edited.id && copy.code === edited.code, 'real saved duplicate has independent identity');
  await scriptsClient.delete(edited.id, edited.revision);
  const retained = await scriptsClient.output(first.id);
  check(retained.snapshot.code === saved.code && retained.snapshot.name === saved.name, 'edit/delete preserves historical source snapshot');
  const slow = await scriptsClient.save(input('Acceptance cancel', "Write-Output 'CANCEL_READY'; Start-Sleep -Seconds 30"));
  const active = await start(slow, 'cancel');
  await until(() => scriptsClient.output(active.id), out => out.stdout.includes('CANCEL_READY'), 'cancellation target readiness');
  const cancelled = await scriptsClient.cancel(active.id);
  check(cancelled.status === 'cancelled', 'native cancellation acknowledged after process stop');
  const background = await scriptsClient.save(input('Acceptance navigation', "Write-Output 'NAV_READY'; Start-Sleep -Seconds 3; Write-Output 'HIDDEN_DONE'"));
  const backgroundRun = await start(background, 'navigation');
  await until(() => scriptsClient.output(backgroundRun.id), out => out.stdout.includes('NAV_READY'), 'background job readiness');
  document.getElementById('nav-btn-documents')!.click();
  await until(async () => document.querySelector('.scripts-page'), page => page === null, 'Scripts view deactivated through actual navigation');
  check(isActiveRun((await scriptsClient.output(backgroundRun.id)).run), 'native job continued after leaving Scripts');
  const hidden = await invoke<ScriptOutput>('scripts_acceptance_hide_probe', { runId: backgroundRun.id });
  check(hidden.run.status === 'succeeded' && hidden.stdout.includes('HIDDEN_DONE'), 'job completed while the native window was hidden');
  document.getElementById('nav-btn-scripts')!.click();
  await until(async () => document.querySelector('.scripts-page'), page => !!page, 'Scripts returns after navigation');
  await useScriptsStore.getState().refresh();
  useScriptsStore.getState().setView('history');
  await useScriptsStore.getState().openOutput(first.id);
  await until(async () => document.body.textContent ?? '', text => text.includes('TABS_SCRIPTS_SMOKE_OK'), 'actual Output component renders stdout');
  check(true, 'actual React Output component displays real native log');
  if (context?.hold) {
    window.__TABS_SCRIPTS_CAPTURE_READY__ = true;
    await until(async () => window.__TABS_SCRIPTS_CAPTURE_CONTINUE__ === true, value => value, 'bounded visual capture', 120000);
  }
  const shutdown = await scriptsClient.save(input('Acceptance shutdown', "Write-Output 'SHUTDOWN_READY'; Start-Sleep -Seconds 30"));
  const closing = await start(shutdown, 'shutdown');
  await until(() => scriptsClient.output(closing.id), out => out.stdout.includes('SHUTDOWN_READY'), 'shutdown target readiness');
  check(isActiveRun((await scriptsClient.output(closing.id)).run), 'owned job running immediately before full native exit');
}

void exercise().then(async () => {
  await invoke('scripts_acceptance_report', { report: { success: true, phase: context.phase, checks } });
  await invoke('scripts_acceptance_quit', { success: true });
}).catch(async (error: unknown) => {
  const text = error instanceof Error ? error.message : String(error);
  await invoke('scripts_acceptance_report', { report: { success: false, phase: context.phase, checks, error: text } });
  await invoke('scripts_acceptance_quit', { success: false });
});
