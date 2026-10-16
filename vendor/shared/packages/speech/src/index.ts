/**
 * @offgrid/speech — spoken-turn decisions shared with desktop.
 *
 * One state machine for "what is this voice session doing", one silence
 * endpoint for "has this person finished talking", and the pure planning half
 * of dead-air trimming. No audio I/O lives here.
 */

// ── Voice turn settings (owned here so both settings screens agree) ──────────

export type VoiceTurnMode = 'tap' | 'silence' | 'handsfree';

export const VOICE_TURN_LABELS: Record<
  VoiceTurnMode,
  { label: string; description: string }
> = {
  tap: {
    label: 'Tap to talk',
    description: 'Press the microphone to start and stop. Nothing ends your turn but you.',
  },
  silence: {
    label: 'End on silence',
    description: 'Recording stops itself after you finish talking.',
  },
  handsfree: {
    label: 'Hands-free',
    description: 'The microphone reopens on its own and listens for the next thing you say.',
  },
};

export const VOICE_DELAY_LABELS = {
  silenceAfterSpeech: {
    label: 'End-of-turn silence',
    description: 'How long to wait after you stop talking before ending the turn.',
  },
  speakerDrain: {
    label: 'Reopen delay',
    description: 'How long the microphone waits after the assistant finishes, so it never hears itself.',
  },
} as const;

export const SILENCE_AFTER_SPEECH_CHOICES_MS: readonly number[] = [800, 1200, 2000, 3000];
export const DEFAULT_SILENCE_AFTER_SPEECH_MS = 1200;

export const SPEAKER_DRAIN_CHOICES_MS: readonly number[] = [300, 500, 800, 1200];
export const DEFAULT_SPEAKER_DRAIN_MS = 500;

