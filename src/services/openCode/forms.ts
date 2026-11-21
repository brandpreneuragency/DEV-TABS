/**
 * Canonical OpenCode form/permission domain.
 *
 * Shapes follow the verified live 2.0.23 schema (Form.*, Permission.Request).
 * This module is transport-free: it must not import Tauri, stores or the db.
 */

/** A submitted answer value. Non-finite numbers are never sent. */
export type FormValue = string | number | boolean | string[];
export type FormAnswer = Record<string, FormValue>;

/** Numeric values as they can appear on the wire. Non-finite entries are rejected. */
export type FormNumericWire = number | 'Infinity' | '-Infinity' | 'NaN';

export type FormDraftValue = string | boolean | string[];
export type FormDraft = Record<string, FormDraftValue>;

export type FormWhenOp = 'eq' | 'neq';

export interface FormWhen {
  key: string;
  op: FormWhenOp;
  value: string | number | boolean;
}

export interface FormOption {
  value: string;
  label: string;
  description?: string;
}

export interface FormFieldBase {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: readonly FormWhen[];
}

export interface FormStringField extends FormFieldBase {
  type: 'string';
  format?: 'email' | 'uri' | 'date' | 'date-time';
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  placeholder?: string;
  default?: string;
  options?: readonly FormOption[];
  custom?: boolean;
}

export interface FormNumberField extends FormFieldBase {
  type: 'number';
  minimum?: FormNumericWire;
  maximum?: FormNumericWire;
  default?: FormNumericWire;
}

export interface FormIntegerField extends FormFieldBase {
  type: 'integer';
  minimum?: FormNumericWire;
  maximum?: FormNumericWire;
  default?: FormNumericWire;
}

export interface FormBooleanField extends FormFieldBase {
  type: 'boolean';
  default?: boolean;
}

export interface FormMultiselectField extends FormFieldBase {
  type: 'multiselect';
  options: readonly FormOption[];
  minItems?: number;
  maxItems?: number;
  custom?: boolean;
  default?: readonly string[];
}

/** External fields are actions, not answer values. */
export interface FormExternalField {
  key: string;
  type: 'external';
  url: string;
  title?: string;
  description?: string;
}

/** Unsupported wire schemas remain visible and cannot be submitted silently. */
export interface FormUnsupportedField extends FormFieldBase {
  type: 'unsupported';
  sourceType: string;
}

export type FormField =
  | FormStringField
  | FormNumberField
  | FormIntegerField
  | FormBooleanField
  | FormMultiselectField
  | FormExternalField
  | FormUnsupportedField;

export interface FormInfo {
  id: string;
  sessionID: string;
  title: string;
  fields: readonly FormField[];
  metadata?: Readonly<Record<string, unknown>>;
}

export interface PermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources: readonly string[];
  save?: readonly string[];
  message?: string;
  metadata?: Readonly<Record<string, unknown>>;
  source?: { type: 'tool'; messageID: string; id: string };
}

export type PermissionDecision = 'once' | 'always' | 'reject';

export type FormMessageKey =
  | 'openCode.formRequired'
  | 'openCode.formInvalidNumber'
  | 'openCode.formInvalidInteger'
  | 'openCode.formOutOfRange'
  | 'openCode.formTooShort'
  | 'openCode.formTooLong'
  | 'openCode.formInvalidPattern'
  | 'openCode.formInvalidOption'
  | 'openCode.formSelectAtLeast'
  | 'openCode.formSelectAtMost'
  | 'openCode.formUnsupportedPattern'
  | 'openCode.formUnsupportedHiddenRequired'
  | 'openCode.formUnsupportedField';

/** `config` errors describe an unsupported form definition, not user input. */
export type FormFieldErrorKind = 'input' | 'config';

export interface FormFieldError {
  key: string;
  messageKey: FormMessageKey;
  kind: FormFieldErrorKind;
}

