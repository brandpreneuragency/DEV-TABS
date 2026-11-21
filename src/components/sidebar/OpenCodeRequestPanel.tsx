import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  buildFormAnswer,
  createFormDraft,
  isFieldVisible,
} from '../../services/openCode/forms';
import type {
  FormAnswer,
  FormDraft,
  FormFieldError,
  FormInfo,
  PermissionDecision,
  PermissionRequest,
} from '../../services/openCode/forms';
import './OpenCodeRequestPanel.css';

export interface OpenCodeRequestPanelProps {
  permissions: readonly PermissionRequest[];
  forms: readonly FormInfo[];
  submittingPermissionID?: string | null;
  submittingFormID?: string | null;
  settledPermissionIDs?: readonly string[];
  settledFormIDs?: readonly string[];
  permissionError?: string | null;
  formError?: string | null;
  disabled?: boolean;
  onPermissionDecision: (
    request: PermissionRequest,
    decision: PermissionDecision,
  ) => void | Promise<void>;
  onFormSubmit: (form: FormInfo, answer: FormAnswer) => void | Promise<void>;
  onOpenExternal: (url: string) => void;
}

function messageOf(cause: unknown, fallbackKey: string, t: (key: string) => string): string {
  return cause instanceof Error && cause.message ? cause.message : t(fallbackKey);
}

interface PermissionCardProps {
  request: PermissionRequest;
  submitting: boolean;
  settled: boolean;
  disabled: boolean;
  error?: string | null;
  onDecision: (request: PermissionRequest, decision: PermissionDecision) => void | Promise<void>;
}