/** "1s" / "0.5s" — pill labels for millisecond choices. */
export function secondsLabel(ms: number): string {
  const seconds = ms / 1000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

// ── Voice session state machine ──────────────────────────────────────────────

export type VoiceSessionState = 'listen' | 'speak' | 'stop';
export type VoiceSessionPhase =
  | 'idle'
  | 'listening'
  | 'recording'
  | 'transcribing'
  | 'thinking'
  | 'speaking';

export interface VoiceSession {
  state: VoiceSessionState;
  phase: VoiceSessionPhase;
  /** The mode this session was opened under (hands-free changes transitions). */
  handsFree: boolean;
  /** A replay owns the floor: its end returns it, and cancellation must not end the turn. */
  replayReturnsTo: { state: VoiceSessionState; phase: VoiceSessionPhase } | null;
}

export type VoiceSessionEvent =
  | 'userStart'
  | 'userStop'
  | 'turnCaptured'
  | 'dictationFinished'
  | 'nothingHeard'
  | 'replyStarted'
  | 'replyFinished'
  | 'replayStarted'
  | 'replayEnded';

export function initialVoiceSession(handsFree: boolean): VoiceSession {
  return { state: 'stop', phase: 'idle', handsFree, replayReturnsTo: null };
}

/** The microphone may be open only while listening. */
export function micShouldBeOpen(session: VoiceSession): boolean {
  return session.state === 'listen';
}

/** Audio may play only while the assistant holds the floor — a reply after a stop stays silent. */
export function speechMayPlay(session: VoiceSession): boolean {
  return session.state === 'speak';
}

export function nextVoiceSession(
  before: VoiceSession,
  event: VoiceSessionEvent,
  handsFree: boolean,
): VoiceSession {
  const session: VoiceSession = { ...before, handsFree };
  switch (event) {
    case 'userStart':
      return {
        ...session,
        state: 'listen',
        phase: handsFree ? 'listening' : 'recording',
        replayReturnsTo: null,
      };
    case 'turnCaptured':
      // The person's turn is over and there is audio to work on: the assistant
      // takes the floor now — before any reply exists — so the mic stays shut
      // while the turn transcribes and thinks.
      return { ...session, state: 'speak', phase: 'transcribing' };
    case 'nothingHeard':
      // One empty-turn verdict. Hands-free goes back to waiting for speech; a
      // tapped recording keeps capturing — nobody said the turn was over.
      if (session.state !== 'listen') return session;
      return { ...session, phase: handsFree ? 'listening' : 'recording' };
    case 'userStop':
      // A deliberate session stop: never returns to listening on its own.
      return initialVoiceSession(handsFree);
    case 'dictationFinished':
      // Chat dictation edits a draft and ends its own turn; a cancel does the same.
      return initialVoiceSession(handsFree);
    case 'replyStarted':
      if (session.state !== 'speak') return session;
      return { ...session, phase: 'thinking' };
    case 'replyFinished':
      if (session.state !== 'speak') return session;
      return { ...session, phase: 'speaking' };
    case 'replayStarted':
      return {
        ...session,
        state: 'speak',
        phase: 'speaking',
        replayReturnsTo: { state: before.state, phase: before.phase },
      };
    case 'replayEnded': {
      const back = before.replayReturnsTo;
      return back
        ? { ...session, state: back.state, phase: back.phase, replayReturnsTo: null }
        : { ...session, replayReturnsTo: null };
    }
    default:
      return session;
  }
}

// ── Silence endpoint (speech onset / end-of-turn window) ─────────────────────

/** Loudness detects speech about this long after it actually began. */
export const SPEECH_ONSET_LOOKBACK_MS = 300;

/** How long a level must stay under threshold before it is "not speech". */
const SPEECH_HANGOVER_MS = 250;

/**
 * Watches room loudness and decides when a spoken turn is over: once speech has
 * been heard, `silenceAfterSpeechMs` of quiet ends it. Also reports the quiet
 * tail so the trimmer can cut the end-of-turn window off the recording.
 */
export class SpeechEndpointTimer {
  private readonly onSilence: () => void;
  private readonly log: (line: string) => void;
  private startedAtMs = 0;
  private silenceAfterSpeechMs = DEFAULT_SILENCE_AFTER_SPEECH_MS;
  private handsFree = false;
  private active = false;
  private speechHeard = false;
  private lastSpeechAtMs = 0;
  private lastLevelAtMs = 0;
  private noiseFloor = 0.01;
  private ended = false;
  private cancelled = false;

  constructor(onSilence: () => void, log: (line: string) => void = () => undefined) {
    this.onSilence = onSilence;
    this.log = log;
  }

  begin(startedAtMs: number, opts: { handsFree: boolean; silenceAfterSpeechMs: number }): void {
    this.startedAtMs = startedAtMs;
    this.handsFree = opts.handsFree;
    this.silenceAfterSpeechMs =
      opts.silenceAfterSpeechMs > 0 ? opts.silenceAfterSpeechMs : DEFAULT_SILENCE_AFTER_SPEECH_MS;
    this.active = true;
    this.cancelled = false;
    this.ended = false;
    this.speechHeard = false;
    this.lastSpeechAtMs = 0;
    this.lastLevelAtMs = startedAtMs;
    this.log(
      `[VAD] endpoint begin (handsFree=${opts.handsFree}, silenceAfter=${this.silenceAfterSpeechMs}ms)`,
    );
  }

  observeLevel(rms: number): { speech: boolean } {
    if (!this.active || this.ended) return { speech: false };
    const now = Date.now();
    this.lastLevelAtMs = now;
    const level = Number.isFinite(rms) && rms >= 0 ? rms : 0;
    // Adaptive floor: quiet rooms pull the threshold down, loud ones push it up.
    this.noiseFloor = this.noiseFloor * 0.95 + level * 0.05;
    const threshold = Math.max(0.02, this.noiseFloor * 2.5);
    const isSpeech = level > threshold;
    if (isSpeech) {
      this.speechHeard = true;
      this.lastSpeechAtMs = now;
    } else if (this.speechHeard && now - this.lastSpeechAtMs >= this.silenceAfterSpeechMs) {
      this.ended = true;
      this.log('[VAD] end-of-turn silence window elapsed');
      // Never call back from inside the audio callback's own bookkeeping path
      // synchronously if the caller is mid-update — a microtask is enough.
      queueMicrotask(() => {
        if (this.active && !this.cancelled) this.onSilence();
      });
    }
    return { speech: isSpeech };
  }

  /** Quiet seconds at the tail of the turn (since the last heard speech, less the hangover). */
  quietTailSeconds(): number {
    if (!this.speechHeard || !this.lastSpeechAtMs) return 0;
    const quietMs = Date.now() - this.lastSpeechAtMs - SPEECH_HANGOVER_MS;
    return quietMs > 0 ? quietMs / 1000 : 0;
  }

  cancel(): void {
    this.cancelled = true;
    this.active = false;
    this.ended = true;
  }
}

// ── WAV trim planning ────────────────────────────────────────────────────────

/** Canonical PCM WAV header size — the I/O layer writes exactly this many bytes. */
export const WAV_HEADER_BYTES = 44;

/** How far into the head buffer to scan for RIFF chunks (extended headers). */
export const WAV_HEADER_SCAN_BYTES = 4096;

export interface WavTrimPlan {
  /** A rewritten canonical 44-byte header with the kept data size. */
  header: Uint8Array;
  /** Offset in the ORIGINAL file where the kept audio starts. */
  copyFrom: number;
  /** Bytes of audio to keep. */
  copyBytes: number;
  /** Seconds of audio dropped from both ends. */
  droppedSeconds: number;
}

interface WavLayout {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  byteRate: number;
  blockAlign: number;
  dataOffset: number;
  dataSize: number;
}

function readAscii(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length && offset + i < view.byteLength; i += 1) {
    out += String.fromCharCode(view.getUint8(offset + i));
  }
  return out;
}

