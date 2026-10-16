import {
  isSupportingChatContext,
  splitInlineReasoning,
} from '@offgrid/sync';
import { Message } from '../../types';
import { visibleMessages } from '../../utils/visibleMessages';
export type ChatMessageItem = Message & {
  statusText?: string;
  suppressMessageBubble?: boolean;
  /** Display-only context rendered inside the following generated-image bubble. */
  supportingContext?: Message;
};

const groupedImageCache = new WeakMap<
  Message,
  { supportingContext: Message; item: ChatMessageItem }
>();

function isSupportingContextMessage(message: Message): boolean {
  if (message.role !== 'assistant' || message.attachments?.length) return false;
  const inline = splitInlineReasoning(message.content);
  if (!inline.reasoningLabel) return false;
  return isSupportingChatContext({
    answer: inline.answer,
    reasoning: message.reasoningContent || inline.reasoning,
    reasoningLabel: inline.reasoningLabel,
  });
}

function isReasoningOnlyMessage(message: Message): boolean {
  if (message.role !== 'assistant' || message.attachments?.length) return false;
  const inline = splitInlineReasoning(message.content);
  return Boolean(
    (message.reasoningContent || inline.reasoning || '').trim() &&
      !inline.answer.trim(),
  );
}

function hasImageAttachment(message: Message): boolean {
  return (
    message.role === 'assistant' &&
    Boolean(
      message.attachments?.some(attachment => attachment.type === 'image'),
    )
  );
}

function isGeneratedImageResult(message: Message): boolean {
  return (
    message.role === 'assistant' &&
    /^Generated image for:/i.test(message.content.trim())
  );
}

function withPendingGeneratedImage(message: Message): Message {
  if (hasImageAttachment(message)) return message;
  return {
    ...message,
    attachments: [
      {
        id: `pending-image:${message.uuid ?? message.id}`,
        type: 'image',
        uri: '',
        pending: true,
        fileName: 'Image arriving',
      },
    ],
  };
}

/**
 * Keep durable chat records unchanged, but present an image turn as one assistant result.
 *
 * Image generation writes the enhanced prompt first and the image result second. When those records
 * are adjacent, the final image owns the prompt, image, caption, metadata, and actions on screen.
 * An unfinished or cancelled prompt stays visible as its own supporting-context row.
 */
function groupSupportingContextWithImage(
  messages: readonly (Message | ChatMessageItem)[],
): (Message | ChatMessageItem)[] {
  const grouped: (Message | ChatMessageItem)[] = [];
  for (const message of messages) {
    const supportingContext = grouped.at(-1);
    if (
      (hasImageAttachment(message) || isGeneratedImageResult(message)) &&
      supportingContext &&
      isSupportingContextMessage(supportingContext)
    ) {
      grouped.pop();
      const cached = groupedImageCache.get(message);
      if (cached?.supportingContext === supportingContext) {
        grouped.push(cached.item);
        continue;
      }
      const item: ChatMessageItem = {
        ...withPendingGeneratedImage(message),
        supportingContext,
      };
      groupedImageCache.set(message, { supportingContext, item });
      grouped.push(item);
      continue;
    }
    grouped.push(message);
  }
  return grouped;
}

const groupedWorkCache = new WeakMap<
  Message,
  { work: readonly Message[]; live: boolean; item: Message }
>();