export interface FormBuildResult {
  answer: FormAnswer;
  errors: FormFieldError[];
}

const NUMERIC_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Parse user text without inventing values. `''`, `'Infinity'`, `'NaN'` and
 * other non-finite or malformed input yield `null`; they never become 0.
 */
export function parseFiniteNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!NUMERIC_TEXT.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Accept only finite numeric bounds/defaults from the wire. */
export function finiteBound(value: FormNumericWire | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeRegExp(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    // An unsupported pattern is not a user error and must not crash the panel.
    return null;
  }
}

function conditionMatches(condition: FormWhen, draft: FormDraft): boolean {
  const raw = draft[condition.key];
  if (Array.isArray(raw)) {
    const hit = raw.includes(String(condition.value));
    return condition.op === 'eq' ? hit : !hit;
  }
  const expected = condition.value;
  let equal: boolean;
  if (typeof expected === 'boolean') {
    equal = raw === expected;
  } else if (typeof expected === 'number') {
    const actual = typeof raw === 'string' ? parseFiniteNumber(raw) : null;
    equal = actual !== null && actual === expected;
  } else {
    equal = typeof raw === 'string' && raw === expected;
  }
  return condition.op === 'eq' ? equal : !equal;
}

/** Hidden fields are not rendered; `when` conditions are ANDed. */
export function isFieldVisible(field: FormField, draft: FormDraft): boolean {
  if (field.type === 'external') return true;
  if (field.hidden) return false;
  return (field.when ?? []).every((condition) => conditionMatches(condition, draft));
}

/** Seed a draft from defaults without coercing unsupported values. */
export function createFormDraft(fields: readonly FormField[]): FormDraft {
  const draft: FormDraft = {};
  for (const field of fields) {
    if (field.type === 'external' || field.type === 'unsupported') continue;
    if (field.type === 'boolean') {
      // A checkbox always has a definite state once it is required. Seed `false`
      // so "required" means answered and an unchecked box submits `false`.
      const seeded = typeof field.default === 'boolean'
        ? field.default
        : field.required ? false : undefined;
      if (seeded !== undefined) draft[field.key] = seeded;
    } else if (field.type === 'multiselect') {
      draft[field.key] = [...(field.default ?? [])];
    } else if (field.type === 'string') {
      draft[field.key] = field.default ?? '';
    } else {
      const bound = finiteBound(field.default);
      draft[field.key] = bound === undefined ? '' : String(bound);
    }
  }
  return draft;
}

type AnswerField = Exclude<FormField, FormExternalField | FormUnsupportedField>;

interface FieldEvaluation {
  value?: FormValue;
  messageKey?: FormMessageKey;
  kind?: FormFieldErrorKind;
}

/** Defaults are the only source for a hidden field; they are never invented. */
function defaultDraftValue(field: AnswerField): FormDraftValue | undefined {
  if (field.type === 'boolean') {
    return typeof field.default === 'boolean' ? field.default : undefined;
  }
  if (field.type === 'multiselect') {
    return Array.isArray(field.default) ? [...field.default] : undefined;
  }
  if (field.type === 'string') {
    return typeof field.default === 'string' ? field.default : undefined;
  }
  const bound = finiteBound(field.default);
  return bound === undefined ? undefined : String(bound);
}