function parseWav(head: Uint8Array, fileBytes: number): WavLayout | null {
  if (head.length < 44) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') return null;
  let channels = 1;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let byteRate = 0;
  let blockAlign = 0;
  let dataOffset = -1;
  let dataSize = 0;
  let cursor = 12;
  while (cursor + 8 <= head.length && cursor + 8 <= WAV_HEADER_SCAN_BYTES) {
    const id = readAscii(view, cursor, 4);
    const size = view.getUint32(cursor + 4, true);
    const body = cursor + 8;
    if (id === 'fmt ' && body + 16 <= head.length) {
      channels = view.getUint16(body + 2, true) || 1;
      sampleRate = view.getUint32(body + 4, true) || 16000;
      bitsPerSample = view.getUint16(body + 14, true) || 16;
      byteRate = view.getUint32(body + 8, true) || sampleRate * channels * (bitsPerSample / 8);
      blockAlign = view.getUint16(body + 12, true) || channels * (bitsPerSample / 8);
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = size;
      break;
    }
    if (size <= 0) return null;
    cursor = body + size + (size % 2);
  }
  if (dataOffset < 0 || byteRate <= 0 || blockAlign <= 0) return null;
  const remaining = fileBytes - dataOffset;
  if (remaining <= 0) return null;
  return {
    channels,
    sampleRate,
    bitsPerSample,
    byteRate,
    blockAlign,
    dataOffset,
    dataSize: Math.min(dataSize > 0 ? dataSize : remaining, remaining),
  };
}

function canonicalHeader(wav: WavLayout, dataBytes: number): Uint8Array {
  const header = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(header.buffer);
  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, wav.channels, true);
  view.setUint32(24, wav.sampleRate, true);
  view.setUint32(28, wav.byteRate, true);
  view.setUint16(32, wav.blockAlign, true);
  view.setUint16(34, wav.bitsPerSample, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  return header;
}

/**
 * WHERE to cut dead air off both ends of a recording. Returns null when the
 * header cannot be read, there is nothing worth dropping, or the trim would
 * leave no audio — the caller keeps the original untouched in every case.
 */
export function planWavTrim(
  head: Uint8Array,
  frontSeconds: number,
  fileBytes: number,
  tailSeconds: number,
): WavTrimPlan | null {
  const wav = parseWav(head, fileBytes);
  if (!wav) return null;
  const { byteRate, blockAlign, dataOffset, dataSize } = wav;

  const align = (bytes: number): number =>
    Math.min(dataSize, Math.max(0, Math.round(bytes / blockAlign) * blockAlign));
  const dropFront = align(frontSeconds * byteRate);
  const dropTail = align(tailSeconds * byteRate);

  const copyBytes = dataSize - dropFront - dropTail;
  if (dropFront + dropTail <= 0) return null;
  if (copyBytes < blockAlign) return null;

  return {
    header: canonicalHeader(wav, copyBytes),
    copyFrom: dataOffset + dropFront,
    copyBytes,
    droppedSeconds: (dropFront + dropTail) / byteRate,
  };
}

// ── Transcription languages ──────────────────────────────────────────────────

export interface TranscriptionLanguage {
  code: string;
  label: string;
}

