import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrimaryWorkspaceContent } from './PrimaryWorkspaceContent';

vi.mock('../../../services/db', () => ({
  db: { settings: { put: vi.fn().mockResolvedValue(undefined) } },
}));

afterEach(cleanup);

describe('Documents panel placement', () => {
  const props = {
    mode: 'documents' as const,
    contextPanel: <div>Files</div>,
    centerPanel: <input aria-label="Document draft" defaultValue="Unsaved edit" />,
    contextPanelAvailable: true,
    contextPanelOpen: true,
    contextPanelWidthVw: 30,
    contextPanelWidthPx: 320,
    contextPanelId: 'file-tree-panel',
  };

  it('preserves the editor and draft when the right-hand tree closes and reopens', () => {
    const view = render(<PrimaryWorkspaceContent {...props} />);
    const editor = screen.getByLabelText('Document draft');
    fireEvent.change(editor, { target: { value: 'Still unsaved' } });
    view.rerender(<PrimaryWorkspaceContent {...props} contextPanelOpen={false} />);
    expect(screen.queryByText('Files')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Document draft')).toBe(editor);
    view.rerender(<PrimaryWorkspaceContent {...props} />);
    expect(screen.getByLabelText('Document draft')).toBe(editor);
    expect(editor).toHaveValue('Still unsaved');
  });

  it.each([
    ['documents', 'ArrowLeft', 336],
    ['documents', 'ArrowRight', 304],
    ['tasks', 'ArrowLeft', 304],
    ['tasks', 'ArrowRight', 336],
  ] as const)('resizes %s with %s in the direction of the separator', (mode, key, width) => {
    const onWidthChange = vi.fn();
    render(<PrimaryWorkspaceContent {...props} mode={mode} onContextPanelWidthChange={onWidthChange} />);
    fireEvent.keyDown(screen.getByRole('separator'), { key });
    expect(onWidthChange).toHaveBeenCalledWith(width, true);
  });

  it.each([
    ['documents', 352],
    ['tasks', 288],
  ] as const)('grows or shrinks the %s panel correctly when dragging left', (mode, width) => {
    const onWidthChange = vi.fn();
    const { container } = render(<PrimaryWorkspaceContent {...props} mode={mode} onContextPanelWidthChange={onWidthChange} />);
    const panel = container.querySelector('#file-tree-panel')!;
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({ width: 320 } as DOMRect);
    const handle = screen.getByRole('separator');
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, clientX: 500 }));
    fireEvent(handle, new MouseEvent('pointermove', { bubbles: true, clientX: 468 }));
    expect(onWidthChange).toHaveBeenCalledWith(width, false);
    fireEvent(handle, new MouseEvent('pointerup', { bubbles: true, clientX: 468 }));
    expect(document.documentElement.dataset.resizing).toBeUndefined();
  });
});
