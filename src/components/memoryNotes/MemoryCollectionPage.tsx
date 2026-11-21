import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, ExternalLink, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { StoreApi, UseBoundStore } from 'zustand';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { MemoryNotesStore } from '../../stores/memoryNotesStore';
import { selectMemoryNotes, type MemoryNote, type MemoryNotesSort } from '../../services/memoryNotes/model';
import './memoryNotes.css';

interface CollectionItem extends MemoryNote { category?: string | null; sourceUrl?: string | null }

function externalHref(value: string | null | undefined): string | null {
  if (!value || !/^https?:\/\//i.test(value) || Array.from(value).some((char) => char.charCodeAt(0) <= 32)) return null;
  try {
    const url = new URL(value);
    return url.hostname && !url.username && !url.password ? value : null;
  } catch { return null; }
}

/** Shared presentation only: collection stores and filesystem roots stay independent. */
export function MemoryCollectionPage<T extends CollectionItem>({ store: useCollectionStore, translationKey, withCategories = false }: {
  store: UseBoundStore<StoreApi<MemoryNotesStore<T>>>;
  translationKey: 'memoryNotes' | 'memoryResources' | 'memoryToRead' | 'memorySomeday';
  withCategories?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? 'en';
  const notes = useCollectionStore((state) => state.notes);
  const issues = useCollectionStore((state) => state.issues);
  const loading = useCollectionStore((state) => state.loading);
  const error = useCollectionStore((state) => state.error);
  const hasSnapshot = useCollectionStore((state) => state.hasSnapshot);
  const selectedFileName = useCollectionStore((state) => state.selectedFileName);
  const load = useCollectionStore((state) => state.load);
  const select = useCollectionStore((state) => state.select);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<MemoryNotesSort>('updated');
  // null = all; empty string = root records. Real folder names cannot be '*'.
  const [category, setCategory] = useState<string | null>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const previousCard = useRef<string | null>(null);
  const selected = notes.find((note) => note.fileName === selectedFileName);
  const categories = [...new Set(notes.map((note) => note.category ?? ''))];
  if (category !== null && !categories.includes(category)) categories.push(category);
  categories.sort((a, b) => a.localeCompare(b, locale));
  const scoped = withCategories && category !== null ? notes.filter((note) => (note.category ?? '') === category) : notes;
  const cards = selectMemoryNotes(scoped, search, sort, locale);
  const filtered = Boolean(search.trim() || category !== null);
  const text = (key: string) => t(`${translationKey}.${key}`);
  const formatDate = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (selectedFileName) backRef.current?.focus();
    else if (previousCard.current) cardRefs.current.get(previousCard.current)?.focus();
  }, [selectedFileName]);

  const sourceLink = (note: T) => {
    const href = externalHref(note.sourceUrl);
    return href ? <a className="memory-resource-source" href={href} target="_blank" rel="noopener noreferrer"
      aria-label={t(`${translationKey}.source`, { title: note.title })} title={href}><ExternalLink />{text('sourceLabel')}</a> : null;
  };

  return <section className="ui-page-body memory-notes-page" aria-label={text('title')}>
    <div className="memory-notes-toolbar-wrapper">
      <div className="ui-toolbar memory-notes-toolbar">
        {selected ? <>
          <button ref={backRef} type="button" className="ui-button" onClick={() => select(null)}>
            <ArrowLeft />{text('back')}
          </button>
          <span className="memory-notes-toolbar-title">{selected.title}</span>
        </> : <>
          <label className="memory-notes-search"><Search />
            <input className="ui-input" type="search" aria-label={text('search')} placeholder={text('search')}
              value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
          </label>
          {withCategories && <select className="ui-input memory-notes-sort" aria-label={text('category')} value={category ?? '*'}
            onChange={(event) => setCategory(event.currentTarget.value === '*' ? null : event.currentTarget.value)}>
            <option value="*">{text('allCategories')}</option>
            {categories.map((name) => <option key={name} value={name}>{name || text('uncategorized')}</option>)}
          </select>}
          <select className="ui-input memory-notes-sort" aria-label={text('sort')} value={sort}
            onChange={(event) => setSort(event.currentTarget.value === 'title' ? 'title' : 'updated')}>
            <option value="updated">{text('sortUpdated')}</option>
            <option value="title">{text('sortTitle')}</option>
          </select>
        </>}
      </div>
    </div>
    {error && <div role="alert" className="memory-notes-message memory-notes-error">
      <p>{text(`error_${error}`)}</p>
      {hasSnapshot && <p>{text('stale')}</p>}
    </div>}
    {issues.length > 0 && <details className="memory-notes-message memory-notes-issues" role="alert">
      <summary>{t(`${translationKey}.incomplete`, { count: issues.length })}</summary>
      <ul>{issues.map((issue) => <li key={`${issue.fileName}:${issue.reason}`}><span>{issue.fileName}</span> — {text(`issue_${issue.reason}`)}</li>)}</ul>
    </details>}
    {loading && <p className="memory-notes-message" role="status">{text('loading')}</p>}
    {selected ? <article className="memory-notes-detail" aria-label={selected.title}>
      <header><h1>{selected.title}</h1>
        <div className="memory-notes-metadata"><span>{selected.fileName}</span>
          {withCategories && <span>{selected.category || text('uncategorized')}</span>}
          {selected.updated && <time dateTime={selected.updated}>{t(`${translationKey}.updated`, { date: formatDate(selected.updated) })}</time>}
          {sourceLink(selected)}
        </div>
      </header>
      <div className="memory-notes-markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
          a: ({ href, children }) => externalHref(href)
            ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
            : <span>{children}</span>,
          img: ({ alt }) => <span className="memory-notes-metadata">{t(`${translationKey}.imageNotLoaded`, { alt: alt ?? '' })}</span>,
          table: ({ children }) => <div className="memory-notes-table"><table>{children}</table></div>,
        }}>{selected.markdown}</ReactMarkdown>
      </div>
    </article> : cards.length > 0 ? <div className="memory-notes-grid" aria-label={text('grid')} aria-busy={loading}>
      {cards.map((note) => <article key={note.fileName} className="ui-card memory-notes-card">
        <button ref={(element) => {
          if (element) cardRefs.current.set(note.fileName, element);
          else cardRefs.current.delete(note.fileName);
        }} type="button" className="memory-notes-card-open" aria-label={t(`${translationKey}.open`, { title: note.title })}
          onClick={() => { previousCard.current = note.fileName; select(note.fileName); }}>
          <span className="memory-notes-card-title">{note.title}</span>
          <span className="memory-notes-preview">{note.preview || text('noPreview')}</span>
        </button>
        <footer className="memory-notes-metadata" title={note.fileName}>
          {withCategories && <span className="memory-resource-category">{note.category || text('uncategorized')}</span>}
          {note.updated ? <time dateTime={note.updated}>{formatDate(note.updated)}</time> : <span>{text('unknownDate')}</span>}
          {sourceLink(note)}
        </footer>
      </article>)}
    </div> : hasSnapshot && !loading && !error && issues.length === 0 ? <div className="memory-notes-empty">
      <BookOpen /><h2>{text(filtered ? 'noResults' : 'empty')}</h2>
      <p>{text(filtered ? 'noResultsHint' : 'emptyHint')}</p>
      {filtered && <button type="button" className="ui-button" onClick={() => { setSearch(''); setCategory(null); }}>{text('clearSearch')}</button>}
    </div> : null}
  </section>;
}
