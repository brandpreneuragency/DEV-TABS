import { Extension } from '@tiptap/core';

export const INLINE_TEXT_PRESETS = ['h1', 'h2', 'h3'] as const;

export type InlineTextPresetName = (typeof INLINE_TEXT_PRESETS)[number];

const INLINE_PRESET_STYLES = {
  h1: { fontSize: 'var(--inline-preset-h1-size)', fontWeight: 700, lineHeight: 1.2 },
  h2: { fontSize: 'var(--inline-preset-h2-size)', fontWeight: 600, lineHeight: 1.3 },
  h3: { fontSize: 'var(--inline-preset-h3-size)', fontWeight: 600, lineHeight: 1.35 },
};

export function getInlineTextPresetStyle(value: unknown) {
  const preset = INLINE_TEXT_PRESETS.find(name => name === value);
  return preset && INLINE_PRESET_STYLES[preset];
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    inlineTextPreset: {
      setInlineTextPreset: (preset: InlineTextPresetName) => ReturnType
      unsetInlineTextPreset: () => ReturnType
    }
  }
}

declare module '@tiptap/extension-text-style' {
  interface TextStyleAttributes {
    textPreset?: InlineTextPresetName | null
  }
}

export const InlineTextPreset = Extension.create({
  name: 'inlineTextPreset',

  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          textPreset: {
            default: null,
            parseHTML: element => {
              const value = element.getAttribute('data-text-preset');

              return getInlineTextPresetStyle(value) ? value : null;
            },
            renderHTML: attributes => {
              const preset = attributes.textPreset;
              const style = getInlineTextPresetStyle(preset);

              if (!style) {
                return {};
              }

              return {
                'data-text-preset': preset,
                style: `font-size: ${style.fontSize}; font-weight: ${style.fontWeight}; line-height: ${style.lineHeight};`,
              };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setInlineTextPreset:
        (preset: InlineTextPresetName) =>
        ({ chain }) => {
          return chain().setMark('textStyle', { textPreset: preset }).run();
        },
      unsetInlineTextPreset:
        () =>
        ({ chain }) => {
          return chain().setMark('textStyle', { textPreset: null }).removeEmptyTextStyle().run();
        },
    };
  },
});
