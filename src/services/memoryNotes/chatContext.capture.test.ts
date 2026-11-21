import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';

const instructions = vi.hoisted(() => ({ writer: vi.fn(), task: vi.fn() }));
vi.mock('../instructionFiles', () => ({
  getWriterInstructions: instructions.writer,
  getTaskInstructions: instructions.task,
}));

import { captureCodexScope } from '../codex/contextBuilder';
import { toolsForScope } from '../codex/businessTools';

it('captures the selected Memory item without inheriting other workspace selections or tools', async () => {
  const scope = await captureCodexScope({
    appThreadId: 'synthetic-thread',
    mode: 'writer',
    workspaceId: 'unrelated-workspace',
    taskId: 'page:forms',
    settingsTab: 'appearance',
    selectedText: 'UNRELATED DOCUMENT SELECTION',
    permissionProfile: 'workspaceWrite',
    fallbackWorkspaceRoot: 'C:/synthetic',
    memoryContext: {
      id: '["notes","synthetic.md"]',
    },
  });

  expect(scope.context).not.toContain('UNRELATED DOCUMENT SELECTION');
  expect(scope).toMatchObject({ permissionProfile: 'readOnly', hasConnectedFolder: false });
  expect(scope.workspaceId).toBeUndefined();
  expect(scope.taskId).toBeUndefined();
  expect(scope.settingsTab).toBeUndefined();
  expect(scope.document).toBeUndefined();
  expect(scope.crmSelection).toBeUndefined();
  expect(scope.formsSelection).toBeUndefined();
  expect(toolsForScope(scope)).toEqual([]);
  expect(instructions.writer).not.toHaveBeenCalled();
  expect(instructions.task).not.toHaveBeenCalled();
});
