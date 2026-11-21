import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../services/db';
import { selectActiveWorkspaceMode, useUIStore } from './uiStore';

beforeEach(async () => {
  await db.settings.clear();
  useUIStore.setState(useUIStore.getInitialState());
});

describe('retired workspace preferences', () => {
  it.each([
    { taskMode: false, crmMode: false, expected: 'documents' },
    { taskMode: true, crmMode: false, expected: 'tasks' },
    { taskMode: false, crmMode: true, expected: 'crm' },
  ])('restores $expected while discarding the removed mode', async ({ taskMode, crmMode, expected }) => {
    await db.settings.bulkPut([
      { key: 'githubMode', value: true },
      { key: 'taskMode', value: taskMode },
      { key: 'crmMode', value: crmMode },
      { key: 'contextPanelOpenByMode', value: JSON.stringify({ github: true, tasks: false, documents: true }) },
      { key: 'navigationWidth', value: 245 },
    ]);

    await useUIStore.getState().loadUISettings();

    expect(selectActiveWorkspaceMode(useUIStore.getState())).toBe(expected);
    expect(await db.settings.get('githubMode')).toBeUndefined();
    expect(useUIStore.getState()).not.toHaveProperty('githubMode');
    expect(useUIStore.getState().contextPanelOpenByMode).toMatchObject({ documents: true, tasks: false });
    expect(JSON.parse(String((await db.settings.get('contextPanelOpenByMode'))?.value))).not.toHaveProperty('github');
    expect(useUIStore.getState().navigationWidth).toBe(245);
  });
});