const WHISPER_LANGUAGES: TranscriptionLanguage[] = [
  { code: 'auto', label: 'Auto-detect' },
  { code: 'en', label: 'English' },
  { code: 'zh', label: 'Chinese' },
  { code: 'de', label: 'German' },
  { code: 'es', label: 'Spanish' },
  { code: 'ru', label: 'Russian' },
  { code: 'ko', label: 'Korean' },
  { code: 'fr', label: 'French' },
  { code: 'ja', label: 'Japanese' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'tr', label: 'Turkish' },
  { code: 'pl', label: 'Polish' },
  { code: 'ca', label: 'Catalan' },
  { code: 'nl', label: 'Dutch' },
  { code: 'ar', label: 'Arabic' },
  { code: 'sv', label: 'Swedish' },
  { code: 'it', label: 'Italian' },
  { code: 'id', label: 'Indonesian' },
  { code: 'hi', label: 'Hindi' },
  { code: 'fi', label: 'Finnish' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'he', label: 'Hebrew' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'el', label: 'Greek' },
  { code: 'ms', label: 'Malay' },
  { code: 'cs', label: 'Czech' },
  { code: 'ro', label: 'Romanian' },
  { code: 'da', label: 'Danish' },
  { code: 'hu', label: 'Hungarian' },
  { code: 'ta', label: 'Tamil' },
  { code: 'no', label: 'Norwegian' },
  { code: 'th', label: 'Thai' },
  { code: 'ur', label: 'Urdu' },
  { code: 'hr', label: 'Croatian' },
  { code: 'bg', label: 'Bulgarian' },
  { code: 'lt', label: 'Lithuanian' },
  { code: 'sk', label: 'Slovak' },
  { code: 'te', label: 'Telugu' },
  { code: 'fa', label: 'Persian' },
  { code: 'lv', label: 'Latvian' },
  { code: 'bn', label: 'Bengali' },
  { code: 'sr', label: 'Serbian' },
  { code: 'az', label: 'Azerbaijani' },
  { code: 'sl', label: 'Slovenian' },
  { code: 'kn', label: 'Kannada' },
  { code: 'et', label: 'Estonian' },
  { code: 'mk', label: 'Macedonian' },
  { code: 'eu', label: 'Basque' },
  { code: 'is', label: 'Icelandic' },
  { code: 'hy', label: 'Armenian' },
  { code: 'ne', label: 'Nepali' },
  { code: 'mn', label: 'Mongolian' },
  { code: 'bs', label: 'Bosnian' },
  { code: 'kk', label: 'Kazakh' },
  { code: 'sq', label: 'Albanian' },
  { code: 'sw', label: 'Swahili' },
  { code: 'gl', label: 'Galician' },
  { code: 'mr', label: 'Marathi' },
  { code: 'pa', label: 'Punjabi' },
  { code: 'si', label: 'Sinhala' },
  { code: 'km', label: 'Khmer' },
  { code: 'so', label: 'Somali' },
  { code: 'af', label: 'Afrikaans' },
  { code: 'ka', label: 'Georgian' },
  { code: 'be', label: 'Belarusian' },
  { code: 'tg', label: 'Tajik' },
  { code: 'gu', label: 'Gujarati' },
  { code: 'am', label: 'Amharic' },
  { code: 'yi', label: 'Yiddish' },
  { code: 'lo', label: 'Lao' },
  { code: 'uz', label: 'Uzbek' },
  { code: 'fo', label: 'Faroese' },
  { code: 'ht', label: 'Haitian Creole' },
  { code: 'ps', label: 'Pashto' },
  { code: 'tk', label: 'Turkmen' },
  { code: 'nn', label: 'Norwegian Nynorsk' },
  { code: 'mt', label: 'Maltese' },
  { code: 'lb', label: 'Luxembourgish' },
  { code: 'my', label: 'Burmese' },
  { code: 'bo', label: 'Tibetan' },
  { code: 'tl', label: 'Tagalog' },
  { code: 'mg', label: 'Malagasy' },
  { code: 'as', label: 'Assamese' },
  { code: 'tt', label: 'Tatar' },
  { code: 'haw', label: 'Hawaiian' },
  { code: 'ln', label: 'Lingala' },
  { code: 'ha', label: 'Hausa' },
  { code: 'ba', label: 'Bashkir' },
  { code: 'jw', label: 'Javanese' },
  { code: 'su', label: 'Sundanese' },
  { code: 'yue', label: 'Cantonese' },
];

/** Languages a transcription engine offers. The model decides what it can actually hear. */
export function transcriptionLanguages(
  _engine: string,
  _modelId?: string,
): TranscriptionLanguage[] {
  return WHISPER_LANGUAGES.map(language => ({ ...language }));
}
