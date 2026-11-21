import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { parseMemoryNote } from '../../services/memoryNotes/model';
import { useMemoryNavigationStore } from '../../stores/memoryNavigationStore';
import { useMemoryNotesStore } from '../../stores/memoryNotesStore';
import { useMemoryResourcesStore } from '../../stores/memoryResourcesStore';
import { useMemoryChatContext } from '../../hooks/useMemoryChatContext';

const note = parseMemoryNote('shared.md', '# Note\nSynthetic note body');
const resource = { ...parseMemoryNote('Tools/shared.md', '# Resource\nSynthetic resource body'), category: 'Tools', sourceUrl: null };

beforeEach(() => {
  useMemoryNavigationStore.setState(useMemoryNavigationStore.getInitialState());
  useMemoryNotesStore.setState({ notes: [note], selectedFileName: null });
  useMemoryResourcesStore.setState({ notes: [resource], selectedFileName: null });
});

it('binds the assistant only to the selected record in the current collection', () => {
  const { result } = renderHook(() => useMemoryChatContext());
  expect(result.current).toBeNull();

  act(() => useMemoryNotesStore.getState().select('shared.md'));
  const noteContext = result.current;
  expect(noteContext).toMatchObject({ collection: 'notes', fileName: note.fileName, markdown: note.markdown });
  expect(noteContext?.id).toBeTruthy();

  act(() => useMemoryNavigationStore.getState().setPage('resources'));
  expect(result.current).toBeNull();
  act(() => useMemoryResourcesStore.getState().select('Tools/shared.md'));
  expect(result.current).toMatchObject({ collection: 'resources', fileName: resource.fileName, markdown: resource.markdown });
  expect(result.current?.id).not.toBe(noteContext?.id);

  act(() => useMemoryNavigationStore.getState().setPage('notes'));
  expect(result.current?.id).toBe(noteContext?.id);
  act(() => useMemoryNotesStore.getState().select('missing.md'));
  expect(result.current).toBeNull();
});
