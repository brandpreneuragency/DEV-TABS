import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { SavedScript, ScriptRun } from '../../services/scripts/types';
import { ScriptsPage } from './ScriptsPage';
import { ScriptsNavigation } from './ScriptsNavigation';
import { scriptsEn } from '../../i18n/scripts';

// Synthetic UI boundary only: no OS process or persistence is represented here.
const fixture = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock('../../stores/scriptsStore', () => ({ useScriptsStore: Object.assign(
  (selector: (state: Record<string, unknown>) => unknown) => selector(fixture.state),
  { getState: () => fixture.state },
) }));
const script: SavedScript = { id: 'synthetic-script', revision: 3, name: 'Fixture script', description: 'Synthetic description',
  code: 'Write-Output "fixture"', runtime: 'powershell', workingDirectory: '', confirmationRequired: false,
  timeoutSeconds: 3600, createdAt: 1, updatedAt: 2 };
const run: ScriptRun = { id: 'synthetic-run', requestId: 'synthetic-request', scriptId: script.id, scriptName: 'Historical fixture',
  scriptRevision: 2, sourceHash: 'synthetic-hash', runtime: 'powershell', workingDirectory: 'C:\\fixture',
  status: 'running', createdAt: 1000, startedAt: 1000, completedAt: null, exitCode: null, error: null, logTruncated: false };