/** Present the tool records between one user prompt and its answer as one assistant timeline. */
function groupAssistantTurnWork(
  messages: readonly (Message | ChatMessageItem)[],
  live: boolean,
): (Message | ChatMessageItem)[] {
  const grouped: (Message | ChatMessageItem)[] = [];
  let work: Message[] = [];
  const flush = (final?: Message | ChatMessageItem, groupLive = false) => {
    if (!work.length) {
      if (final) grouped.push(final);
      return;
    }
    const response =
      final ??
      [...work]
        .reverse()
        .find(
          message =>
            message.role === 'assistant' &&
            !isSupportingContextMessage(message) &&
            !message.toolCalls?.length &&
            Boolean(message.content.trim() || message.attachments?.length),
        );
    const terminal = [...work]
      .reverse()
      .find(
        message =>
          message.role === 'assistant' &&
          (message.turnStatus === 'failed' ||
            message.turnStatus === 'cancelled'),
      );
    if (!response && !terminal && !groupLive) {
      grouped.push(...work);
      work = [];
      return;
    }
    const owner = response ?? terminal ?? {
      ...work.at(-1)!,
      role: 'assistant' as const,
      content: '',
    };
    const supportingContext =
      (response as ChatMessageItem | undefined)?.supportingContext ??
      work.find(isSupportingContextMessage);
    const cached = groupedWorkCache.get(owner);
    if (
      cached &&
      cached.live === groupLive &&
      cached.work.length === work.length &&
      cached.work.every((message, index) => message === work[index])
    ) {
      grouped.push(cached.item);
      work = [];
      return;
    }
    const artifacts: NonNullable<Message['toolArtifacts']> = [];
    const timeline: NonNullable<Message['timeline']> = [];
    const artifactByCallId = new Map<string, number>();
    for (const message of work) {
      if (message.role === 'assistant') {
        const inline = splitInlineReasoning(message.content);
        const reasoning = message.reasoningContent || inline.reasoning || '';
        if (
          message !== supportingContext &&
          reasoning.trim() &&
          !message.timeline?.some(entry => entry.kind === 'thinking')
        ) {
          timeline.push({ kind: 'thinking', text: reasoning });
        }
        for (const call of message.toolCalls ?? []) {
          const toolIndex = artifacts.length;
          artifacts.push({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
            result: '',
            status: groupLive ? 'running' : 'completed',
          });
          if (call.id) artifactByCallId.set(call.id, toolIndex);
          timeline.push({ kind: 'tool', toolIndex });
        }
        continue;
      }
      const matchingIndex = message.toolCallId
        ? artifactByCallId.get(message.toolCallId)
        : undefined;
      if (matchingIndex !== undefined) {
        artifacts[matchingIndex] = {
          ...artifacts[matchingIndex]!,
          result: message.content,
          status: 'completed',
          durationMs: message.generationTimeMs,
        };
      } else {
        timeline.push({ kind: 'tool', toolIndex: artifacts.length });
        artifacts.push({
          id: message.toolCallId,
          name: message.toolName ?? 'unknown',
          result: message.content,
          status: 'completed',
          durationMs: message.generationTimeMs,
        });
      }
    }
    const ownerArtifacts = owner.toolArtifacts ?? [];
    let replacedOwnerArtifactCount = 0;
    while (
      replacedOwnerArtifactCount < artifacts.length &&
      replacedOwnerArtifactCount < ownerArtifacts.length &&
      artifacts[replacedOwnerArtifactCount]?.name ===
        ownerArtifacts[replacedOwnerArtifactCount]?.name
    ) {
      replacedOwnerArtifactCount += 1;
    }
    const ownerTimeline: NonNullable<Message['timeline']> = [];
    for (const entry of owner.timeline ?? []) {
      if (entry.kind !== 'tool') {
        ownerTimeline.push(entry);
      } else if (entry.toolIndex >= replacedOwnerArtifactCount) {
        ownerTimeline.push({
          ...entry,
          toolIndex:
            entry.toolIndex - replacedOwnerArtifactCount + artifacts.length,
        });
      }
    }
    const item: ChatMessageItem = {
      ...owner,
      ...(supportingContext ? { supportingContext } : {}),
      content: response && (!groupLive || owner.isStreaming) ? owner.content : '',
      isStreaming: groupLive || owner.isStreaming,
      turnStatus: terminal?.turnStatus ?? owner.turnStatus,
      toolCalls: undefined,
      toolArtifacts: [
        ...artifacts,
        ...ownerArtifacts.slice(replacedOwnerArtifactCount),
      ],
      timeline: [
        ...timeline,
        ...ownerTimeline,
      ],
    };
    groupedWorkCache.set(owner, { work: [...work], live: groupLive, item });
    grouped.push(item);
    work = [];
  };

  for (const message of messages) {
    if (message.role === 'user') {
      flush();
      grouped.push(message);
      continue;
    }
    if (work.length && message.role === 'assistant') {
      work.push(message);
      continue;
    }
    if (
      message.role === 'tool' ||
      (message.role === 'assistant' &&
        (message.toolCalls?.length ||
          isSupportingContextMessage(message) ||
          isReasoningOnlyMessage(message)))
    ) {
      work.push(message);
      continue;
    }
    flush();
    grouped.push(message);
  }
  flush(undefined, live);
  return grouped;
}

/**
 * A reply generating on another device, mirrored into this conversation while it happens.
 *
 * Shaped by shared sync (`chatStreamPreviewRows`) rather than here, so the phone and the Mac append
 * the same rows in the same order under the same ids.
 */

export type StreamingState = {
  isThinking: boolean;
  streamingMessage: string;
  streamingReasoningContent: string;
  hasStreamingText?: boolean;
  isStreamingForThisConversation: boolean;
  isModelLoading?: boolean;
  loadingModelName?: string;
  isGeneratingForThisConversation?: boolean;
  /** What the turn is doing with its documents before the model starts ("Searching 3 documents…"). */
  documentStatus?: string;
  /** Live previews from paired devices. Empty in free builds and when nothing is generating. */
  /** This device's mesh id, so a peer's runtime notices can be told apart from its own. */
  localDeviceId?: string | null;
};

