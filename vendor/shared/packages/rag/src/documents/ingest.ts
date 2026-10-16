/**
 * DocumentIngestService — read a document once, keep it queryable forever.
 *
 * Extract pages → store them → chunk them → embed the chunks. Embedding is
 * best-effort: a document whose vectors could not be produced still lands as
 * 'ready' and still answers keyword searches (a phone that ran out of memory
 * must not lose its knowledge base).
 */
import type {
  DocumentChunk,
  DocumentIndexStore,
  DocumentProgress,
  DocumentPage,
  DocumentSource,
  EmbedPort,
  ExtractPort,
  Scheduler,
  StoredDocument,
} from './types';
import { estimateTokens } from './text';

export const DOCUMENT_SCHEMA_VERSION = 1;

/** Chunks target ~380 tokens with an 80-token overlap between neighbours. */
const CHUNK_TARGET_TOKENS = 380;
const CHUNK_OVERLAP_TOKENS = 80;
const EMBED_BATCH = 8;

interface IngestDeps {
  extract: ExtractPort;
  store: DocumentIndexStore;
  scheduler: Scheduler;
  embed: EmbedPort;
  onProgress?: (progress: DocumentProgress) => void;
  onWarning?: (message: string, error: unknown) => void;
}

function headingOf(text: string): string | undefined {
  const match = /^#{1,6}\s+(.+)$/m.exec(text);
  return match ? match[1]!.trim() : undefined;
}

/** Sentence/paragraph-aware chunking with neighbour overlap. */
export function chunkPage(
  documentId: string,
  page: DocumentPage,
  startPosition: number,
): DocumentChunk[] {
  const text = page.text.trim();
  if (!text) return [];
  const pieces = text.split(/(?<=[.!?])\s+|\n{2,}/);
  const bodies: string[] = [];
  let buffer = '';
  for (const piece of pieces) {
    const candidate = buffer ? `${buffer} ${piece}` : piece;
    if (estimateTokens(candidate) > CHUNK_TARGET_TOKENS && buffer.trim()) {
      bodies.push(buffer.trim());
      const words = buffer.trim().split(/\s+/);
      const keep = Math.max(1, Math.round((CHUNK_OVERLAP_TOKENS * 4) / 6));
      buffer = `${words.slice(-keep).join(' ')} ${piece}`;
    } else {
      buffer = candidate;
    }
  }
  if (buffer.trim()) bodies.push(buffer.trim());
  return bodies.map((body, index) => {
    const heading = headingOf(body);
    return {
      documentId,
      position: startPosition + index,
      page: page.page,
      ...(page.label ? { label: page.label } : {}),
      ...(heading ? { heading } : {}),
      text: body,
      tokens: estimateTokens(body),
    };
  });
}

export class DocumentIngestService {
  private readonly deps: IngestDeps;
  private readonly inFlight = new Map<string, Promise<StoredDocument | null>>();

  constructor(deps: IngestDeps) {
    this.deps = deps;
  }

  /** Read and index a document. Concurrent calls for one id share the work. */
  ingest(source: DocumentSource): Promise<StoredDocument | null> {
    const existing = this.inFlight.get(source.id);
    if (existing) return existing;
    const run = this.runIngest(source).finally(() => {
      this.inFlight.delete(source.id);
    });
    this.inFlight.set(source.id, run);
    return run;
  }

  isRunning(id: string): boolean { return this.inFlight.has(id); }

  private report(progress: DocumentProgress): void {
    try {
      this.deps.onProgress?.(progress);
    } catch {
      // Progress is advisory.
    }
  }

  private async runIngest(source: DocumentSource): Promise<StoredDocument | null> {
    const { store, extract, embed, scheduler, onWarning } = this.deps;
    const existing = await store.getDocument(source.id);
    if (existing && (existing.state === 'ready' || existing.state === 'indexing' || existing.state === 'reading')) {
      await store.updateDocument(source.id, { lastUsedAt: Date.now() });
      return existing;
    }

    const now = Date.now();
    await store.putDocument({
      id: source.id,
      name: source.name,
      kind: source.kind,
      state: 'reading',
      pageCount: 0,
      chunkCount: 0,
      embeddedCount: 0,
      unreadablePages: 0,
      embedder: embed.embedder,
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
      createdAt: existing?.createdAt ?? now,
      lastUsedAt: now,
    });
    this.report({ id: source.id, phase: 'reading', done: 0, total: 0 });

    let pages: DocumentPage[] = [];
    try {
      await extract.extract(source, {
        onPages: batch => {
          pages = pages.concat(batch);
          void store.putPages(source.id, batch).catch(error => onWarning?.('Storing pages failed', error));
          this.report({ id: source.id, phase: 'reading', done: pages.length, total: 0 });
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.updateDocument(source.id, { state: 'failed', error: message });
      this.report({ id: source.id, phase: 'failed', done: 0, total: 0, error: message });
      return store.getDocument(source.id);
    }

    const unreadablePages = pages.filter(page => !page.text.trim()).length;
    const chunks: DocumentChunk[] = [];
    for (const page of pages) {
      chunks.push(...chunkPage(source.id, page, chunks.length));
    }

    await store.clearChunks(source.id);
    await store.appendChunks(source.id, chunks);
    await store.putMap(
      source.id,
      chunks.length ? chunks.map(chunk => chunk.position) : null,
    );
    await store.updateDocument(source.id, {
      state: 'indexing',
      pageCount: pages.length,
      chunkCount: chunks.length,
      embeddedCount: 0,
      unreadablePages,
    });
    this.report({ id: source.id, phase: 'indexing', done: 0, total: chunks.length });

    let embedded = 0;
    for (let from = 0; from < chunks.length; from += EMBED_BATCH) {
      await scheduler.yieldToForeground();
      const batch = chunks.slice(from, from + EMBED_BATCH);
      try {
        const vectors = await embed.embedPassages(batch.map(chunk => chunk.text));
        await store.putVectors(source.id, from, vectors);
        embedded += vectors.length;
      } catch (error) {
        // Keyword search still answers; losing vectors must not lose the file.
        onWarning?.(`Embedding failed for ${source.name}; keeping it for keyword search`, error);
      }
      this.report({ id: source.id, phase: 'indexing', done: Math.min(from + batch.length, chunks.length), total: chunks.length });
    }

    await store.updateDocument(source.id, {
      state: 'ready',
      embeddedCount: embedded,
      lastUsedAt: Date.now(),
    });
    this.report({ id: source.id, phase: 'ready', pageCount: pages.length, done: chunks.length, total: chunks.length });
    return store.getDocument(source.id);
  }

  /** Delete unreferenced documents (ttlMs keeps a just-removed one briefly readable). */
  async collectGarbage(referencedIds: Iterable<string>, ttlMs: number): Promise<void> {
    const keep = new Set(referencedIds);
    const now = Date.now();
    for (const row of await this.deps.store.listDocuments()) {
      if (keep.has(row.id)) continue;
      if (ttlMs > 0 && now - row.lastUsedAt < ttlMs) continue;
      await this.deps.store.deleteDocument(row.id);
    }
  }
}