const i18n = createInstance();
void i18n.init({ lng: 'en', resources: { en: { translation: { scripts: scriptsEn } } }, interpolation: { escapeValue: false } });
function page(active = true) { return <I18nextProvider i18n={i18n}><ScriptsPage active={active} /></I18nextProvider>; }
beforeEach(() => {
  fixture.state = { view: 'all', scripts: [script], runs: [], runtimes: [{ id: 'powershell', label: 'PowerShell', executable: 'fixture' }],
    executionBlocked: null, defaultWorkingDirectory: 'C:\\fixture', maxConcurrent: 2, maxLogBytes: 1000, maxTimeoutSeconds: 86400,
    loading: false, error: null, pendingIds: [], output: null, outputLoading: false, selectedRunId: null,
    refresh: vi.fn().mockResolvedValue(undefined), startPolling: vi.fn(() => vi.fn()), setView: vi.fn(),
    save: vi.fn().mockResolvedValue(script), run: vi.fn().mockResolvedValue(run), duplicate: vi.fn().mockResolvedValue(script),
    remove: vi.fn().mockResolvedValue(undefined), cancel: vi.fn().mockResolvedValue(undefined),
    openOutput: vi.fn().mockResolvedValue(undefined), closeOutput: vi.fn(), clearError: vi.fn() };
});
afterEach(cleanup);
describe('Scripts UI (synthetic store boundary)', () => {
  it('keeps the list in the shared context panel while the editor occupies the center panel', () => {
    const ui = render(page());
    expect(ui.container.querySelector('.scripts-toolbar')?.firstElementChild)
      .toBe(screen.getByRole('button', { name: 'New script' }));
    fireEvent.click(screen.getByRole('button', { name: script.name }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('separator', { name: 'Resize context panel' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: script.name }).closest('#scripts-list-panel')).not.toBeNull();
    expect(screen.getByRole('article', { name: script.name })).toHaveAttribute('data-selected', 'true');
    expect(screen.getByLabelText('Name').closest('#center-panel')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'New script' }).closest('[inert]')).toBeNull();
    expect(ui.container.querySelector('.scripts-drawer-layer')).toBeNull();
  });

  it('protects edits when switching scripts and resumes the selected script after discard', async () => {
    const other = { ...script, id: 'other-script', name: 'Other script' };
    fixture.state.scripts = [script, other];
    const user = userEvent.setup();
    render(page());
    await user.click(screen.getByRole('button', { name: script.name }));
    await user.type(screen.getByLabelText('Name'), ' edited');
    await user.click(screen.getByRole('button', { name: other.name }));
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Fixture script edited');
    await user.click(screen.getByRole('button', { name: other.name }));
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByLabelText('Name')).toHaveValue(other.name);
    expect(fixture.state.save).not.toHaveBeenCalled();
  });

  it('protects a dirty editor before opening output from the still-visible list', () => {
    fixture.state.runs = [run];
    render(page());
    fireEvent.click(screen.getByRole('button', { name: script.name }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Output for Fixture script' }));
    expect(fixture.state.openOutput).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(fixture.state.openOutput).toHaveBeenCalledWith(run.id);
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });

  it('does not fetch while inactive and preserves a draft across navigation and polling', async () => {
    const ui = render(page(false));
    expect(fixture.state.startPolling).not.toHaveBeenCalled();
    expect(fixture.state.refresh).not.toHaveBeenCalled();
    ui.rerender(page());
    fireEvent.click(screen.getByRole('button', { name: 'New script' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Unsaved fixture' } });
    fixture.state = { ...fixture.state, scripts: [{ ...script, revision: 4 }] };
    ui.rerender(page());
    expect(screen.getByLabelText('Name')).toHaveValue('Unsaved fixture');
    ui.rerender(page(false));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    ui.rerender(page());
    expect(screen.getByLabelText('Name')).toHaveValue('Unsaved fixture');
    fireEvent.change(screen.getByLabelText('Script code'), { target: { value: 'Write-Output 1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save script' }));
    await waitFor(() => expect(fixture.state.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'Unsaved fixture', runtime: 'powershell', timeoutSeconds: 3600 }), undefined, undefined));
  });

  it('submits once without opening Output or fabricating a successful run', async () => {
    let finish!: (value: ScriptRun) => void;
    fixture.state.run = vi.fn(() => new Promise<ScriptRun>((resolve) => { finish = resolve; }));
    render(page());
    const button = screen.getByRole('button', { name: 'Run Fixture script' });
    fireEvent.click(button); fireEvent.click(button);
    expect(fixture.state.run).toHaveBeenCalledTimes(1);
    expect(fixture.state.run).toHaveBeenCalledWith(script, false);
    expect(button).toBeDisabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fixture.state.openOutput).not.toHaveBeenCalled();
    finish(run);
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
  });

  it('names the actual script in confirmation and does not run on dismissal', async () => {
    fixture.state.scripts = [{ ...script, confirmationRequired: true }];
    render(page());
    fireEvent.click(screen.getByRole('button', { name: 'Run Fixture script' }));
    expect(screen.getByRole('dialog', { name: 'Run “Fixture script” on this Windows computer?' })).toBeInTheDocument();
    expect(fixture.state.run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fixture.state.run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Run Fixture script' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(fixture.state.run).toHaveBeenCalledWith(expect.objectContaining({ id: script.id }), true));
  });

  it('keeps failed saves and the original revision after polling changes the library', async () => {
    fixture.state.save = vi.fn().mockRejectedValue(new Error('Synthetic revision conflict'));
    const ui = render(page());
    fireEvent.click(screen.getByRole('button', { name: script.name }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Edited fixture' } });
    fixture.state.scripts = [{ ...script, revision: 4 }]; ui.rerender(page());
    fireEvent.click(screen.getByRole('button', { name: 'Save script' }));
    await screen.findByText('Synthetic revision conflict');
    expect(fixture.state.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'Edited fixture' }), script.id, 3);
    expect(screen.getByLabelText('Name')).toHaveValue('Edited fixture');
    expect(screen.getByRole('region', { name: 'Edit script' })).toBeInTheDocument();
  });

  it('guards dirty Escape, lets Tab leave the editor and restores focus after a clean close', async () => {
    const user = userEvent.setup();
    render(page());
    const trigger = screen.getByRole('button', { name: 'New script' });
    await user.click(trigger);
    expect(screen.getByLabelText('Name')).toHaveFocus();
    await user.type(screen.getByLabelText('Name'), 'Keep me');
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Keep me');
    screen.getByRole('button', { name: 'Save script' }).focus();
    expect(screen.getByRole('button', { name: 'Save script' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close' })).not.toHaveFocus();
    screen.getByLabelText('Name').focus();
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
  });

  it('renders real status, escaped output and the historical source, not the edited script', async () => {
    fixture.state.runs = [run]; fixture.state.selectedRunId = run.id;
    fixture.state.output = { run, snapshot: { ...script, code: '<script>synthetic source</script>' }, stdout: '<img src=x onerror=alert(1)>\nfixture', stderr: 'fixture stderr', truncated: true };
    const ui = render(page());
    expect(screen.getByRole('button', { name: 'More actions for Fixture script' })).toBeEnabled();
    expect(screen.getByLabelText('Standard output')).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(screen.getByLabelText('Standard output').querySelector('img')).toBeNull();
    expect(screen.getByText('Output reached the capture limit and was truncated.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Executed code snapshot'));
    expect(screen.getByLabelText('Executed code snapshot')).toHaveTextContent('<script>synthetic source</script>');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(fixture.state.cancel).toHaveBeenCalledWith(run.id));
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
    expect(screen.queryByText('Cancelled')).not.toBeInTheDocument();
    fixture.state.runs = [{ ...run, status: 'failed', completedAt: 4000, exitCode: 7, error: 'Native fixture failure' }];
    ui.rerender(page());
    expect(screen.getByText('Native fixture failure')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stopping…' })).not.toBeInTheDocument();
  });

  it('preserves history after library deletion and loads only explicitly selected output', () => {
    fixture.state.view = 'history'; fixture.state.scripts = []; fixture.state.runs = [{ ...run, status: 'succeeded' }];
    render(page());
    expect(screen.getByRole('button', { name: 'Historical fixture' })).toBeInTheDocument();
    expect(fixture.state.openOutput).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Output for Historical fixture' }));
    expect(fixture.state.openOutput).toHaveBeenCalledWith(run.id);
  });

  it('shows native errors instead of claiming run success', async () => {
    fixture.state.run = vi.fn().mockRejectedValue(new Error('Synthetic native rejection'));
    render(page());
    fireEvent.click(screen.getByRole('button', { name: 'Run Fixture script' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert')).toHaveTextContent('Synthetic native rejection');
    expect(screen.queryByText('Completed')).not.toBeInTheDocument();
  });

  it('searches descriptions, duplicates and confirms deletion using the saved identity', async () => {
    render(page());
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } });
    expect(screen.getByText('No matching scripts or runs.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Synthetic description' } });
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Fixture script' }));
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(fixture.state.duplicate).toHaveBeenCalledWith(script.id));
    fireEvent.click(screen.getByRole('button', { name: 'More actions for Fixture script' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(fixture.state.remove).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Delete “Fixture script”? Its run history will be kept.');
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(fixture.state.remove).toHaveBeenCalledWith(script));
  });

  it('shows selectable preview runtimes in browser mode without enabling execution', () => {
    fixture.state.executionBlocked = null; fixture.state.runtimes = []; fixture.state.scripts = [];
    render(page());
    expect(screen.getByRole('article', { name: 'Example: Hello world' })).toHaveTextContent('Preview only');
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'New script' }));
    expect(screen.getByRole('region', { name: 'New script' })).toBeInTheDocument();
    expect(screen.getByLabelText('Runtime')).toHaveValue('powershell');
    expect(screen.getByRole('option', { name: 'Python' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Runtime'), { target: { value: 'python' } });
    expect(screen.getByLabelText('Runtime')).toHaveValue('python');
    expect(screen.getByRole('button', { name: 'Save script' })).toBeDisabled();
    expect(fixture.state.run).not.toHaveBeenCalled();
  });

  it('stops polling when hidden and exposes exactly the three sidebar destinations', () => {
    const stop = vi.fn(); fixture.state.startPolling = vi.fn(() => stop);
    const ui = render(page()); ui.rerender(page(false));
    expect(stop).toHaveBeenCalledTimes(1);
    fixture.state.runs = [run];
    render(<I18nextProvider i18n={i18n}><ScriptsNavigation /></I18nextProvider>);
    expect(screen.getAllByRole('button')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Running 1' }));
    expect(fixture.state.setView).toHaveBeenCalledWith('running');
  });

  it('validates whitespace and timeout and defaults to the first detected runtime when PowerShell is unavailable', async () => {
    fixture.state.runtimes = [{ id: 'python', label: 'Python', executable: 'synthetic' }];
    render(page());
    fireEvent.click(screen.getByRole('button', { name: 'New script' }));
    expect(screen.getByLabelText('Runtime')).toHaveValue('python');
    expect(screen.queryByRole('option', { name: 'PowerShell' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  ' } });
    fireEvent.change(screen.getByLabelText('Script code'), { target: { value: 'print(1)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save script' }));
    expect(fixture.state.save).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a name and script code');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Python fixture' } });
    fireEvent.click(screen.getByText('Advanced'));
    fireEvent.change(screen.getByLabelText('Timeout (seconds)'), { target: { value: '0' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Save script' }).closest('form')!);
    expect(fixture.state.save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Timeout (seconds)'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save script' }));
    await waitFor(() => expect(fixture.state.save).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'python', timeoutSeconds: 60 }), undefined, undefined));
  });
});
