import { createRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NotesConfirmation } from './NotesDialog';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('anchors confirmation above its trigger, follows resize and falls below near the top edge', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const anchorRef = createRef<HTMLButtonElement>();
  const { unmount } = render(<button ref={anchorRef}>Cancel note</button>);
  const trigger = anchorRef.current!;
  let triggerTop = 300;
  vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(() => ({
    top: triggerTop, bottom: triggerTop + 24, left: 100, right: 180,
    width: 80, height: 24, x: 100, y: triggerTop, toJSON: () => ({}),
  }));
  vi.spyOn(HTMLDivElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 0, bottom: 86, left: 0, right: 400, width: 400, height: 86,
    x: 0, y: 0, toJSON: () => ({}),
  });
  trigger.focus();
  const confirmation = render(<NotesConfirmation title="Discard changes" message="Discard?"
    confirmLabel="Discard" onConfirm={async () => {}} onClose={() => {}} anchorRef={anchorRef} />);
  const dialog = screen.getByRole('alertdialog');
  expect(dialog).toHaveStyle({ left: '100px', top: '206px' });
  triggerTop = 200;
  fireEvent.resize(window);
  expect(dialog).toHaveStyle({ top: '106px' });
  triggerTop = 20;
  fireEvent.scroll(window);
  expect(dialog).toHaveStyle({ top: '52px' });
  confirmation.unmount();
  expect(trigger).toHaveFocus();
  unmount();
});
