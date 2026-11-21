import { useEffect, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import { useTranslation } from 'react-i18next';
import { db } from '../../services/db';
import { ContinuityRepository, type ContinuityRecord, type ReferenceRole } from '../../services/projectContinuity';
import { readContinuityFile, selectContinuityFile, type ContinuityPreview } from '../../services/projectContinuityFiles';
import { isTauriRuntime } from '../../services/runtime';
import './projectContinuity.css';

const repository = new ContinuityRepository(db);
const roles: ReferenceRole[] = ['source', 'workRecord'];

export function ProjectContinuity({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return <details className="project-continuity" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t('continuity.title')}</summary>
    {open && <ProjectContinuityBody key={projectId} projectId={projectId} />}
  </details>;
}

export function ProjectContinuityBody({ projectId, repo = repository }: { projectId: string; repo?: ContinuityRepository }) {
  const [current, setCurrent] = useState<{
    projectId: string; repo: ContinuityRepository; record: ContinuityRecord | null;
    error: string; version: number;
  } | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let previous = '';
    // Observe the exact project, authority and reference rows read by load().
    // A generation key also invalidates A -> B -> A transitions batched by React.
    const subscription = liveQuery(async () => {
      try { return { record: await repo.load(projectId), error: '' }; }
      catch { return { record: null, error: 'continuity.unavailable' }; }
    }).subscribe(value => {
      if (cancelled) return;
      const signature = value.record
        ? JSON.stringify([value.record.identity, value.record.revision]) : value.error;
      if (signature !== previous) { previous = signature; generation.current += 1; }
      setCurrent({ ...value, projectId, repo, version: generation.current });
    });
    return () => { cancelled = true; subscription.unsubscribe(); };
  }, [projectId, repo]);

  const active = current?.projectId === projectId && current.repo === repo ? current : null;
  return <ProjectContinuitySession key={`${projectId}:${active?.version ?? 'loading'}`}
    projectId={projectId} repo={repo} initialRecord={active?.record ?? null}
    initialError={active?.error ?? ''} />;
}

function ProjectContinuitySession({ projectId, repo, initialRecord, initialError }: {
  projectId: string; repo: ContinuityRepository; initialRecord: ContinuityRecord | null; initialError: string;
}) {
  const { t } = useTranslation();
  const [record, setRecord] = useState<ContinuityRecord | null>(initialRecord);
  const [preview, setPreview] = useState<(ContinuityPreview & { role: ReferenceRole }) | null>(null);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(false);
  const lock = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const act = async (work: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setPreview(null);
    try { await work(); }
    catch (cause) {
      if (mounted.current) setError(cause instanceof Error && cause.message.startsWith('continuity.')
        ? cause.message : 'continuity.unavailable');
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const change = (role: ReferenceRole, remove = false) => act(async () => {
    if (!record) return;
    const path = remove ? null : await selectContinuityFile();
    if (!mounted.current || (!remove && path === null)) return;
    const references = { ...record.references };
    if (remove) delete references[role];
    else if (path !== null) references[role] = path;
    const next = await repo.save(record, references);
    if (mounted.current) setRecord(next);
  });

  const read = (role: ReferenceRole) => act(async () => {
    if (!record) return;
    const path = record.references[role];
    if (!path) return;
    const before = await repo.load(projectId);
    if (!mounted.current) return;
    if (before.identity !== record.identity || before.revision !== record.revision) throw new Error('continuity.conflict');
    const value = await readContinuityFile(path);
    if (!mounted.current || !value) return;
    const after = await repo.load(projectId);
    if (after.identity !== record.identity || after.revision !== record.revision) throw new Error('continuity.conflict');
    if (mounted.current) setPreview({ ...value, role });
  });

  return <div className="project-continuity-body" aria-busy={busy}>
    <p>{t('continuity.localOnly')}</p>
    <div>{t('continuity.projectId')}: <code>{projectId}</code></div>
    <p>{t('continuity.boundary')}</p>
    {!isTauriRuntime() && <p>{t('continuity.desktopOnly')}</p>}
    {error && <p role="alert">{t(error)}</p>}
    <button type="button" className="ui-button" disabled={busy} onClick={() => void act(async () => {
      const value = await repo.load(projectId);
      if (mounted.current) setRecord(value);
    })}>{t('continuity.reload')}</button>
    {roles.map(role => <div key={role} className="project-continuity-reference">
      <strong>{t(`continuity.${role}`)}</strong>
      <code>{record?.references[role] ?? t('continuity.notLinked')}</code>
      <span>{t('continuity.unchecked')}</span>
      <div className="project-continuity-actions">
        <button type="button" className="ui-button" disabled={busy || !record || !isTauriRuntime()} onClick={() => void change(role)}>{t('continuity.select')}</button>
        <button type="button" className="ui-button" disabled={busy || !record?.references[role] || !isTauriRuntime()} onClick={() => void read(role)}>{t('continuity.read')}</button>
        <button type="button" className="ui-button" disabled={busy || !record?.references[role]} onClick={() => void change(role, true)}>{t('continuity.unlink')}</button>
      </div>
    </div>)}
    {preview && <section aria-label={t('continuity.preview')}>
      <strong>{t(`continuity.${preview.role}`)}</strong>
      <p>{t('continuity.snapshot', { at: new Date(preview.readAt).toLocaleString() })}</p>
      <p>{t('continuity.modified', { at: preview.modifiedAt === null ? t('continuity.unknown') : new Date(preview.modifiedAt).toLocaleString() })}</p>
      <pre className="project-continuity-preview">{preview.text}</pre>
    </section>}
  </div>;
}
