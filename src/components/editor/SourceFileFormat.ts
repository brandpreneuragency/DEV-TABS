import { Extension } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { skipTrailingNodeMeta } from '@tiptap/extensions/trailing-node';
import { isTextFileDocument, TEXT_FILE_ATTRIBUTE } from '../../services/fileFormat';

/** Keep source-file identity through editor JSON, history and whole-document replacements. */
export const SourceFileFormat = Extension.create({
  name: 'sourceFileFormat',
  priority: 150,

  addGlobalAttributes() {
    return [{
      types: ['doc'],
      attributes: {
        [TEXT_FILE_ATTRIBUTE]: { default: false, rendered: false },
      },
    }];
  },

  addKeyboardShortcuts() {
    return {
      Enter: () => isTextFileDocument(this.editor.state.doc) && this.editor.commands.newlineInCode(),
    };
  },

  addProseMirrorPlugins() {
    return [new Plugin({
      filterTransaction(transaction, state) {
        // A rich-text trailing paragraph must not silently add a newline to a source file.
        if (isTextFileDocument(state.doc) || isTextFileDocument(transaction.doc)) {
          transaction.setMeta(skipTrailingNodeMeta, true);
        }
        return true;
      },
      appendTransaction(transactions, previous, current) {
        if (transactions.some((transaction) => transaction.docChanged)
          && isTextFileDocument(previous.doc) && !isTextFileDocument(current.doc)) {
          return current.tr.setDocAttribute(TEXT_FILE_ATTRIBUTE, true);
        }
        return null;
      },
      props: {
        attributes(state): Record<string, string> {
          return isTextFileDocument(state.doc)
            ? { spellcheck: 'false', 'data-text-file': 'true' }
            : {};
        },
      },
    })];
  },
});
