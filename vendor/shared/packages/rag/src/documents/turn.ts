/**
 * DocumentTurnService — the turn's view of its documents.
 *
 * prepare(): collect the documents in scope, retrieve the passages this
 * question needs within the turn's budget, and number them [S1…] so the answer
 * can cite pages. searchForTool(): the search_knowledge_base handler's engine —
 * same ranking, but passages the turn already numbered keep their tag.
 */
import type {
  CitedSource,
  ConversationDocumentsPort,
  DocumentChunk,
  DocumentIndexStore,
  DocumentScope,
  DocumentSource,
  DocumentTurnStatus,
  EmbedPort,
  FoundPassage,
  KeywordSearchPort,
  ProjectDocumentsPort,
  SearchToolResult,
  TurnDocumentsResult,
  TurnPreparation,
} from './types';
import { estimateTokens, searchBlock } from './text';
import type { DocumentIngestService } from './ingest';

interface TurnDeps {
  ingest: DocumentIngestService;
  store: DocumentIndexStore;
  conversations: ConversationDocumentsPort;
  projects: ProjectDocumentsPort;
  keyword: KeywordSearchPort;
  embed: EmbedPort;
  countTokens(text: string): number;
  onWarning?: (message: string, error: unknown) => void;
}

/** Space the document block may fill before the prompt stops fitting. */
const MIN_DOC_TOKENS = 256;
/** A reply reads its prompt at prefill speed; this is how long a turn will wait. */
const PREFILL_SECONDS = 2.5;
const SEARCH_CANDIDATES = 24;
const TOOL_PASSAGES = 6;

function passageKey(documentId: string, page: number, position: number): string {
  return `${documentId}:${page}:${position}`;
}

