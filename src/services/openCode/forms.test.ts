import { describe, expect, it } from 'vitest';
import type { FormField } from './forms';
import {
  buildFormAnswer,
  createFormDraft,
  isFieldVisible,
  parseFiniteNumber,
} from './forms';

describe('parseFiniteNumber', () => {
  it('accepts finite decimal and exponent text', () => {
    expect(parseFiniteNumber('12')).toBe(12);
    expect(parseFiniteNumber(' -2.5 ')).toBe(-2.5);
    expect(parseFiniteNumber('1e3')).toBe(1000);
  });

  it('rejects blank, malformed and non-finite text without coercing', () => {
    expect(parseFiniteNumber('')).toBeNull();
    expect(parseFiniteNumber('   ')).toBeNull();
    expect(parseFiniteNumber('Infinity')).toBeNull();
    expect(parseFiniteNumber('-Infinity')).toBeNull();
    expect(parseFiniteNumber('NaN')).toBeNull();
    expect(parseFiniteNumber('0x10')).toBeNull();
  });
});

describe('createFormDraft', () => {
  it('uses finite defaults only and copies multiselect defaults', () => {
    const tagsDefault = ['a'];
    const fields: FormField[] = [
      { key: 'name', type: 'string', default: 'Ada' },
      { key: 'count', type: 'number', default: 'Infinity' },
      { key: 'limit', type: 'integer', default: 4 },
      { key: 'flag', type: 'boolean', default: true },
      { key: 'tags', type: 'multiselect', options: [], default: tagsDefault },
    ];
    const draft = createFormDraft(fields);
    expect(draft).toEqual({ name: 'Ada', count: '', limit: '4', flag: true, tags: ['a'] });
    expect(draft.tags).not.toBe(tagsDefault);
  });
  it('seeds required booleans as answered false and leaves optional ones unset', () => {
    const required: FormField[] = [{ key: 'consent', type: 'boolean', required: true }];
    const optional: FormField[] = [{ key: 'flag', type: 'boolean' }];
    expect(createFormDraft(required)).toEqual({ consent: false });
    expect(createFormDraft(optional)).toEqual({});
  });
});

describe('required booleans', () => {
  it('accepts false because required means answered, not true', () => {
    const fields: FormField[] = [{ key: 'consent', type: 'boolean', required: true }];
    expect(buildFormAnswer(fields, { consent: false })).toEqual({
      answer: { consent: false },
      errors: [],
    });
  });

  it('still reports a genuinely missing answer', () => {
    const fields: FormField[] = [{ key: 'consent', type: 'boolean', required: true }];
    expect(buildFormAnswer(fields, {}).errors).toEqual([
      { key: 'consent', messageKey: 'openCode.formRequired', kind: 'input' },
    ]);
  });
});

describe('buildFormAnswer', () => {
  it('reports a required numeric field instead of submitting zero', () => {
    const fields: FormField[] = [{ key: 'amount', type: 'number', required: true }];
    const result = buildFormAnswer(fields, { amount: '   ' });
    expect(result.answer).toEqual({});
    expect(result.errors).toEqual([{ key: 'amount', messageKey: 'openCode.formRequired', kind: 'input' }]);
  });

  it('rejects non-finite and out-of-range numbers', () => {
    const fields: FormField[] = [
      { key: 'amount', type: 'number', maximum: 10 },
      { key: 'count', type: 'integer' },
    ];
    const result = buildFormAnswer(fields, { amount: 'Infinity', count: '2.5' });
    expect(result.answer).toEqual({});
    expect(result.errors).toEqual([
      { key: 'amount', messageKey: 'openCode.formInvalidNumber', kind: 'input' },
      { key: 'count', messageKey: 'openCode.formInvalidInteger', kind: 'input' },
    ]);

    const overLimit = buildFormAnswer(fields, { amount: '11', count: '2' });
    expect(overLimit.answer).toEqual({ count: 2 });
    expect(overLimit.errors).toEqual([
      { key: 'amount', messageKey: 'openCode.formOutOfRange', kind: 'input' },
    ]);
  });

  it('obeys conditional visibility and omits hidden or external fields', () => {
    const fields: FormField[] = [
      {
        key: 'mode',
        type: 'string',
        options: [{ value: 'basic', label: 'Basic' }, { value: 'advanced', label: 'Advanced' }],
      },
      {
        key: 'detail',
        type: 'string',
        when: [{ key: 'mode', op: 'eq', value: 'advanced' }],
      },
      {
        key: 'skip',
        type: 'string',
        when: [{ key: 'mode', op: 'neq', value: 'advanced' }],
      },
      { key: 'secret', type: 'string', hidden: true, required: true },
      { key: 'docs', type: 'external', url: 'https://example.test/docs' },
    ];

    const advanced = buildFormAnswer(fields, { mode: 'advanced', detail: 'x', skip: 'y', secret: '' });
    expect(advanced.answer).toEqual({ mode: 'advanced', detail: 'x' });
    expect(advanced.errors).toEqual([
      { key: 'secret', messageKey: 'openCode.formUnsupportedHiddenRequired', kind: 'config' },
    ]);

    const basic = buildFormAnswer(fields, { mode: 'basic', detail: 'x', skip: 'y', secret: '' });
    expect(basic.answer).toEqual({ mode: 'basic', skip: 'y' });
  });

  it('reports unsupported patterns as form configuration errors and rejects a real mismatch', () => {
    const fields: FormField[] = [{ key: 'code', type: 'string', pattern: '(' }];
    expect(() => buildFormAnswer(fields, { code: 'abc' })).not.toThrow();
    expect(buildFormAnswer(fields, { code: 'abc' }).errors).toEqual([
      { key: 'code', messageKey: 'openCode.formUnsupportedPattern', kind: 'config' },
    ]);

    const strict: FormField[] = [{ key: 'code', type: 'string', pattern: '^[a-z]+$' }];
    expect(buildFormAnswer(strict, { code: 'ABC' }).errors)
      .toEqual([{ key: 'code', messageKey: 'openCode.formInvalidPattern', kind: 'input' }]);
  });

  it('validates multiselect option membership and item counts', () => {
    const fields: FormField[] = [{
      key: 'tags',
      type: 'multiselect',
      required: true,
      minItems: 2,
      options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
    }];
    expect(buildFormAnswer(fields, { tags: ['a'] }).errors)
      .toEqual([{ key: 'tags', messageKey: 'openCode.formSelectAtLeast', kind: 'input' }]);
    expect(buildFormAnswer(fields, { tags: ['a', 'b'] }).answer).toEqual({ tags: ['a', 'b'] });
    expect(buildFormAnswer(fields, { tags: ['a', 'bogus'] }).errors)
      .toEqual([{ key: 'tags', messageKey: 'openCode.formInvalidOption', kind: 'input' }]);
  });
});

describe('isFieldVisible', () => {
  it('matches boolean and numeric conditions', () => {
    const flagField: FormField = {
      key: 'reason',
      type: 'string',
      when: [{ key: 'enabled', op: 'eq', value: true }],
    };
    const countField: FormField = {
      key: 'note',
      type: 'string',
      when: [{ key: 'count', op: 'eq', value: 2 }],
    };
    expect(isFieldVisible(flagField, { enabled: true })).toBe(true);
    expect(isFieldVisible(flagField, { enabled: false })).toBe(false);
    expect(isFieldVisible(countField, { count: '2' })).toBe(true);
    expect(isFieldVisible(countField, { count: '3' })).toBe(false);
  });
});
