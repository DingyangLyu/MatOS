import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@open-design/components';
import { Icon } from './Icon';
import { useT } from '../i18n';
import { exportAsMd } from '../runtime/exports';
import { exportMarkdownPdf, openMarkdownDocument, type MarkdownExportOptions } from '../runtime/markdown-export';
import styles from './MarkdownExportMenu.module.css';

export function MarkdownExportMenu({ markdown, title, projectId, fileName, disabled = false, getMarkdown }: MarkdownExportOptions & {
  markdown: string; disabled?: boolean; getMarkdown?: () => Promise<string>;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!open && !error) return;
    const update = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const height = menuRef.current?.offsetHeight || 132;
      setPosition({ left: Math.max(8, Math.min(anchor.right - 220, window.innerWidth - 228)),
        top: anchor.bottom + height + 8 < window.innerHeight ? anchor.bottom + 6 : Math.max(8, anchor.top - height - 6) });
    };
    update();
    window.addEventListener('resize', update);
    document.addEventListener('scroll', update, true);
    return () => { window.removeEventListener('resize', update); document.removeEventListener('scroll', update, true); };
  }, [open, error]);
  useEffect(() => {
    if (!open) return;
    const click = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', click);
    document.addEventListener('keydown', key);
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    return () => { document.removeEventListener('pointerdown', click); document.removeEventListener('keydown', key); };
  }, [open]);
  const options = { title, projectId, fileName };
  const text = () => getMarkdown ? getMarkdown() : Promise.resolve(markdown);
  const run = async (action: () => void | Promise<void>) => {
    setOpen(false); setError(null); setBusy(true);
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('fileViewer.exportFailed')); }
    finally { setBusy(false); trigger.current?.focus(); }
  };
  return <div className={styles.root} ref={ref}>
    <Button ref={trigger} variant="ghost" size="icon" disabled={disabled || busy || !markdown.trim()}
      title={busy ? t('fileViewer.exportingProgress') : t('fileViewer.download')}
      aria-label={t('fileViewer.download')} aria-haspopup="menu" aria-expanded={open}
      onClick={() => { setError(null); setOpen(value => !value); }} data-testid="markdown-export-menu">
      <Icon name={busy ? 'spinner' : 'download'} size={15} className={busy ? 'icon-spin' : undefined} />
    </Button>
    {open ? createPortal(<div ref={menuRef} role="menu" className={styles.menu} style={position} onKeyDown={event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length]?.focus();
    }}>
      <Button variant="ghost" role="menuitem" onClick={() => void run(async () => exportMarkdownPdf(await text(), options))}>
        <Icon name="file-text" size={15} />{t('fileViewer.exportPdf')}
      </Button>
      <Button variant="ghost" role="menuitem" onClick={() => void run(async () => exportAsMd(await text(), title))}>
        <Icon name="file-text" size={15} />{t('fileViewer.exportMd')}
      </Button>
      <Button variant="ghost" role="menuitem" onClick={() => {
        // Reserve the window during the click, before asynchronous history loading.
        const popup = window.open('', '_blank');
        if (popup) popup.opener = null;
        void run(async () => {
          if (!popup) throw new Error('Popup blocked');
          try { openMarkdownDocument(await text(), options, popup); }
          catch (error) { popup.close(); throw error; }
        });
      }}>
        <Icon name="external-link" size={15} />{t('fileViewer.open')}
      </Button>
    </div>, document.body) : null}
    {error ? createPortal(<div ref={menuRef} className={styles.error} role="alert" style={position}>
      {t('fileViewer.exportFailed')}<br />{error.slice(0, 240)}
    </div>, document.body) : null}
  </div>;
}
