/**
 * @offgrid/models — cross-platform model contracts.
 *
 * Pure decision logic shared by the phone and the desktop so one product rule
 * cannot drift into two: reasoning budgets on the wire, tool-loop budgets, and
 * model-specific image parameters. No I/O, no UI, no platform types.
 */

// ── Reasoning budget ─────────────────────────────────────────────────────────
// Budgets are TOKEN counts. AUTO lets the engine/model decide.

export const REASONING_BUDGET_AUTO = 0;

/** Slider steps offered in settings, ascending. Settings filters these against maxTokens. */
export const REASONING_BUDGET_OPTIONS: readonly number[] = [
  512, 1024, 2048, 4096, 8192, 16384,
];

/** Human label for a budget step ("Auto", "1k", "512"). */
export function reasoningBudgetLabel(budget: number): string {
  if (!Number.isFinite(budget) || budget <= REASONING_BUDGET_AUTO) return 'Auto';
  if (budget >= 1024 && budget % 1024 === 0) return `${budget / 1024}k`;
  return `${Math.round(budget)}`;
}

function normalizedBudget(budget: number | undefined): number {
  return typeof budget === 'number' && Number.isFinite(budget) && budget > 0
    ? Math.floor(budget)
    : REASONING_BUDGET_AUTO;
}

/**
 * llama.rn / llama-server completion fragment for a thinking budget. Spread at
 * the top level of completion params next to enable_thinking / reasoning_format.
 * AUTO omits the field entirely — the engine closes the thinking block itself.
 */
export function thinkingBudgetPayload(
  enabled: boolean,
  budget: number,
): { thinking_budget_tokens?: number } {
  const value = normalizedBudget(budget);
  if (!enabled || value <= REASONING_BUDGET_AUTO) return {};
  return { thinking_budget_tokens: value };
}

/**
 * chat_template_kwargs fragment for OpenAI-compatible servers that honour the
 * Qwen thinking switch (gated upstream on the advertised capability). Carries
 * enable_thinking itself so a spread never drops the switch.
 */
export function reasoningBudgetPayload(
  enabled: boolean,
  budget: number,
): { chat_template_kwargs: { enable_thinking: boolean; thinking_budget_tokens?: number } } {
  const value = normalizedBudget(budget);
  return {
    chat_template_kwargs: {
      enable_thinking: enabled,
      ...(enabled && value > REASONING_BUDGET_AUTO
        ? { thinking_budget_tokens: value }
        : {}),
    },
  };
}

/**
 * OpenRouter `reasoning` body fragment. A concrete budget is expressed as
 * reasoning max_tokens; AUTO leaves the effort to OpenRouter.
 */
export function openRouterReasoningPayload(
  enabled: boolean,
  budget: number,
): { reasoning: { enabled: boolean; max_tokens?: number } } {
  const value = normalizedBudget(budget);
  if (!enabled) return { reasoning: { enabled: false } };
  return {
    reasoning: {
      enabled: true,
      ...(value > REASONING_BUDGET_AUTO ? { max_tokens: value } : {}),
    },
  };
}

// ── Tool-loop budget ─────────────────────────────────────────────────────────

export const DEFAULT_MAX_TOOL_CALLS = 4;
export const MIN_MAX_TOOL_CALLS = 0;
export const MAX_MAX_TOOL_CALLS = 8;

/** ~24k chars ≈ 6k tokens: useful, but bounded so one oversized result cannot wedge a turn. */
export const MAX_TOOL_RESULT_CHARS = 24000;

/** Clamp a configured tool-call limit into the product range (integers only). */
export function normalizeMaxToolCalls(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_TOOL_CALLS;
  const rounded = Math.round(value);
  return Math.min(MAX_MAX_TOOL_CALLS, Math.max(MIN_MAX_TOOL_CALLS, rounded));
}

/**
 * Cap a tool result fed back to the model. Keeps the HEAD (overviews lead) and
 * tells the model it was truncated, so it cannot assume it saw everything.
 */
