/**
 * @offgrid/rag/documents — the shared document engine.
 *
 * Ports a host implements (storage, extraction, embeddings, keyword search) and
 * the services that own the rules (ingest once; retrieve, budget and cite per
 * turn). The phone wires its SQLite and PDF reader here; the desktop wires its
 * own. The rules stay one product.
 */
export * from './types';
export {
  textParts,
  estimateTokens,
  contentTerms,
  indexedText,
  splitCitations,
  searchBlock,
  parseSearchBlock,
  describeTurnStatus,
} from './text';
export type { CitationSegment, SearchPassage, ParsedSearchPassage } from './text';
export { DocumentIngestService, DOCUMENT_SCHEMA_VERSION, chunkPage } from './ingest';
export { DocumentTurnService } from './turn';
