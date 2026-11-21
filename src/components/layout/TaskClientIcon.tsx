import { Circle } from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { getSetting, setSetting } from '../../services/db';
import { useUIStore } from '../../stores/uiStore';

const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const maxImageBytes = 2 * 1024 * 1024;

async function readImage(file: File): Promise<string> {
  const source = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  const image = new Image();
  image.src = source;
  await image.decode();
  return source;
}

export function TaskClientIcon({ clientId, name }: { clientId: string; name: string }) {
  const { t } = useTranslation();
  const showToast = useUIStore((state) => state.showToast);
  const input = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<string>();
  const [saving, setSaving] = useState(false);
  const settingKey = `taskClientIcon:${clientId}`;
  const label = t('tasks.changeClientIcon', { name });

  useEffect(() => {
    let mounted = true;
    void getSetting(settingKey, '').catch(() => '').then((saved) => {
      if (mounted) setSource(saved);
    });
    return () => { mounted = false; };
  }, [settingKey]);

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || saving) return;
    if (!imageTypes.includes(file.type) || file.size > maxImageBytes) {
      showToast(t('tasks.clientIconFileType'), 'error');
      return;
    }

    setSaving(true);
    try {
      const nextSource = await readImage(file);
      await setSetting(settingKey, nextSource);
      setSource(nextSource);
    } catch {
      showToast(t('tasks.clientIconSaveError'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <button type="button" className="ui-icon-button scope-project-client-icon" title={label} aria-label={label}
        disabled={source === undefined || saving} onClick={() => input.current?.click()}>
        {source ? <img src={source} alt="" draggable={false} onError={() => setSource('')} /> : <Circle aria-hidden="true" />}
      </button>
      <input ref={input} type="file" accept={imageTypes.join(',')} aria-label={label} hidden onChange={upload} />
    </>
  );
}
