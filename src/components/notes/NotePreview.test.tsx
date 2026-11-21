import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { NotePreview } from './NotePreview';

it('keeps card links passive and preserves text with unsupported saved attributes', () => {
  const { container, getByText } = render(<NotePreview content={{ type: 'doc', content: [
    { type: 'paragraph', attrs: { textAlign: 'invalid' }, content: [
      { type: 'text', text: 'Reference', marks: [
        { type: 'link', attrs: { href: 'https://example.org' } },
        { type: 'textStyle', attrs: { color: '#dc2626', textPreset: 'h3' } },
      ] },
      { type: 'text', text: 'Other', marks: [
        { type: 'link', attrs: { href: 'javascript:void(0)' } },
        { type: 'textStyle', attrs: { textPreset: 'unknown' } },
        { type: 'unknownMark' },
      ] },
    ] },
  ] }} />);

  const styled = getByText('Reference');
  expect(styled).toHaveAttribute('data-text-preset', 'h3');
  expect(styled).toHaveStyle({ color: '#dc2626', fontWeight: '600' });
  expect(styled.closest('a')).not.toBeNull();
  expect(container.querySelector('[href]')).toBeNull();
  expect(getByText('Other').closest('a, [data-text-preset]')).toBeNull();
  expect(container.querySelector('p')?.style.textAlign).toBe('');
});
