// @vitest-environment node
import { describe, expect, it } from 'vitest';
import en from '../../i18n/en';
import tr from '../../i18n/tr';

describe('Memory and Quick Notes naming', () => {
  it('keeps the collections distinct in both languages without renaming client notes', () => {
    expect(en.navigation.notes).toBe('Quick Notes');
    expect(tr.navigation.notes).toBe('Hızlı Notlar');
    expect(en.navigation.memory).toBe('Memory');
    expect(tr.navigation.memory).toBe('Memory');
    expect(en.clients.notes).toBe('Notes');
    expect(tr.clients.notes).toBe('Notlar');
    expect(en.memoryNotes.notes).toBe('Notes');
    expect(tr.memoryNotes.notes).toBe('Notlar');
    expect(Object.keys(en.memoryNotes).sort()).toEqual(Object.keys(tr.memoryNotes).sort());
    expect(en.memoryResources.resources).toBe('Resources');
    expect(tr.memoryResources.resources).toBe('Kaynaklar');
    expect(Object.keys(en.memoryResources).sort()).toEqual(Object.keys(tr.memoryResources).sort());
    expect(en.memoryToRead.toRead).toBe('To-Read');
    expect(tr.memoryToRead.toRead).toBe('Okunacaklar');
    expect(Object.keys(en.memoryToRead).sort()).toEqual(Object.keys(tr.memoryToRead).sort());
    expect(en.memorySomeday.someday).toBe('Someday');
    expect(tr.memorySomeday.someday).toBe('Bir Gün');
    expect(Object.keys(en.memorySomeday).sort()).toEqual(Object.keys(tr.memorySomeday).sort());
  });
});