/**
 * Append the replies other devices are generating right now.
 *
 * They render through the SAME synthetic-streaming-message path as the local reply, so there is one
 * bubble implementation rather than a second renderer that would drift from it. Ids are namespaced
 * per generation so the list keeps one row per in-flight reply and never collides with the local
 * 'streaming' row - a device can be generating locally while a peer generates too.
 */
let _lastDisplayBranch = '';
export function getDisplayMessages(
  allMessages: Message[],
  streaming: StreamingState,
): (Message | ChatMessageItem)[] {
  const live = Boolean(
    streaming.isThinking ||
      streaming.isStreamingForThisConversation ||
      streaming.isGeneratingForThisConversation,
  );
  return groupAssistantTurnWork(
      groupSupportingContextWithImage(
        localDisplayMessages(
        // The same rule the list rows use, so the thread and its preview never disagree.
          [...visibleMessages(allMessages, streaming.localDeviceId)],
          streaming,
        ),
      ),

    live,
  );
}

function localDisplayMessages(
  allMessages: Message[],
  streaming: StreamingState,
): (Message | ChatMessageItem)[] {
  const {
    isThinking,
    streamingMessage,
    streamingReasoningContent,
    isStreamingForThisConversation,
  } = streaming;
  // Model still loading for the in-progress reply: show it in the bubble so the
  // wait is explained ("Loading <model>…") instead of bare dots.
  if (
    streaming.isModelLoading &&
    streaming.isGeneratingForThisConversation &&
    !streamingMessage &&
    !streaming.hasStreamingText
  ) {
    return [
      ...allMessages,
      {
        id: 'thinking',
        role: 'assistant' as const,
        content: streaming.loadingModelName
          ? `Loading ${streaming.loadingModelName}...`
          : 'Loading model...',
        timestamp: Date.now(),
        isThinking: true,
      },
    ];
  }
  // The turn is opening, searching or ranking its documents: say so in the same loader row.
  if (
    streaming.documentStatus &&
    (streaming.isGeneratingForThisConversation || isStreamingForThisConversation) &&
    !streamingMessage &&
    !streamingReasoningContent &&
    !streaming.hasStreamingText
  ) {
    return [
      ...allMessages,
      {
        id: 'thinking',
        role: 'assistant' as const,
        content: streaming.documentStatus,
        timestamp: Date.now(),
        isThinking: true,
      },
    ];
  }
  // The tool loop stays in the thinking phase until prose begins. Once reasoning
  // arrives, render that live stream instead of keeping the empty loader on top.
  if (
    isThinking &&
    isStreamingForThisConversation &&
    !streamingMessage &&
    !streamingReasoningContent &&
    !streaming.hasStreamingText
  ) {
    if (_lastDisplayBranch !== 'thinking') {
      _lastDisplayBranch = 'thinking';
    }
    return [
      ...allMessages,
      {
        id: 'thinking',
        role: 'assistant' as const,
        content: '',
        timestamp: Date.now(),
        isThinking: true,
      },
    ];
  }
  if (
    (streamingMessage ||
      streamingReasoningContent ||
      streaming.hasStreamingText) &&
    isStreamingForThisConversation
  ) {
    if (_lastDisplayBranch !== 'streaming') {
      _lastDisplayBranch = 'streaming';
    }
    return [
      ...allMessages,
      {
        id: 'streaming',
        role: 'assistant' as const,
        content: streamingMessage,
        reasoningContent: streamingReasoningContent || undefined,
        timestamp: Date.now(),
        isStreaming: true,
      },
    ];
  }
  // A remote tool-capable model can clear its initial thinking phase before it has emitted text,
  // reasoning, or a durable tool row. The generation session still owns this conversation, so keep
  // one local loader row until one of those displayable records replaces it.
  if (
    isStreamingForThisConversation ||
    streaming.isGeneratingForThisConversation
  ) {
    if (_lastDisplayBranch !== 'thinking') {
      _lastDisplayBranch = 'thinking';
    }
    return [
      ...allMessages,
      {
        id: 'thinking',
        role: 'assistant' as const,
        content: '',
        timestamp: Date.now(),
        isThinking: true,
      },
    ];
  }
  if (_lastDisplayBranch !== 'done') {
    _lastDisplayBranch = 'done';
  }
  return allMessages;
}

type PlaceholderTextOptions = {
  hasModel: boolean;
  isModelLoading: boolean;
  supportsVision: boolean;
  imageOnly?: boolean;
};

export function getPlaceholderText({
  hasModel,
  isModelLoading,
  supportsVision,
  imageOnly,
}: PlaceholderTextOptions): string {
  if (!hasModel)
    return isModelLoading ? 'Loading model...' : 'Load a model to use chat';
  if (imageOnly) return 'Describe an image...';
  return supportsVision
    ? 'Type a message or add an image...'
    : 'Type a message...';
}