export function boundToolResult(name: string, content: string, maxChars: number): string {
  const cap = Math.max(256, Math.floor(maxChars));
  if (content.length <= cap) return content;
  const head = content.slice(0, cap);
  return `${head}\n\n[Tool "${name}" result truncated: showing the first ${cap} of ${content.length} characters.]`;
}

/** Characters a tool result may occupy in the model's context. */
export function toolResultCharBudget(input: {
  contextLength: number;
  promptChars: number;
  replyReserveTokens: number;
}): number {
  const ctx = Number.isFinite(input.contextLength) && input.contextLength > 0 ? input.contextLength : 4096;
  const promptTokens = Math.ceil((Number.isFinite(input.promptChars) ? input.promptChars : 0) / 4);
  const reserve = Number.isFinite(input.replyReserveTokens) ? Math.max(0, input.replyReserveTokens) : 0;
  const availableTokens = Math.max(64, ctx - promptTokens - reserve);
  return Math.min(MAX_TOOL_RESULT_CHARS, availableTokens * 4);
}

/** Characters the prompt currently occupies (messages + tool schemas), for budgeting. */
export function toolPromptChars(
  messages: Array<{ role?: string; content?: string | null }>,
  tools: unknown[] = [],
): number {
  let chars = 0;
  for (const message of messages) {
    chars += (message.role?.length ?? 0) + (message.content?.length ?? 0) + 8;
  }
  for (const tool of tools) {
    try {
      chars += JSON.stringify(tool)?.length ?? 0;
    } catch {
      chars += 64;
    }
  }
  return chars;
}

/** The calls that still fit under the per-turn tool budget. */
export function callsWithinToolBudget<T>(
  toolCalls: T[],
  totalSoFar: number,
  maxSteps: number,
): T[] {
  const remaining = Math.max(0, Math.floor(maxSteps) - Math.floor(totalSoFar));
  return toolCalls.slice(0, remaining);
}

/** The "answer now, from these results" nudge injected at the tool limit. */
export function toolLimitFinalAnswerInstruction(maxSteps: number): string {
  const steps = Math.max(1, Math.floor(maxSteps));
  return (
    `You have already used your maximum of ${steps} tool call step${steps === 1 ? '' : 's'} in this turn. ` +
    'Do not call any more tools. Write the final answer now from the tool results already in this conversation. ' +
    'If a tool failed or returned nothing, say so plainly instead of inventing its output.'
  );
}

/** Assemble completed tool results into one prompt block for a final-answer retry. */
export function finalResponseFromToolResults(prompt: string, results: string[]): string {
  const parts = results
    .map((result, index) => `Tool result ${index + 1}:\n${result}`)
    .join('\n\n');
  return [prompt, parts].filter(Boolean).join('\n\n');
}

// ── Image generation parameters ──────────────────────────────────────────────

export interface ImageParameterValues {
  steps?: number | null;
  cfgScale?: number | null;
  size?: number | null;
}

/** Per-model parameter overrides kept in settings. */
export interface ImageParameterStore {
  [modelId: string]: ImageParameterValues;
}

export interface ImageParameterResolution {
  steps: number;
  cfgScale: number;
  size: number;
}

const DEFAULT_IMAGE_STEPS = 28;
const DEFAULT_IMAGE_CFG_SCALE = 7;
const DEFAULT_IMAGE_SIZE = 512;

function finitePositive(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Model-specific parameter policy with store overrides applied. */
export function resolveImageParameters(
  model: { id: string; name?: string },
  store: ImageParameterStore,
): ImageParameterResolution {
  const values = store[model.id] ?? {};
  return {
    steps: Math.round(finitePositive(values.steps, DEFAULT_IMAGE_STEPS)),
    cfgScale: finitePositive(values.cfgScale, DEFAULT_IMAGE_CFG_SCALE),
    size: Math.round(finitePositive(values.size, DEFAULT_IMAGE_SIZE)),
  };
}

/** A request-level parameter wins when valid; otherwise the resolved model default. */
export function effectiveImageParameter(
  requested: number | undefined,
  resolved: number,
): number {
  return typeof requested === 'number' && Number.isFinite(requested) && requested > 0
    ? requested
    : resolved;
}