function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
  const length = Math.min(a.length, b.length);
  if (!length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export class DocumentTurnService {
  private readonly deps: TurnDeps;

  constructor(deps: TurnDeps) {
    this.deps = deps;
  }

  /** Every document the scope can read, minus the ones the person switched off. */
  private async scopeSources(scope: DocumentScope): Promise<DocumentSource[]> {
    const { projects, conversations, onWarning } = this.deps;
    const collected: DocumentSource[] = [];
    let excluded = new Set<string>();
    try {
      if (scope.conversationId) {
        excluded = new Set(await conversations.excluded(scope.conversationId));
        collected.push(...(await conversations.list(scope.conversationId)));
      }
    } catch (error) {
      onWarning?.('Conversation documents unavailable', error);
    }
    try {
      const projectSources = scope.projectId
        ? await projects.forProject(scope.projectId)
        : scope.conversationId
          ? await projects.forConversation(scope.conversationId)
          : [];
      collected.push(...projectSources);
    } catch (error) {
      onWarning?.('Project documents unavailable', error);
    }
    const byId = new Map<string, DocumentSource>();
    for (const source of collected) {
      if (!excluded.has(source.id) && !byId.has(source.id)) byId.set(source.id, source);
    }
    return [...byId.values()];
  }

  /** Retrieve and rank the passages that answer `query` across `sources`. */
  private async rankedPassages(
    sources: DocumentSource[],
    query: string,
    limit: number,
  ): Promise<FoundPassage[]> {
    const { store, keyword, embed, onWarning } = this.deps;
    if (!sources.length || !query.trim()) return [];
    const names = new Map(sources.map(source => [source.id, source.name]));

    // Keyword side: bm25 order, converted to a 0..1 positional score.
    const keywordScores = new Map<string, number>();
    try {
      const hits = await keyword.search(sources.map(source => source.id), query, limit * 2);
      hits.forEach((hit, index) => {
        keywordScores.set(`${hit.documentId}:${hit.position}`, 1 - index / (hits.length + 1));
      });
    } catch (error) {
      onWarning?.('Keyword search failed', error);
    }

    // Vector side: cosine against the stored chunk vectors.
    const vectorScores = new Map<string, number>();
    try {
      const queryVector = await embed.embedQuery(query);
      for (const source of sources) {
        const vectors = await store.readVectors(source.id);
        vectors.forEach((vector, position) => {
          const key = `${source.id}:${position}`;
          const score = (cosine(queryVector, vector) + 1) / 2;
          vectorScores.set(key, score);
        });
      }
    } catch (error) {
      onWarning?.('Vector search failed', error);
    }

    // Merge: either side can surface a chunk; both sides' scores are honoured.
    const combined = new Map<string, number>();
    for (const [key, score] of keywordScores) combined.set(key, score);
    for (const [key, score] of vectorScores) {
      combined.set(key, Math.max(combined.get(key) ?? 0, score * 0.95));
    }

    // Load the chunks the scores refer to.
    const chunkScores = new Map<DocumentChunk, number>();
    for (const source of sources) {
      const prefix = `${source.id}:`;
      const mine = [...combined.entries()].filter(([key]) => key.startsWith(prefix));
      if (!mine.length) continue;
      const chunks = await store.readChunks(source.id);
      for (const [key, score] of mine) {
        const position = Number(key.slice(prefix.length));
        const chunk = chunks.find(candidate => candidate.position === position);
        if (chunk && chunk.text.trim()) {
          chunkScores.set(chunk, Math.max(chunkScores.get(chunk) ?? 0, score));
        }
      }
    }

    return [...chunkScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([chunk, score]) => ({
        documentId: chunk.documentId,
        name: names.get(chunk.documentId) ?? chunk.documentId,
        page: chunk.page,
        position: chunk.position,
        text: chunk.text,
        ...(chunk.label ? { label: chunk.label } : {}),
        score,
      }));
  }

  /** Documents this turn reads: message attachments, chat history, knowledge base. */
  async prepare(input: TurnPreparation): Promise<TurnDocumentsResult | null> {
    const { store, ingest, countTokens } = this.deps;
    const { onStatus } = input;

    const scopeSources = await this.scopeSources({
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
    });
    const byId = new Map(scopeSources.map(source => [source.id, source]));
    for (const source of input.current) byId.set(source.id, source);
    const all = [...byId.values()];
    if (!all.length) return null;

    onStatus?.({ phase: 'reading', documents: all.length });
    for (const source of all) {
      const stored = await store.getDocument(source.id);
      if (!stored || stored.state === 'failed') await ingest.ingest(source);
    }

    // Budget: the document block fills what the turn can spare, and never more
    // than this phone can read at prefill speed.
    const budget = input.budget;
    const reserved =
      budget.replyReserve +
      budget.systemTokens +
      budget.requiredToolTokens +
      budget.historyTokens +
      budget.questionTokens;
    const contextRoom = Math.max(0, budget.ctx - reserved);
    const prefillRoom = Math.max(
      MIN_DOC_TOKENS,
      Math.floor((budget.prefillTokensPerSecond > 0 ? budget.prefillTokensPerSecond : 200) * PREFILL_SECONDS),
    );
    const scale = budget.scale && budget.scale > 0 ? Math.min(1, budget.scale) : 1;
    const documentBudget = Math.max(
      MIN_DOC_TOKENS,
      Math.floor(Math.min(contextRoom, prefillRoom) * scale),
    );

    onStatus?.({ phase: 'searching', documents: all.length });
    const queries = [input.question, ...(input.previousQuestions ?? [])].filter(Boolean);
    const merged = new Map<string, FoundPassage>();
    for (const query of queries) {
      for (const passage of await this.rankedPassages(all, query, SEARCH_CANDIDATES)) {
        const key = passageKey(passage.documentId, passage.page, passage.position);
        const existing = merged.get(key);
        if (!existing || (existing.score ?? 0) < (passage.score ?? 0)) merged.set(key, passage);
      }
    }

    onStatus?.({ phase: 'ranking', passages: merged.size });
    // Follow-ups stay on the page a previous turn already opened.
    const previous = new Set(input.previousSources ?? []);
    const ranked = [...merged.values()].sort((a, b) => {
      const aBoost = previous.has(passageKey(a.documentId, a.page, a.position)) ? 0.02 : 0;
      const bBoost = previous.has(passageKey(b.documentId, b.page, b.position)) ? 0.02 : 0;
      return (b.score ?? 0) + bBoost - ((a.score ?? 0) + aBoost);
    });

    // Pack the best passages into the budget, in rank order.
    const chosen: FoundPassage[] = [];
    let usedTokens = 0;
    for (const passage of ranked) {
      const tokens = Math.max(1, countTokens(passage.text) || estimateTokens(passage.text));
      if (usedTokens + tokens > documentBudget && chosen.length) continue;
      chosen.push(passage);
      usedTokens += tokens;
    }
    if (!chosen.length && ranked.length) chosen.push(ranked[0]!);

    const sourcesOut: CitedSource[] = chosen.map((passage, index) => ({
      id: `S${index + 1}`,
      position: passage.position,
      documentId: passage.documentId,
      name: passage.name,
      page: passage.page,
      ...(passage.label ? { label: passage.label } : {}),
      snippet: passage.text,
    }));
    const usedKeys = chosen.map(passage =>
      passageKey(passage.documentId, passage.page, passage.position),
    );

    onStatus?.({ phase: 'composing', passages: chosen.length });

    const names = [...new Set(all.map(source => source.name))];
    const stable =
      '\n\n<documents>\n' +
      `Documents in this conversation: ${names.join(', ')}.\n` +
      'Answer from these documents when they cover the question. Cite the pages you used as [S#] tags ' +
      '(for example [S1]) matching the numbered passages. If the documents do not cover the question, say so plainly.\n' +
      '</documents>';
    const turn = chosen.length
      ? '\n\n<sources>\n' +
        sourcesOut
          .map(
            source =>
              `<source id="${source.id}" document="${source.name}" page="${source.page}">` +
              `${source.snippet}</source>`,
          )
          .join('\n') +
        '\n</sources>'
      : '';

    return {
      stable,
      turn,
      sources: sourcesOut,
      usedKeys,
    };
  }

  /** search_knowledge_base: ranked passages, numbered so citations stay stable across the turn. */
  async searchForTool(
    scope: DocumentScope,
    query: string,
    citationId: (passage: FoundPassage) => number,
    opts?: {
      conversationId?: string;
      projectId?: string;
      previousQuestions?: string[];
      onStatus?: (status: DocumentTurnStatus) => void;
    },
  ): Promise<SearchToolResult> {
    const { ingest, store } = this.deps;
    const combined: DocumentScope = {
      ...(scope.conversationId || opts?.conversationId
        ? { conversationId: scope.conversationId ?? opts?.conversationId }
        : {}),
      ...(scope.projectId || opts?.projectId
        ? { projectId: scope.projectId ?? opts?.projectId }
        : {}),
    };
    const sources = await this.scopeSources(combined);
    if (!sources.length) return searchBlock(query, [], []);

    opts?.onStatus?.({ phase: 'searching', documents: sources.length });
    for (const source of sources) {
      const stored = await store.getDocument(source.id);
      if (!stored || stored.state === 'failed') await ingest.ingest(source);
    }

    const queries = [query, ...(opts?.previousQuestions ?? [])].filter(Boolean);
    const merged = new Map<string, FoundPassage>();
    for (const one of queries) {
      for (const passage of await this.rankedPassages(sources, one, SEARCH_CANDIDATES)) {
        const key = passageKey(passage.documentId, passage.page, passage.position);
        const existing = merged.get(key);
        if (!existing || (existing.score ?? 0) < (passage.score ?? 0)) merged.set(key, passage);
      }
    }
    const ranked = [...merged.values()]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, TOOL_PASSAGES);
    if (!ranked.length) return searchBlock(query, [], []);

    opts?.onStatus?.({ phase: 'composing', passages: ranked.length });
    return searchBlock(query, ranked, ranked.map(passage => citationId(passage)));
  }
}
