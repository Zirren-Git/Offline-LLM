/**
 * The model-output grammar and its parsers — one source so the streaming
 * suppressor, the stored-content stripper and the display parse can never
 * disagree on which formats count as reasoning or tool calls.
 */

// ── Reasoning delimiters ─────────────────────────────────────────────────────

export interface ReasoningDelimiter {
  /** Opener; the grammar allows an optional newline right after it. */
  open: string;
  close: string;
}

/**
 * Ordered longest-open-first so a more specific opener wins when prefixes
 * overlap (`<|channel|>analysis` before `<|channel>thought`).
 */
export const REASONING_DELIMITERS: ReasoningDelimiter[] = [
  { open: '<|channel|>analysis<|message|>', close: '<|channel|>final<|message|>' },
  { open: '<|channel>thought', close: '<channel|>' },
  { open: '<think>', close: '</think>' },
];

// ── Tool-call delimiters (Gemma-native string form) ──────────────────────────

/**
 * A tool-call block runs from any opener to the nearest closer (either closer
 * can end any opener). The colon form (`<tool_call:`) is accepted by the parser,
 * so the stripper knows it too.
 */
export const TOOL_CALL_OPENERS: string[] = [
  '<|tool_call>',
  '<tool_call>',
  '<tool_call:',
  '<tool_call>',
];
export const TOOL_CALL_CLOSERS: string[] = ['<tool_call|>', '</tool_call>', '</tool_call>'];

/** XML-style tool-call markup (`<function=NAME>…<parameter=NAME>…</function>`). */
export const XML_TOOL_CALL_FUNCTION_MARKER = '<function=';
export const XML_TOOL_CALL_PARAMETER_MARKER = '<parameter=';

// ── Partial-tag holdback (streaming) ─────────────────────────────────────────

/** Length of the longest suffix of `text` that is a PREFIX of `tag`. */
export function partialTagSuffix(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let size = max; size > 0; size -= 1) {
    if (text.endsWith(tag.slice(0, size))) return size;
  }
  return 0;
}

/** Longest suffix of `text` that is a prefix of ANY tag. */
export function maxPartialTagSuffix(text: string, tags: string[]): number {
  let best = 0;
  for (const tag of tags) best = Math.max(best, partialTagSuffix(text, tag));
  return best;
}

// ── Label marker ─────────────────────────────────────────────────────────────

const LABEL_MARKER = /^__LABEL:([^_]*(?:_[^_]+)*?)__\s*/;

function takeLabel(body: string): { text: string; label?: string } {
  const match = LABEL_MARKER.exec(body);
  if (!match) return { text: body };
  return { text: body.slice(match[0].length), label: match[1]!.trim() };
}

// ── Reasoning extraction ─────────────────────────────────────────────────────

interface InlineReasoning {
  reasoning: string | null;
  reasoningLabel?: string;
  answer: string;
  complete: boolean;
}

function extractInlineReasoning(content: string): InlineReasoning {
  for (const { open, close } of REASONING_DELIMITERS) {
    const openAt = content.indexOf(open);
    if (openAt < 0) continue;
    const bodyStart = openAt + open.length;
    const afterOpen = content.slice(bodyStart).replace(/^\r?\n/, '');
    const bodyOffset = content.length - bodyStart - afterOpen.length;
    const closeAt = content.indexOf(close, bodyStart + bodyOffset);
    const complete = closeAt >= 0;
    const body = complete
      ? content.slice(bodyStart + bodyOffset, closeAt)
      : afterOpen;
    const tail = complete ? content.slice(closeAt + close.length) : '';
    const head = content.slice(0, openAt);
    const { text, label } = takeLabel(body);
    return {
      reasoning: text.trim(),
      ...(label ? { reasoningLabel: label } : {}),
      answer: `${head}\n${tail}`,
      complete,
    };
  }
  return { reasoning: null, answer: content, complete: true };
}

export interface SplitInlineReasoning {
  answer: string;
  reasoning: string | null;
  reasoningLabel?: string;
}

/** Split stored content that may carry inline thinking markup. */
export function splitInlineReasoning(content: string): SplitInlineReasoning {
  const found = extractInlineReasoning(content ?? '');
  return {
    answer: found.answer.trim(),
    reasoning: found.reasoning,
    ...(found.reasoningLabel ? { reasoningLabel: found.reasoningLabel } : {}),
  };
}

// ── Control / tool-call stripping ────────────────────────────────────────────

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

const TOOL_BLOCK_PATTERNS: RegExp[] = TOOL_CALL_OPENERS.map(
  opener =>
    new RegExp(
      String.raw`${escapeRegExp(opener)}[\s\S]*?(?:${TOOL_CALL_CLOSERS.map(escapeRegExp).join('|')}|$)`,
      'g',
    ),
);

const XML_FUNCTION_BLOCK_PATTERN = new RegExp(
  String.raw`${escapeRegExp(XML_TOOL_CALL_FUNCTION_MARKER)}[\s\S]*?<\/function>`,
  'gi',
);

const CONTROL_TOKEN_PATTERNS: RegExp[] = [
  /<\|im_start\|>\s*(?:system|assistant|user|tool)?\s*\n?/gi,
  /<\|im_end\|>\s*\n?/gi,
  /<\|end\|>/gi,
  /<\|eot_id\|>/gi,
  /<\/s>/gi,
  /<\|">\s*/g,
  ...TOOL_BLOCK_PATTERNS,
  XML_FUNCTION_BLOCK_PATTERN,
  /<function_call>/gi,
  /<invoke[^>]*>/gi,
  /<\/invoke>/gi,
];

