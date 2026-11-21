import type { ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { FormInfo, PermissionRequest } from '../../services/openCode/forms';
import { OpenCodeRequestPanel } from './OpenCodeRequestPanel';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

const permission: PermissionRequest = {
  id: 'per_1',
  sessionID: 'ses_1',
  action: 'shell.run',
  resources: ['npm run build'],
};

const deployForm: FormInfo = {
  id: 'frm_1',
  sessionID: 'ses_1',
  title: 'Deploy',
  fields: [
    {
      key: 'mode',
      type: 'string',
      title: 'Mode',
      options: [{ value: 'basic', label: 'Basic' }, { value: 'advanced', label: 'Advanced' }],
    },
    {
      key: 'detail',
      type: 'string',
      title: 'Detail',
      when: [{ key: 'mode', op: 'eq', value: 'advanced' }],
    },
  ],
};

function renderPanel(overrides: Partial<ComponentProps<typeof OpenCodeRequestPanel>> = {}) {
  return render(
    <OpenCodeRequestPanel
      permissions={[]}
      forms={[]}
      onPermissionDecision={vi.fn()}
      onFormSubmit={vi.fn()}
      onOpenExternal={vi.fn()}
      {...overrides}
    />,
  );
}

it('dispatches each permission decision', () => {
  const decisions = [
    ['openCode.permissionAllowOnce', 'once'],
    ['openCode.permissionAllowAlways', 'always'],
    ['openCode.permissionReject', 'reject'],
  ] as const;
  for (const [label, decision] of decisions) {
    const onPermissionDecision = vi.fn();
    const { unmount } = renderPanel({ permissions: [permission], onPermissionDecision });
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(onPermissionDecision).toHaveBeenCalledWith(permission, decision);
    unmount();
  }
});

it('shows the settled permission state without actions', () => {
  const onPermissionDecision = vi.fn();
  renderPanel({
    permissions: [permission],
    settledPermissionIDs: [permission.id],
    onPermissionDecision,
  });

  expect(screen.queryByRole('button', { name: 'openCode.permissionAllowOnce' })).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('openCode.permissionSettled');
  expect(onPermissionDecision).not.toHaveBeenCalled();
});

it('reveals conditional fields and submits only visible answers', async () => {
  const onFormSubmit = vi.fn();
  renderPanel({ forms: [deployForm], onFormSubmit });

  expect(screen.queryByLabelText('Detail')).toBeNull();
  fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'advanced' } });
  fireEvent.change(screen.getByLabelText('Detail'), { target: { value: 'x' } });
  fireEvent.click(screen.getByRole('button', { name: 'openCode.formSubmit' }));

  await waitFor(() => expect(onFormSubmit).toHaveBeenCalledWith(
    deployForm,
    { mode: 'advanced', detail: 'x' },
  ));
});

it('blocks blank and fractional numeric answers without inventing zero', async () => {
  const onFormSubmit = vi.fn();
  const form: FormInfo = {
    id: 'frm_2',
    sessionID: 'ses_1',
    title: 'Amounts',
    fields: [
      { key: 'amount', type: 'number', title: 'Amount', required: true },
      { key: 'count', type: 'integer', title: 'Count' },
    ],
  };
  renderPanel({ forms: [form], onFormSubmit });

  fireEvent.change(screen.getByLabelText('Count'), { target: { value: '2.5' } });
  fireEvent.click(screen.getByRole('button', { name: 'openCode.formSubmit' }));

  expect(onFormSubmit).not.toHaveBeenCalled();
  expect(screen.getByText('openCode.formRequired')).toBeInTheDocument();
  expect(screen.getByText('openCode.formInvalidInteger')).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: '3' } });
  fireEvent.change(screen.getByLabelText('Count'), { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'openCode.formSubmit' }));

  await waitFor(() => expect(onFormSubmit).toHaveBeenCalledWith(form, { amount: 3, count: 2 }));
});

it('ignores a duplicate form submission while the first is pending', async () => {
  let finish: (() => void) | undefined;
  const onFormSubmit = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const form: FormInfo = {
    id: 'frm_3',
    sessionID: 'ses_1',
    title: 'Note',
    fields: [{ key: 'note', type: 'string', title: 'Note' }],
  };
  renderPanel({ forms: [form], onFormSubmit });

  const button = screen.getByRole('button', { name: 'openCode.formSubmit' });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(onFormSubmit).toHaveBeenCalledTimes(1);

  await act(async () => { finish?.(); });
  await waitFor(() => expect(
    screen.getByRole('button', { name: 'openCode.formSubmit' }),
  ).not.toBeDisabled());
});

it('keeps external fields behind an explicit callback', () => {
  const onOpenExternal = vi.fn();
  const form: FormInfo = {
    id: 'frm_4',
    sessionID: 'ses_1',
    title: 'Docs',
    fields: [{
      key: 'docs',
      type: 'external',
      url: 'https://example.test/doc',
      title: 'Open docs',
    }],
  };
  renderPanel({ forms: [form], onOpenExternal });

  expect(onOpenExternal).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'openCode.formExternalOpen' }));
  expect(onOpenExternal).toHaveBeenCalledWith('https://example.test/doc');
});

it('submits a required unchecked boolean as false', async () => {
  const form: FormInfo = { id: 'frm_false', sessionID: 'ses_1', title: 'Consent', fields: [
    { key: 'consent', type: 'boolean', title: 'Consent', required: true },
  ] };
  const onFormSubmit = vi.fn();
  renderPanel({ forms: [form], onFormSubmit });
  fireEvent.click(screen.getByRole('button', { name: 'openCode.formSubmit' }));
  await waitFor(() => expect(onFormSubmit).toHaveBeenCalledWith(form, { consent: false }));
});

it('adds a custom multiselect value through the form control', async () => {
  const form: FormInfo = { id: 'frm_custom', sessionID: 'ses_1', title: 'Tags', fields: [
    { key: 'tags', type: 'multiselect', title: 'Tags', options: [{ value: 'known', label: 'Known' }], custom: true },
  ] };
  const onFormSubmit = vi.fn();
  renderPanel({ forms: [form], onFormSubmit });
  fireEvent.change(screen.getByRole('textbox', { name: 'openCode.formCustomValue: Tags' }), { target: { value: 'custom-tag' } });
  fireEvent.click(screen.getByRole('button', { name: 'openCode.formAddValue' }));
  fireEvent.click(screen.getByRole('button', { name: 'openCode.formSubmit' }));
  await waitFor(() => expect(onFormSubmit).toHaveBeenCalledWith(form, { tags: ['custom-tag'] }));
});

it('locks all form inputs while a reply is pending', async () => {
  let finish: (() => void) | undefined;
  const form: FormInfo = { id: 'frm_busy', sessionID: 'ses_1', title: 'Name', fields: [
    { key: 'name', type: 'string', title: 'Name' },
  ] };
  const onFormSubmit = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  renderPanel({ forms: [form], onFormSubmit });
  fireEvent.click(screen.getByRole('button', { name: 'openCode.formSubmit' }));
  await waitFor(() => expect(screen.getByLabelText('Name')).toBeDisabled());
  await act(async () => { finish?.(); });
});