function PermissionCard({
  request, submitting, settled, disabled, error, onDecision,
}: PermissionCardProps) {
  const { t } = useTranslation();
  const inFlight = useRef(false);
  const [localSubmitting, setLocalSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const busy = submitting || localSubmitting;
  const visibleError = localError ?? error ?? null;

  async function decide(decision: PermissionDecision) {
    if (inFlight.current || busy || settled || disabled) return;
    inFlight.current = true;
    setLocalSubmitting(true);
    setLocalError(null);
    try {
      await onDecision(request, decision);
    } catch (cause) {
      setLocalError(messageOf(cause, 'openCode.errorPermissionReply', t));
    } finally {
      inFlight.current = false;
      setLocalSubmitting(false);
    }
  }

  return (
    <section
      className="open-code-request-card"
      aria-label={`${t('openCode.permissionTitle')}: ${request.action}`}
      aria-busy={busy}
    >
      <div className="open-code-request-heading">
        <span>{t('openCode.permissionTitle')}</span>
        {settled && (
          <span className="open-code-request-status" role="status">
            {t('openCode.permissionSettled')}
          </span>
        )}
      </div>
      <p className="open-code-request-action">{request.action}</p>
      {request.resources.length > 0 && (
        <ul className="open-code-request-resources">
          {request.resources.map((resource) => (
            <li key={resource}>{resource}</li>
          ))}
        </ul>
      )}
      {request.message && <p className="open-code-request-note">{request.message}</p>}
      {!settled && (
        <div className="open-code-request-actions">
          <button
            type="button"
            className="ui-button ui-button--primary"
            disabled={busy || disabled}
            onClick={() => void decide('once')}
          >
            {t('openCode.permissionAllowOnce')}
          </button>
          <button
            type="button"
            className="ui-button ui-button--ghost"
            disabled={busy || disabled}
            onClick={() => void decide('always')}
          >
            {t('openCode.permissionAllowAlways')}
          </button>
          <button
            type="button"
            className="ui-button ui-button--danger"
            disabled={busy || disabled}
            onClick={() => void decide('reject')}
          >
            {t('openCode.permissionReject')}
          </button>
        </div>
      )}
      {busy && !settled && (
        <p className="open-code-request-meta" role="status">
          {t('openCode.permissionSubmitting')}
        </p>
      )}
      {visibleError && (
        <p className="open-code-request-error" role="alert">
          {visibleError}
        </p>
      )}
    </section>
  );
}

interface FormCardProps {
  form: FormInfo;
  submitting: boolean;
  settled: boolean;
  disabled: boolean;
  error?: string | null;
  onSubmit: (form: FormInfo, answer: FormAnswer) => void | Promise<void>;
  onOpenExternal: (url: string) => void;
}

function FormCard({
  form, submitting, settled, disabled, error, onSubmit, onOpenExternal,
}: FormCardProps) {
  const { t } = useTranslation();
  const baseId = useId();
  const inFlight = useRef(false);
  const [draft, setDraft] = useState<FormDraft>(() => createFormDraft(form.fields));
  const [errors, setErrors] = useState<FormFieldError[]>([]);
  const [attempted, setAttempted] = useState(false);
  const [localSubmitting, setLocalSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [customEntry, setCustomEntry] = useState<Record<string, string>>({});
  const busy = submitting || localSubmitting;
  const locked = settled || disabled || busy;
  const visibleError = localError ?? error ?? null;
  const inputErrors = errors.filter((entry) => entry.kind === 'input');
  const configErrors = errors.filter((entry) => entry.kind === 'config');

  function update(key: string, value: string | boolean | string[]) {
    const next: FormDraft = { ...draft, [key]: value };
    setDraft(next);
    if (attempted) setErrors(buildFormAnswer(form.fields, next).errors);
  }

  function addCustomValue(key: string) {
    const text = (customEntry[key] ?? '').trim();
    if (!text) return;
    const current = Array.isArray(draft[key]) ? draft[key] : [];
    if (!current.includes(text)) update(key, [...current, text]);
    setCustomEntry((entries) => ({ ...entries, [key]: '' }));
  }

  async function submit() {
    if (inFlight.current || busy || locked) return;
    setAttempted(true);
    const result = buildFormAnswer(form.fields, draft);
    setErrors(result.errors);
    if (result.errors.length > 0) return;
    inFlight.current = true;
    setLocalSubmitting(true);
    setLocalError(null);
    try {
      await onSubmit(form, result.answer);
    } catch (cause) {
      setLocalError(messageOf(cause, 'openCode.errorFormReply', t));
    } finally {
      inFlight.current = false;
      setLocalSubmitting(false);
    }
  }

  return (
    <section
      className="open-code-request-card"
      aria-label={`${t('openCode.formTitle')}: ${form.title}`}
      aria-busy={busy}
    >
      <div className="open-code-request-heading">
        <span>{form.title}</span>
        {settled && (
          <span className="open-code-request-status" role="status">
            {t('openCode.formSettled')}
          </span>
        )}
      </div>
      {configErrors.length > 0 && (
        <div className="open-code-request-error" role="alert">
          {configErrors.map((entry) => (
            <p key={`${entry.key}:${entry.messageKey}`}>{t(entry.messageKey)}</p>
          ))}
        </div>
      )}
      <div className="open-code-form-fields">
        {form.fields.map((field) => {
          if (field.type === 'unsupported') {
            return <p key={field.key} className="open-code-request-error" role="alert">
              {t('openCode.formUnsupportedField')}: {field.title ?? field.key} ({field.sourceType})
            </p>;
          }
          if (field.type === 'external') {
            return (
              <div key={field.key} className="open-code-external">
                <span className="open-code-field-label">
                  {field.title ?? field.key}
                </span>
                {field.description && (
                  <p className="open-code-field-description">{field.description}</p>
                )}
                <button
                  type="button"
                  className="ui-button ui-button--ghost"
                  disabled={locked}
                  onClick={() => onOpenExternal(field.url)}
                >
                  {t('openCode.formExternalOpen')}
                </button>
              </div>
            );
          }
          if (!isFieldVisible(field, draft)) return null;

          const controlId = `${baseId}-${field.key}`;
          const errorId = `${controlId}-error`;
          const descriptionId = `${controlId}-description`;
          const fieldError = inputErrors.find((entry) => entry.key === field.key);
          const label = field.title ?? field.key;
          const describedBy = [
            field.description ? descriptionId : null,
            fieldError ? errorId : null,
          ].filter(Boolean).join(' ') || undefined;
          const shared = {
            id: controlId,
            'aria-required': field.required === true ? true : undefined,
            'aria-invalid': fieldError ? true : undefined,
            'aria-describedby': describedBy,
            disabled: locked,
          };
          const raw = draft[field.key];

          return (
            <div key={field.key} className="ui-field open-code-field">
              {field.type !== 'boolean' && field.type !== 'multiselect' && (
                <label className="open-code-field-label" htmlFor={controlId}>
                  {label}
                  {field.required && <span aria-hidden="true"> *</span>}
                </label>
              )}
              {field.description && (
                <p className="open-code-field-description" id={descriptionId}>
                  {field.description}
                </p>
              )}
              {field.type === 'string' && field.options && field.options.length > 0 && !field.custom && (
                <select
                  {...shared}
                  className="open-code-field-control"
                  value={typeof raw === 'string' ? raw : ''}
                  onChange={(event) => update(field.key, event.target.value)}
                >
                  <option value="">{t('openCode.formChooseOption')}</option>
                  {field.options.map((option) => (
                    <option key={option.value} value={option.value} title={option.description}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
              {field.type === 'string' && (field.custom || !field.options?.length) && (
                <>
                  <input
                    {...shared}
                    className="open-code-field-control"
                    type="text"
                    value={typeof raw === 'string' ? raw : ''}
                    placeholder={field.placeholder}
                    list={field.options?.length ? `${controlId}-options` : undefined}
                    onChange={(event) => update(field.key, event.target.value)}
                  />
                  {field.options?.length ? (
                    <datalist id={`${controlId}-options`}>
                      {field.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.description ?? option.label}
                        </option>
                      ))}
                    </datalist>
                  ) : null}
                </>
              )}
              {(field.type === 'number' || field.type === 'integer') && (
                <input
                  {...shared}
                  className="open-code-field-control"
                  type="number"
                  inputMode={field.type === 'integer' ? 'numeric' : 'decimal'}
                  step={field.type === 'integer' ? 1 : 'any'}
                  min={typeof field.minimum === 'number' && Number.isFinite(field.minimum)
                    ? field.minimum : undefined}
                  max={typeof field.maximum === 'number' && Number.isFinite(field.maximum)
                    ? field.maximum : undefined}
                  value={typeof raw === 'string' ? raw : ''}
                  onChange={(event) => update(field.key, event.target.value)}
                />
              )}
              {field.type === 'boolean' && (
                <label className="open-code-check" htmlFor={controlId}>
                  <input
                    {...shared}
                    type="checkbox"
                    checked={raw === true}
                    onChange={(event) => update(field.key, event.target.checked)}
                  />
                  <span>
                    {label}
                    {field.required && <span aria-hidden="true"> *</span>}
                  </span>
                </label>
              )}
              {field.type === 'multiselect' && (() => {
                const selected = Array.isArray(raw) ? raw : [];
                const customValues = selected.filter(
                  (entry) => !field.options.some((option) => option.value === entry),
                );
                return (
                  <fieldset className="open-code-multiselect" aria-describedby={describedBy}>
                    <legend className="open-code-field-label">
                      {label}
                      {field.required && <span aria-hidden="true"> *</span>}
                    </legend>
                    {field.options.map((option) => (
                      <label key={option.value} className="open-code-check">
                        <input
                          type="checkbox"
                          value={option.value}
                          disabled={locked}
                          checked={selected.includes(option.value)}
                          onChange={(event) => {
                            update(field.key, event.target.checked
                              ? [...selected, option.value]
                              : selected.filter((entry) => entry !== option.value));
                          }}
                        />
                        <span title={option.description}>{option.label}</span>
                      </label>
                    ))}
                    {customValues.map((value) => (
                      <label key={value} className="open-code-check">
                        <input
                          type="checkbox"
                          checked
                          disabled={locked}
                          onChange={() => update(
                            field.key,
                            selected.filter((entry) => entry !== value),
                          )}
                        />
                        <span>{value}</span>
                      </label>
                    ))}
                    {field.custom && (
                      <div className="open-code-custom-entry">
                        <input
                          className="open-code-field-control"
                          type="text"
                          aria-label={`${t('openCode.formCustomValue')}: ${label}`}
                          placeholder={t('openCode.formCustomValuePlaceholder')}
                          value={customEntry[field.key] ?? ''}
                          disabled={locked}
                          onChange={(event) => setCustomEntry((entries) => ({
                            ...entries,
                            [field.key]: event.target.value,
                          }))}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              addCustomValue(field.key);
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="ui-button ui-button--ghost"
                          disabled={locked}
                          onClick={() => addCustomValue(field.key)}
                        >
                          {t('openCode.formAddValue')}
                        </button>
                      </div>
                    )}
                  </fieldset>
                );
              })()}
              {fieldError && (
                <span className="open-code-field-error" id={errorId}>
                  {t(fieldError.messageKey)}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {!settled && (
        <div className="open-code-request-actions">
          <button
            type="button"
            className="ui-button ui-button--primary"
            disabled={busy || locked}
            onClick={() => void submit()}
          >
            {busy ? t('openCode.formSubmitting') : t('openCode.formSubmit')}
          </button>
        </div>
      )}
      {visibleError && (
        <p className="open-code-request-error" role="alert">
          {visibleError}
        </p>
      )}
    </section>
  );
}

/** Controlled, transport-free permission/form panel. The host owns every reply. */
export function OpenCodeRequestPanel({
  permissions,
  forms,
  submittingPermissionID = null,
  submittingFormID = null,
  settledPermissionIDs = [],
  settledFormIDs = [],
  permissionError = null,
  formError = null,
  disabled = false,
  onPermissionDecision,
  onFormSubmit,
  onOpenExternal,
}: OpenCodeRequestPanelProps) {
  const { t } = useTranslation();
  if (permissions.length === 0 && forms.length === 0 && !permissionError && !formError) {
    return null;
  }

  return (
    <div className="open-code-request-panel" role="region" aria-label={t('openCode.requestsTitle')}>
      {permissions.map((request) => (
        <PermissionCard
          key={request.id}
          request={request}
          submitting={submittingPermissionID === request.id}
          settled={settledPermissionIDs.includes(request.id)}
          disabled={disabled}
          error={permissionError}
          onDecision={onPermissionDecision}
        />
      ))}
      {forms.map((form) => (
        <FormCard
          key={form.id}
          form={form}
          submitting={submittingFormID === form.id}
          settled={settledFormIDs.includes(form.id)}
          disabled={disabled}
          error={formError}
          onSubmit={onFormSubmit}
          onOpenExternal={onOpenExternal}
        />
      ))}
      {permissions.length === 0 && permissionError && (
        <p className="open-code-request-error" role="alert">{permissionError}</p>
      )}
      {forms.length === 0 && formError && (
        <p className="open-code-request-error" role="alert">{formError}</p>
      )}
    </div>
  );
}