/** Strip all control tokens including thinking delimiters (finalised content). */
export function stripChatControlTokens(content: string): string {
  let text = content ?? '';
  for (const pattern of CONTROL_TOKEN_PATTERNS) text = text.replace(pattern, '');
  for (const { open, close } of REASONING_DELIMITERS) {
    text = text.split(open).join('').split(close).join('');
  }
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

// ── Full parses ──────────────────────────────────────────────────────────────

export interface ChatThinkingContent {
  response: string;
  thinking: string | null;
  thinkingLabel?: string;
  isThinkingComplete: boolean;
}

/** Split raw model output into thinking + visible response. */
export function parseChatThinkingContent(content: string): ChatThinkingContent {
  const found = extractInlineReasoning(content ?? '');
  return {
    response: stripChatControlTokens(found.answer),
    thinking: found.reasoning,
    ...(found.reasoningLabel ? { thinkingLabel: found.reasoningLabel } : {}),
    isThinkingComplete: found.complete,
  };
}

export interface ChatModelOutput {
  answer: string;
  reasoning: string | null;
  reasoningLabel?: string;
  isReasoningComplete: boolean;
}

/**
 * THE single display parse: split a raw assistant string (or a separate
 * reasoning channel + content) into reasoning + a clean answer. The answer is
 * guaranteed free of reasoning, control tokens and tool-call markup.
 */
export function parseChatModelOutput(
  content: string,
  reasoningContent?: string | null,
): ChatModelOutput {
  const inline = extractInlineReasoning(content ?? '');
  const answer = stripChatControlTokens(inline.answer);
  if (reasoningContent && reasoningContent.trim()) {
    const { text, label } = takeLabel(reasoningContent);
    return {
      answer,
      reasoning: text.trim(),
      ...(label ? { reasoningLabel: label } : {}),
      isReasoningComplete: true,
    };
  }
  return {
    answer,
    reasoning: inline.reasoning,
    ...(inline.reasoningLabel ? { reasoningLabel: inline.reasoningLabel } : {}),
    isReasoningComplete: inline.complete,
  };
}

// ── Supporting chat context ──────────────────────────────────────────────────

export const PROMPT_ENHANCEMENT_REASONING_LABEL = 'Enhanced prompt';
export const PROMPT_ENHANCEMENT_STATUS = 'Enhancing your prompt…';

const SUPPORTING_CONTEXT_LABELS = new Set<string>([PROMPT_ENHANCEMENT_REASONING_LABEL]);

export interface SupportContextShape {
  answer?: string | null;
  reasoning?: string | null;
  reasoningLabel?: string | null;
}

/**
 * A message that is context attached to the following bubble (the enhanced-
 * prompt card), not a chat turn of its own.
 */
export function isSupportingChatContext(input: SupportContextShape): boolean {
  return Boolean(input.reasoningLabel && SUPPORTING_CONTEXT_LABELS.has(input.reasoningLabel));
}

// ── Runtime notices ──────────────────────────────────────────────────────────

const RUNTIME_NOTICE_PATTERNS: RegExp[] = [
  /^Model (loaded|unloaded|load failed|switched)/i,
  /^Draft discarded[:.]/i,
  /^(Download|Import|Export|Share) (failed|complete|cancelled|started|paused|resumed)/i,
  /^Load failed[:.]/i,
  /^Transcription (failed|stopped|cancelled)/i,
  /^Voice (download|removal|download failed|cancelled)/i,
  /^Backup (created|restored|failed)/i,
  /^(Stopped|Cancelled) at user request/i,
];

/**
 * Whether a message reports device/app state rather than conversation — the
 * classifier that protects both the sync log and the prompt-enrichment corpus.
 */
export function isRuntimeOnlyMessage(input: {
  role?: string;
  content?: string;
  notice?: boolean;
}): boolean {
  if (input.notice === true) return true;
  if (input.role === 'system') return true;
  const content = (input.content ?? '').trim();
  return RUNTIME_NOTICE_PATTERNS.some(pattern => pattern.test(content));
}

// ── Chat list preview ────────────────────────────────────────────────────────

/** The one-line summary a conversation list row shows. */
export function chatListPreviewLine(role?: string, content?: string): string {
  const flat = (content ?? '')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/\s+/g, ' ')
    .trim();
  const prefixed = role === 'user' ? `You: ${flat}` : flat;
  if (!prefixed) return '';
  return prefixed.length > 120 ? `${prefixed.slice(0, 117)}…` : prefixed;
}

// ── Markdown preprocessing ───────────────────────────────────────────────────

/**
 * Fix the markdown quirks the phone renderer mishandles before it renders:
 * GFM task-list checkboxes leak as literal `[ ]`, so they become glyphs here.
 */
export function preprocessChatMarkdown(text: string): string {
  return (text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/^(\s*[-*+])\s+\[ \]\s+/gm, '$1 ☐ ')
    .replace(/^(\s*[-*+])\s+\[[xX]\]\s+/gm, '$1 ☑ ');
}

// ── External URL safety ──────────────────────────────────────────────────────

/** HTTPS/HTTP/mailto/tel only; everything else (javascript:, file:, data:, …) is refused. */
export function safeChatExternalUrl(url: string | null | undefined): string | null {
  const value = (url ?? '').trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.href;
    if (parsed.protocol === 'mailto:' || parsed.protocol === 'tel:') return parsed.href;
    return null;
  } catch {
    return null;
  }
}
