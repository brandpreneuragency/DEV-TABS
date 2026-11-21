import { expect, it, vi } from 'vitest';
import { captureCodexScope } from './contextBuilder';
import { toolsForScope } from './businessTools';
import * as instructionFiles from '../instructionFiles';

it('captures no Memory file text or previous editor or task context and tools', async () => {
  const writerInstructions = vi.spyOn(instructionFiles, 'getWriterInstructions');
  const scope = await captureCodexScope({ appThreadId: 'thread', mode: 'writer',
    workspaceId: 'other-workspace', taskId: 'page:forms', settingsTab: 'appearance',
    selectedText: 'STALE EDITOR SELECTION', selectionFrom: 1, selectionTo: 5,
    permissionProfile: 'workspaceWrite', fallbackWorkspaceRoot: 'C:/synthetic-opencode',
    memoryContext: { id: '["notes","same.md"]' },
  });
  expect(scope.context).not.toContain('same.md');
  expect(scope.context).not.toContain('STALE EDITOR SELECTION');
  expect(scope.workspaceId).toBeUndefined();
  expect(scope.taskId).toBeUndefined();
  expect(scope.settingsTab).toBeUndefined();
  expect(scope.projectId).toBeUndefined();
  expect(scope.clientId).toBeUndefined();
  expect(scope.crmSelection).toBeUndefined();
  expect(scope.formsSelection).toBeUndefined();
  expect(scope.document).toBeUndefined();
  expect(scope.selectedText).toBeUndefined();
  expect(scope.permissionProfile).toBe('readOnly');
  expect(toolsForScope(scope)).toEqual([]);
  expect(writerInstructions).not.toHaveBeenCalled();
  writerInstructions.mockRestore();
});
