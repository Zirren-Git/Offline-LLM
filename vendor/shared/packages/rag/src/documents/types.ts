/**
 * Ports and record shapes for the shared document engine. The phone and the
 * desktop implement these against their own storage; the engine owns the rules.
 */

/** A document the engine can read. Text is either on disk (`path`) or inline. */
export interface DocumentSource {
  id: string;
  name: string;
  /** Reader selection: 'pdf' | 'text' (unknown kinds read as text). */
  kind: string;
  path?: string;
  text?: string;
}

export interface DocumentPage {
  /** 1-based page number. */
  page: number;
  text: string;
  label?: string;
  needsOcr?: boolean;
}

export interface ExtractPort {
  extract(
    source: DocumentSource,
    opts: {
      signal?: { aborted: boolean };
      onPages(pages: DocumentPage[]): void;
    },
  ): Promise<{ pageCount: number }>;
}

export interface EmbedPort {
  /** Identity of the embedder that produced the stored vectors. */
  embedder: string;
  embedPassages(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

/** Indexing waits for the foreground (e.g. while a reply streams). */
export interface Scheduler {
  yieldToForeground(): Promise<void>;
}

export type DocumentState = 'reading' | 'indexing' | 'ready' | 'failed';

export interface StoredDocument {
  id: string;
  name: string;
  kind: string;
  state: DocumentState;
  pageCount: number;
  chunkCount: number;
  embeddedCount: number;
  unreadablePages: number;
  embedder: string;
  schemaVersion: number;
  error?: string;
  createdAt: number;
  lastUsedAt: number;
}

export interface DocumentChunk {
  documentId: string;
  /** Stable order within the document. */
  position: number;
  page: number;
  label?: string;
  heading?: string;
  text: string;
  tokens: number;
}

export interface KeywordHit {
  documentId: string;
  position: number;
  /** bm25 rank; lower is better. */
  rank: number;
}

export interface DocumentIndexStore {
  getDocument(id: string): Promise<StoredDocument | null>;
  putDocument(document: StoredDocument): Promise<void>;
  updateDocument(id: string, patch: Partial<StoredDocument>): Promise<void>;
  putPages(id: string, pages: DocumentPage[]): Promise<void>;
  readPages(id: string): Promise<DocumentPage[]>;
  clearChunks(id: string): Promise<void>;
  appendChunks(id: string, chunks: DocumentChunk[]): Promise<void>;
  readChunks(id: string): Promise<DocumentChunk[]>;
  putVectors(id: string, from: number, vectors: number[][]): Promise<void>;
  readVectors(id: string): Promise<Map<number, Float32Array>>;
  putMap(id: string, positions: number[] | null): Promise<void>;
  readMap(id: string): Promise<number[] | null>;
  deleteDocument(id: string): Promise<void>;
  listDocuments(): Promise<Array<{ id: string; lastUsedAt: number }>>;
}

export interface KeywordSearchPort {
  search(documentIds: string[], query: string, limit: number): Promise<KeywordHit[]>;
}

export interface ConversationDocumentsPort {
  list(conversationId: string): Promise<DocumentSource[]>;
  excluded(conversationId: string): Promise<Set<string> | string[]>;
}

export interface ProjectDocumentsPort {
  forProject(projectId: string): Promise<DocumentSource[]>;
  forConversation(conversationId: string): Promise<DocumentSource[]>;
}

export interface DocumentProgress {
  id: string;
  phase: 'reading' | 'ocr' | 'indexing' | 'ready' | 'failed';
  done: number;
  total: number;
  error?: string;
}

/** A passage the turn numbered so an answer can cite it as [S#]. */
export interface CitedSource {
  id: string;
  documentId: string;
  name: string;
  page: number;
  label?: string;
  snippet: string;
}

/** A retrieved chunk, before citation numbering. */
export interface FoundPassage {
  documentId: string;
  name: string;
  page: number;
  position: number;
  text: string;
  label?: string;
  score?: number;
}

export interface DocumentScope {
  conversationId?: string;
  projectId?: string;
}

/** What the turn is doing with its documents, for a live status line. */
export type DocumentTurnStatus =
  | { phase: 'reading'; documents: number }
  | { phase: 'searching'; documents: number }
  | { phase: 'ranking'; passages: number }
  | { phase: 'composing'; passages: number };

export interface TurnBudget {
  ctx: number;
  replyReserve: number;
  systemTokens: number;
  requiredToolTokens: number;
  historyTokens: number;
  questionTokens: number;
  prefillTokensPerSecond: number;
  remote: boolean;
  /** < 1 on a retry after the prompt did not fit. */
  scale?: number;
}

export interface TurnPreparation {
  conversationId: string;
  projectId?: string;
  onStatus?(status: DocumentTurnStatus): void;
  /** Documents attached to the message being sent (may not be in the store yet). */
  current: DocumentSource[];
  question: string;
  previousQuestions?: string[];
  previousSources?: string[];
  budget: TurnBudget;
}

export interface TurnDocumentsResult {
  /** Goes after the system prompt; identical across turns while the documents do not change. */
  stable: string;
  /** Goes before this turn's question. */
  turn: string;
  sources: CitedSource[];
  usedKeys: string[];
}

export interface SearchToolResult {
  text: string;
  sources: CitedSource[];
}
