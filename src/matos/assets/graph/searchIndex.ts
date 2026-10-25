import { readFileSync, statSync } from 'node:fs'
import type { MatOSAsset } from '../types.js'
import type {
  MatOSAssetGraphProvider,
  MatOSAssetSearchDocument,
  MatOSAssetSearchIndex,
} from './types.js'

const MAX_ENTRY_EXCERPT_CHARS = 2_000

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function safeMetadataText(metadata: Record<string, unknown>): string {
  const fields = [
    'summary',
    'group',
    'topic',
    'topics',
    'family',
    'failureClass',
    'backend',
    'binding',
    'mcpServer',
    'searchTerms',
    'roles',
    'tools',
    'toolNames',
    'signalKinds',
    'recommendedActions',
    'avoidRepeating',
    'mergeKey',
  ]
  return fields
    .flatMap(field => {
      const value = metadata[field]
      if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === 'string')
      }
      return typeof value === 'string' ? [value] : []
    })
    .join(' ')
}

function entryExcerpt(asset: MatOSAsset): string {
  if (!asset.entryAbsolutePath) {
    return ''
  }
  try {
    const info = statSync(asset.entryAbsolutePath)
    if (!info.isFile() || info.size > 256 * 1024) {
      return ''
    }
    return readFileSync(asset.entryAbsolutePath, 'utf8').slice(
      0,
      MAX_ENTRY_EXCERPT_CHARS,
    )
  } catch {
    return ''
  }
}

const CJK_RUN = /[\u4e00-\u9fff]+/u

/**
 * Split one raw term into index tokens. Latin/digit terms index as-is;
 * CJK runs additionally expand into character bigrams because Chinese text
 * has no word separators — without this, a whole Chinese sentence became a
 * single unmatchable token and Chinese queries scored zero against every
 * document. Bigrams on both the document and query side make lexical
 * matching language-symmetric; IDF keeps the noisy cross-word bigrams cheap.
 */
function expandTermTokens(term: string): string[] {
  if (!CJK_RUN.test(term)) {
    return term.length >= 2 ? [term] : []
  }
  const tokens: string[] = []
  const segments = term.match(/[\u4e00-\u9fff]+|[^\u4e00-\u9fff]+/gu) ?? []
  for (const segment of segments) {
    if (!CJK_RUN.test(segment)) {
      if (segment.length >= 2) {
        tokens.push(segment)
      }
      continue
    }
    if (segment.length === 1) {
      // Keep a lone CJK char only when it is the entire term; a single char
      // glued between latin runs ("用vasp") is separator-level noise.
      if (segment === term) {
        tokens.push(segment)
      }
      continue
    }
    for (let i = 0; i < segment.length - 1; i += 1) {
      tokens.push(segment.slice(i, i + 2))
    }
  }
  return tokens
}

export function tokenizeAssetGraphText(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff._-]+/u)
    .map(term => term.trim())
    .filter(Boolean)
    .flatMap(expandTermTokens)
}

function termCounts(text: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const term of tokenizeAssetGraphText(text)) {
    counts[term] = (counts[term] ?? 0) + 1
  }
  return counts
}

// Role composition builds a per-role mini search index for knowledge and
// experience context, so the same asset is re-tokenized once per delegated
// role (20+ times per launch). Documents are pure functions of the asset
// object, so cache them per asset identity; loaders create fresh asset
// objects per load, which naturally invalidates the WeakMap entries.
const searchDocumentCache = new WeakMap<
  MatOSAsset,
  Map<string, MatOSAssetSearchDocument>
>()

export function searchDocumentFromAsset(
  asset: MatOSAsset,
  options: { includeEntryExcerpt?: boolean } = {},
): MatOSAssetSearchDocument {
  const variant = options.includeEntryExcerpt ? 'excerpt' : 'plain'
  const cachedVariants = searchDocumentCache.get(asset)
  const cached = cachedVariants?.get(variant)
  if (cached) {
    return cached
  }
  const document = buildSearchDocumentFromAsset(asset, options)
  if (cachedVariants) {
    cachedVariants.set(variant, document)
  } else {
    searchDocumentCache.set(asset, new Map([[variant, document]]))
  }
  return document
}

function buildSearchDocumentFromAsset(
  asset: MatOSAsset,
  options: { includeEntryExcerpt?: boolean } = {},
): MatOSAssetSearchDocument {
  const text = [
    asset.canonicalKey,
    asset.type,
    asset.id,
    asset.name,
    optionalString(asset.description),
    asset.tags.join(' '),
    safeMetadataText(asset.metadata),
    options.includeEntryExcerpt ? entryExcerpt(asset) : '',
  ]
    .filter((value): value is string => Boolean(value))
    .join('\n')

  return {
    id: asset.canonicalKey,
    assetKey: asset.canonicalKey,
    assetType: asset.type,
    title: asset.name || asset.canonicalKey,
    text: '',
    tags: [...asset.tags].sort(),
    terms: termCounts(text),
    exactAliases: [
      asset.canonicalKey,
      `${asset.type}:${asset.id}`,
      asset.id,
      asset.name,
    ].filter((value): value is string => typeof value === 'string'),
    metadata: {
      lifecycleStatus: asset.lifecycle.status,
      group: optionalString(asset.metadata.group),
    },
  }
}

export function buildSearchIndex(
  documents: MatOSAssetSearchDocument[],
): MatOSAssetSearchIndex {
  const sortedDocuments = [...documents].sort((a, b) => a.id.localeCompare(b.id))
  const vocabulary: Record<string, number> = {}
  const byId: Record<string, MatOSAssetSearchDocument> = {}

  for (const document of sortedDocuments) {
    byId[document.id] = document
    for (const term of Object.keys(document.terms)) {
      vocabulary[term] = (vocabulary[term] ?? 0) + 1
    }
  }

  return {
    documents: byId,
    documentCount: sortedDocuments.length,
    vocabulary: Object.fromEntries(
      Object.entries(vocabulary).sort(([a], [b]) => a.localeCompare(b)),
    ),
  }
}

export const searchDocumentProvider: MatOSAssetGraphProvider = {
  id: 'search-document',
  stage: 'similarity',
  build(context) {
    return {
      searchDocuments: context.assets.map(asset =>
        searchDocumentFromAsset(asset, {
          includeEntryExcerpt: context.options.includeEntryExcerpts,
        }),
      ),
    }
  },
}
