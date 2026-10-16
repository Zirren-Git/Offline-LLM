export * from './chatGrammar';

export interface RecordProvenance { originDeviceId: string; updatedAt?: number; }
export type SyncedTurnStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type SyncedAssistantTimelineEntry = { kind: 'thinking'; text: string } | { kind: 'tool'; toolIndex: number };
export interface SyncedToolArtifact {
  id?: string;
  name: string;
  result: string;
  status?: SyncedTurnStatus;
  arguments?: string;
  durationMs?: number;
}
export interface SyncedRetrievalSource { name: string; score: number; }
export interface KnowledgeDocumentDescriptor { syncId: string; projectId: string; name: string; createdAt: string; enabled: boolean; }
export interface SharedFileDescriptor {
  syncId: string;
  [key: string]: unknown;
}
export const KNOWLEDGE_DOCUMENT_ENTITY = 'knowledge_document';
export const SHARED_FILE_ENTITY = 'shared_file';
export const TASK_LAUNCH_ENTITY = 'task_launch';
export const TASK_RUN_ENTITY = 'task_run';
export const TASK_CONTROL_ENTITY = 'task_control';
export function createKnowledgeDocumentStateFields(document: KnowledgeDocumentDescriptor): Record<string, unknown> {
  return { ...document };
}
export function createSharedFileStateFields(file: SharedFileDescriptor): Record<string, unknown> { return { ...file }; }
export interface SyncedMessageTurnInput {
  content: string | { type: string; text?: string }[];
  role?: string;
  context?: string | null;
  [key: string]: unknown;
}
export interface SyncedMessageTurnProjection {
  content: string;
  role?: string;
  [key: string]: unknown;
}
export function projectSyncedMessageTurn(input: SyncedMessageTurnInput): SyncedMessageTurnProjection | null {
  if (typeof input.content !== 'string') return null;
  return { ...input, content: input.content };
}
export function serializeSyncedMessageContext(context: Record<string, unknown>): string | null {
  const text = JSON.stringify(context);
  return text === '{}' ? null : text;
}
