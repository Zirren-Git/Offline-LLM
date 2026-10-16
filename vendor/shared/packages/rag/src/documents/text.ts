/**
 * Pure text decisions: paging, token estimates, search terms, citation
 * splitting, and the `<source>` block wire format both ends parse.
 */
import type {
  CitedSource,
  DocumentChunk,
  DocumentPage,
  DocumentTurnStatus,
  FoundPassage,
} from './types';

/** Split pasted/file text into synthetic pages at paragraph boundaries. */
export function textParts(text: string): DocumentPage[] {
  const pages: DocumentPage[] = [];
  const paragraphs = text.split(/\n{2,}/);
  const PAGE_CHARS = 3000;
  let current = '';
  const flush = (): void => {
    if (current.trim()) pages.push({ page: pages.length + 1, text: current.trim() });
    current = '';
  };
  for (const paragraph of paragraphs) {
    if (current.length + paragraph.length > PAGE_CHARS && current.trim()) flush();
    current += (current ? '\n\n' : '') + paragraph;
  }
  flush();
  return pages;
}

/** ~4 characters per token — the portable estimate both hosts budget with. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'was', 'were',
  'it', 'its', 'on', 'for', 'with', 'that', 'this', 'these', 'those', 'be',
  'as', 'at', 'by', 'from', 'you', 'your', 'what', 'which', 'who', 'whom',
]);

/** Search terms from free text: lowercased words, stopwords dropped, deduped. */
export function contentTerms(text: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of text.toLowerCase().match(/[a-z0-9][a-z0-9']*/g) ?? []) {
    if (raw.length < 2 || STOP_WORDS.has(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    terms.push(raw);
  }
  return terms;
}

/** The FTS body indexed for a chunk: the document name leads so name matches rank. */
export function indexedText(name: string, chunk: Pick<DocumentChunk, 'heading' | 'text'>): string {
  return [name, chunk.heading ?? '', chunk.text].filter(Boolean).join('\n');
}

// ── Citations ────────────────────────────────────────────────────────────────

export type CitationSegment =
  | { kind: 'text'; text: string }
  | { kind: 'cite'; index: number };

const CITATION_TAG = /\[S(\d+(?:\s*,\s*S?\d+)*)\]/gi;

/** Split text into plain segments and [S#] / [S1, S2] citation segments. */
export function splitCitations(text: string): CitationSegment[] {
  const segments: CitationSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(CITATION_TAG)) {
    const at = match.index ?? 0;
    if (at > cursor) segments.push({ kind: 'text', text: text.slice(cursor, at) });
    for (const part of match[1]!.split(',')) {
      const index = Number.parseInt(part.replace(/[^0-9]/g, ''), 10);
      if (Number.isFinite(index) && index > 0) segments.push({ kind: 'cite', index });
    }
    cursor = at + match[0].length;
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) });
  return segments;
}

// ── `<source>` wire format (search_knowledge_base tool output) ───────────────

export interface SearchPassage {
  documentId: string;
  name: string;
  page: number;
  position: number;
  text: string;
  label?: string;
}

export interface ParsedSearchPassage {
  id: string;
  document: string;
  page: number;
  label?: string;
  text: string;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeId(id: number | string): string {
  if (typeof id === 'number') return `S${id}`;
  const digits = id.replace(/^S/i, '');
  return `S${digits}`;
}

/**
 * The text the search tool hands the model: one `<source>` block per passage
 * with the citation number the answer should use. The return's `sources` join
 * the turn's citation registry so tapping the tag opens the page.
 */
export function searchBlock(
  query: string,
  passages: readonly SearchPassage[],
  ids: ReadonlyArray<number | string>,
): { text: string; sources: CitedSource[] } {
  if (!passages.length) {
    return {
      text: `No passages found for "${query}". The documents in scope do not cover it.`,
      sources: [],
    };
  }
  const blocks: string[] = [];
  const sources: CitedSource[] = [];
  passages.forEach((passage, index) => {
    const id = normalizeId(ids[index] ?? index + 1);
    const label = passage.label ? ` label="${escapeAttribute(passage.label)}"` : '';
    blocks.push(
      `<source id="${id}" document="${escapeAttribute(passage.name)}" page="${passage.page}"${label}>` +
        `${passage.text}</source>`,
    );
    sources.push({
      id,
      position: passage.position,
      documentId: passage.documentId,
      name: passage.name,
      page: passage.page,
      ...(passage.label ? { label: passage.label } : {}),
      snippet: passage.text,
    });
  });
  return {
    text: `Passages for "${query}":\n${blocks.join('\n')}`,
    sources,
  };
}

const SOURCE_BLOCK =
  /<source\s+id="([^"]*)"\s+document="([^"]*)"\s+page="(\d+)"(?:\s+label="([^"]*)")?[^>]*>([\s\S]*?)<\/source>/gi;

/** Parse `<source>` blocks back into passages (empty when the search found none). */
export function parseSearchBlock(content: string): ParsedSearchPassage[] {
  const passages: ParsedSearchPassage[] = [];
  for (const match of content.matchAll(SOURCE_BLOCK)) {
    passages.push({
      id: normalizeId(match[1] ?? `${passages.length + 1}`),
      document: (match[2] ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
      page: Number(match[3] ?? 0),
      ...(match[4] ? { label: match[4] } : {}),
      text: (match[5] ?? '').trim(),
    });
  }
  return passages;
}

// ── Turn status copy ─────────────────────────────────────────────────────────

/** The live line a chat shows while its turn opens, searches and ranks documents. */
export function describeTurnStatus(status: DocumentTurnStatus): string {
  switch (status.phase) {
    case 'reading':
      return `Reading ${status.documents} document${status.documents === 1 ? '' : 's'}…`;
    case 'searching':
      return `Searching ${status.documents} document${status.documents === 1 ? '' : 's'}…`;
    case 'ranking':
      return `Ranking ${status.passages} passage${status.passages === 1 ? '' : 's'}…`;
    case 'composing':
      return `Preparing ${status.passages} passage${status.passages === 1 ? '' : 's'} for the answer…`;
    default:
      return 'Working with your documents…';
  }
}

export type { FoundPassage, DocumentChunk, DocumentPage, CitedSource, DocumentTurnStatus };