function evaluateField(field: AnswerField, raw: FormDraftValue | undefined): FieldEvaluation {
  switch (field.type) {
    case 'string': {
      const value = typeof raw === 'string' ? raw : '';
      if (value.trim() === '') {
        return field.required ? { messageKey: 'openCode.formRequired' } : {};
      }
      if (field.minLength !== undefined && value.length < field.minLength) {
        return { messageKey: 'openCode.formTooShort' };
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return { messageKey: 'openCode.formTooLong' };
      }
      if (field.pattern) {
        const pattern = safeRegExp(field.pattern);
        if (!pattern) {
          return { messageKey: 'openCode.formUnsupportedPattern', kind: 'config' };
        }
        if (!pattern.test(value)) return { messageKey: 'openCode.formInvalidPattern' };
      }
      if (field.options?.length && !field.custom
        && !field.options.some((option) => option.value === value)) {
        return { messageKey: 'openCode.formInvalidOption' };
      }
      return { value };
    }
    case 'number':
    case 'integer': {
      const text = typeof raw === 'string' ? raw : '';
      if (text.trim() === '') {
        return field.required ? { messageKey: 'openCode.formRequired' } : {};
      }
      const parsed = parseFiniteNumber(text);
      if (parsed === null) {
        return {
          messageKey: field.type === 'integer'
            ? 'openCode.formInvalidInteger'
            : 'openCode.formInvalidNumber',
        };
      }
      if (field.type === 'integer' && !Number.isInteger(parsed)) {
        return { messageKey: 'openCode.formInvalidInteger' };
      }
      const minimum = finiteBound(field.minimum);
      const maximum = finiteBound(field.maximum);
      if ((minimum !== undefined && parsed < minimum)
        || (maximum !== undefined && parsed > maximum)) {
        return { messageKey: 'openCode.formOutOfRange' };
      }
      return { value: parsed };
    }
    case 'boolean': {
      // Required means answered: an unchecked box is a valid `false` answer.
      if (typeof raw !== 'boolean') {
        return field.required ? { messageKey: 'openCode.formRequired' } : {};
      }
      return { value: raw };
    }
    case 'multiselect': {
      const value = Array.isArray(raw) ? raw.filter((entry) => typeof entry === 'string') : [];
      if (value.length === 0 && field.required) {
        return { messageKey: 'openCode.formRequired' };
      }
      if (field.minItems !== undefined && value.length < field.minItems) {
        return { messageKey: 'openCode.formSelectAtLeast' };
      }
      if (field.maxItems !== undefined && value.length > field.maxItems) {
        return { messageKey: 'openCode.formSelectAtMost' };
      }
      if (field.options.length > 0 && !field.custom
        && value.some((entry) => !field.options.some((option) => option.value === entry))) {
        return { messageKey: 'openCode.formInvalidOption' };
      }
      return value.length > 0 ? { value } : {};
    }
  }
}

/**
 * Build the answer from the active field set.
 *
 * `external` fields are separate actions and never part of the answer.
 * Hidden fields contribute only their declared default; a hidden required field
 * without a default is an unsupported definition, reported as a `config` error.
 * Fields whose `when` conditions do not match are not submitted.
 */
export function buildFormAnswer(fields: readonly FormField[], draft: FormDraft): FormBuildResult {
  const answer: FormAnswer = {};
  const errors: FormFieldError[] = [];

  for (const field of fields) {
    if (field.type === 'external') continue;
    if (field.type === 'unsupported') {
      errors.push({ key: field.key, messageKey: 'openCode.formUnsupportedField', kind: 'config' });
      continue;
    }

    if (field.hidden) {
      const seed = defaultDraftValue(field);
      if (seed === undefined) {
        if (field.required) {
          errors.push({
            key: field.key,
            messageKey: 'openCode.formUnsupportedHiddenRequired',
            kind: 'config',
          });
        }
        continue;
      }
      const evaluation = evaluateField(field, seed);
      if (evaluation.messageKey) {
        errors.push({ key: field.key, messageKey: evaluation.messageKey, kind: 'config' });
      } else if (evaluation.value !== undefined) {
        answer[field.key] = evaluation.value;
      }
      continue;
    }

    if (!isFieldVisible(field, draft)) continue;

    const evaluation = evaluateField(field, draft[field.key]);
    if (evaluation.messageKey) {
      errors.push({
        key: field.key,
        messageKey: evaluation.messageKey,
        kind: evaluation.kind ?? 'input',
      });
    } else if (evaluation.value !== undefined) {
      answer[field.key] = evaluation.value;
    }
  }

  return { answer, errors };
}
