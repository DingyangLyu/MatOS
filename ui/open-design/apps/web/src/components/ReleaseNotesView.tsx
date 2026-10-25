import { useEffect, useMemo, useState } from 'react';
import {
  MATOS_RELEASE_NOTES,
  releaseText,
  type ReleaseNote,
  type ReleaseNoteSectionKind,
} from '../content/releaseNotes';
import { useI18n, type Locale } from '../i18n';
import { Icon, type IconName } from './Icon';

const SECTION_ICONS: Record<ReleaseNoteSectionKind, IconName> = {
  added: 'plus',
  improved: 'sparkles',
  fixed: 'check',
};

function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
  return Promise.resolve();
}

function releaseSearchText(release: ReleaseNote, locale: Locale): string {
  return [
    release.version,
    release.commit ?? '',
    release.channel,
    release.tags.join(' '),
    releaseText(release.title, locale),
    releaseText(release.summary, locale),
    ...release.sections.flatMap((section) => [
      releaseText(section.title, locale),
      ...section.items.map((item) => releaseText(item, locale)),
    ]),
  ].join(' ').toLocaleLowerCase(locale);
}

export function ReleaseNotesView() {
  const { locale } = useI18n();
  const zh = locale === 'zh-CN' || locale === 'zh-TW';
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('all');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const tags = useMemo(
    () => [...new Set(MATOS_RELEASE_NOTES.flatMap((release) => release.tags))].sort(),
    [],
  );
  const visible = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(locale);
    return MATOS_RELEASE_NOTES.filter((release) => {
      if (tag !== 'all' && !release.tags.includes(tag)) return false;
      return !normalized || releaseSearchText(release, locale).includes(normalized);
    });
  }, [locale, query, tag]);

  useEffect(() => {
    if (!window.location.hash) return;
    const id = decodeURIComponent(window.location.hash.slice(1));
    window.requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ block: 'start' });
    });
  }, []);

  async function copyReleaseLink(release: ReleaseNote): Promise<void> {
    const url = new URL('/blog', window.location.origin);
    url.hash = release.id;
    await copyText(url.toString());
    setCopiedId(release.id);
    window.setTimeout(
      () => setCopiedId((current) => (current === release.id ? null : current)),
      1600,
    );
  }

  return (
    <section className="release-notes" aria-labelledby="release-notes-title" data-testid="release-notes-view">
      <header className="release-notes__header">
        <div className="release-notes__heading">
          <span className="release-notes__mark" aria-hidden>
            <Icon name="book-open" size={20} />
          </span>
          <div>
            <p>{zh ? '产品动态' : 'PRODUCT UPDATES'}</p>
            <h1 id="release-notes-title">{zh ? '发布说明' : 'Release notes'}</h1>
          </div>
        </div>
        <p className="release-notes__lede">
          {zh
            ? '记录 MatOS 已上线的能力、运行时改进和重要修复。每一项都对应经过验证的代码与部署。'
            : 'Validated MatOS capabilities, runtime improvements, and important fixes, linked to the code that shipped.'}
        </p>
      </header>

      <div className="release-notes__toolbar" aria-label={zh ? '筛选发布说明' : 'Filter release notes'}>
        <label className="release-notes__search">
          <Icon name="search" size={15} />
          <span className="sr-only">{zh ? '搜索发布说明' : 'Search release notes'}</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={zh ? '搜索版本、功能或修复…' : 'Search versions, features, or fixes…'}
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={zh ? '清空搜索' : 'Clear search'}
              title={zh ? '清空搜索' : 'Clear search'}
            >
              <Icon name="close" size={13} />
            </button>
          ) : null}
        </label>
        <div className="release-notes__filters" role="group" aria-label={zh ? '按主题筛选' : 'Filter by topic'}>
          <button
            type="button"
            className={tag === 'all' ? 'is-active' : undefined}
            onClick={() => setTag('all')}
            aria-pressed={tag === 'all'}
          >
            {zh ? '全部' : 'All'}
          </button>
          {tags.map((item) => (
            <button
              key={item}
              type="button"
              className={tag === item ? 'is-active' : undefined}
              onClick={() => setTag(item)}
              aria-pressed={tag === item}
            >
              {item}
            </button>
          ))}
        </div>
      </div>

      <div className="release-notes__layout">
        <div className="release-notes__feed" aria-live="polite">
          {visible.length ? visible.map((release) => (
            <article
              key={release.id}
              id={release.id}
              className="release-note"
              data-latest={release.latest ? 'true' : undefined}
              data-testid="release-note"
            >
              <div className="release-note__timeline" aria-hidden>
                <span><Icon name={release.latest ? 'sparkles' : 'fork'} size={14} /></span>
              </div>
              <div className="release-note__card">
                <header className="release-note__card-head">
                  <div className="release-note__identity">
                    <span className="release-note__avatar" aria-hidden>M</span>
                    <div>
                      <strong>MatOS</strong>
                      <span>
                        {zh ? '发布于' : 'released this on'}{' '}
                        <time dateTime={release.publishedAt}>
                          {new Intl.DateTimeFormat(locale, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                          }).format(new Date(release.publishedAt))}
                        </time>
                      </span>
                    </div>
                  </div>
                  <div className="release-note__head-actions">
                    {release.latest ? <span className="release-note__latest">{zh ? '最新' : 'Latest'}</span> : null}
                    <span className="release-note__channel">{release.channel}</span>
                    <button
                      type="button"
                      onClick={() => void copyReleaseLink(release)}
                      aria-label={zh ? '复制本期链接' : 'Copy link to this release'}
                      title={copiedId === release.id ? (zh ? '已复制' : 'Copied') : (zh ? '复制链接' : 'Copy link')}
                    >
                      <Icon name={copiedId === release.id ? 'check' : 'link'} size={14} />
                    </button>
                  </div>
                </header>

                <div className="release-note__body">
                  <div className="release-note__title-row">
                    <div>
                      <h2>{releaseText(release.title, locale)}</h2>
                      <code>v{release.version}</code>
                    </div>
                    {release.commitUrl ? (
                      <a
                        href={release.commitUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        title={zh ? '查看提交' : 'View commit'}
                      >
                        <Icon name="fork" size={13} />
                        <span>{release.commit}</span>
                        <Icon name="external-link" size={12} />
                      </a>
                    ) : null}
                  </div>
                  <p className="release-note__summary">{releaseText(release.summary, locale)}</p>
                  <div className="release-note__tags" aria-label={zh ? '发布主题' : 'Release topics'}>
                    {release.tags.map((item) => <span key={item}>{item}</span>)}
                  </div>

                  <div className="release-note__sections">
                    {release.sections.map((section) => (
                      <section key={section.kind} className="release-note__section" data-kind={section.kind}>
                        <h3>
                          <span aria-hidden><Icon name={SECTION_ICONS[section.kind]} size={13} /></span>
                          {releaseText(section.title, locale)}
                        </h3>
                        <ul>
                          {section.items.map((item, index) => (
                            <li key={`${section.kind}-${index}`}>{releaseText(item, locale)}</li>
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                </div>
              </div>
            </article>
          )) : (
            <div className="release-notes__empty" data-testid="release-notes-empty">
              <Icon name="search" size={20} />
              <strong>{zh ? '没有匹配的发布说明' : 'No matching release notes'}</strong>
              <span>{zh ? '尝试其他关键词或主题。' : 'Try another keyword or topic.'}</span>
              <button type="button" onClick={() => { setQuery(''); setTag('all'); }}>
                {zh ? '清除筛选' : 'Clear filters'}
              </button>
            </div>
          )}
        </div>

        <aside className="release-notes__index" aria-label={zh ? '版本目录' : 'Release index'}>
          <div className="release-notes__index-sticky">
            <h2>{zh ? '版本' : 'Versions'}</h2>
            <nav>
              {MATOS_RELEASE_NOTES.map((release) => (
                <a key={release.id} href={`#${release.id}`}>
                  <span>v{release.version}</span>
                  <small>{release.latest ? (zh ? '最新' : 'Latest') : release.channel}</small>
                </a>
              ))}
            </nav>
            <p>
              {zh
                ? '这里只记录已经通过验证并部署的更新。候选功能不会提前出现在发布说明中。'
                : 'Only validated and deployed changes appear here. Candidate work stays out until it ships.'}
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}
