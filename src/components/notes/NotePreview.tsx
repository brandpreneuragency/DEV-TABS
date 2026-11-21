import type { JSONContent } from '@tiptap/react';
import { isAllowedUri } from '@tiptap/extension-link';
import type { ReactNode } from 'react';
import { getInlineTextPresetStyle } from '../editor/InlineTextPreset';

const TEXT_ALIGNMENTS = ['left', 'center', 'right', 'justify'] as const;

function renderMark(value: ReactNode, mark: NonNullable<JSONContent['marks']>[number]): ReactNode {
  switch (mark.type) {
    case 'bold': return <strong>{value}</strong>;
    case 'italic': return <em>{value}</em>;
    case 'underline': return <u>{value}</u>;
    case 'strike': return <s>{value}</s>;
    case 'code': return <code>{value}</code>;
    case 'textStyle': {
      const preset = mark.attrs?.textPreset;
      const style = getInlineTextPresetStyle(preset);
      const color = typeof mark.attrs?.color === 'string' ? mark.attrs.color : undefined;
      return <span data-text-preset={style ? preset : undefined} style={{ ...style, color }}>{value}</span>;
    }
    case 'link': {
      const href = mark.attrs?.href;
      // The card owns click and keyboard activation in preview mode.
      return typeof href === 'string' && href.trim() && isAllowedUri(href) ? <a>{value}</a> : value;
    }
    default: return value;
  }
}

function renderNode(node: JSONContent, key: number): ReactNode {
  if (node.type === 'text') {
    const text = node.text ?? '';
    return <span key={key}>{node.marks?.reduceRight<ReactNode>(renderMark, text) ?? text}</span>;
  }
  const children = node.content?.map(renderNode);
  switch (node.type) {
    case 'paragraph': {
      const textAlign = TEXT_ALIGNMENTS.find(value => value === node.attrs?.textAlign);
      return <p key={key} style={{ textAlign }}>{children ?? <br />}</p>;
    }
    case 'bulletList': return <ul key={key}>{children}</ul>;
    case 'orderedList': return <ol key={key} start={typeof node.attrs?.start === 'number' ? node.attrs.start : 1}>{children}</ol>;
    case 'listItem': return <li key={key}>{children}</li>;
    case 'hardBreak': return <br key={key} />;
    default: return <span key={key}>{children}</span>;
  }
}

/** Render the supported rich-text nodes as React, never raw imported HTML. */
export function NotePreview({ content }: { content: JSONContent }) {
  return <div className="notes-rich-text notes-preview">{content.content?.map(renderNode)}</div>;
}
