import { useRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useContextPanelResize } from './useContextPanelResize';
import { KEYBOARD_RESIZE_STEP_PX } from '../stores/layoutGeometry';

vi.mock('../services/db', () => ({ db: { settings: { put: vi.fn() } } }));

afterEach(cleanup);

function ResizeProbe({ side, onWidthChange }: {
  side: 'left' | 'right';
  onWidthChange: (width: number, persist: boolean) => void;
}) {
  const contextRef = useRef<HTMLDivElement>(null);
  const primaryContentRef = useRef<HTMLDivElement>(null);
  const { onPointerDown, onKeyDown } = useContextPanelResize({
    side, contextRef, primaryContentRef, widthPx: 320, onWidthChange,
  });
  return (
    <div ref={primaryContentRef} data-testid="row">
      <div ref={contextRef} data-testid="panel" />
      <div role="separator" tabIndex={0} onPointerDown={onPointerDown} onKeyDown={onKeyDown} />
    </div>
  );
}

describe.each(['left', 'right'] as const)('context panel on the %s', (side) => {
  const direction = side === 'right' ? -1 : 1;

  function setup() {
    const onWidthChange = vi.fn();
    render(<ResizeProbe side={side} onWidthChange={onWidthChange} />);
    vi.spyOn(screen.getByTestId('row'), 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1000, 600));
    vi.spyOn(screen.getByTestId('panel'), 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 320, 600));
    return { handle: screen.getByRole('separator'), onWidthChange };
  }

  it('moves the separator in the pressed arrow direction', () => {
    const { handle, onWidthChange } = setup();
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onWidthChange).toHaveBeenLastCalledWith(320 + KEYBOARD_RESIZE_STEP_PX * direction, true);
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onWidthChange).toHaveBeenLastCalledWith(320 - KEYBOARD_RESIZE_STEP_PX * direction, true);
  });

  it('resizes in the pointer direction and persists when released', () => {
    const { handle, onWidthChange } = setup();
    Object.assign(handle, { setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
    fireEvent(handle, new MouseEvent('pointerdown', { bubbles: true, clientX: 500 }));
    fireEvent(handle, new MouseEvent('pointermove', { clientX: 530 }));
    expect(onWidthChange).toHaveBeenLastCalledWith(320 + 30 * direction, false);
    fireEvent(handle, new MouseEvent('pointerup'));
    expect(onWidthChange).toHaveBeenLastCalledWith(320, true);
    expect(document.documentElement.dataset.resizing).toBeUndefined();
  });
});
