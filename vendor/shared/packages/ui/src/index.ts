/**
 * @offgrid/ui — shared, finite progress contracts.
 *
 * Sources measure bytes and rate; views project once and render. Unknown stays
 * unknown: no NaN%, no invented zero-byte totals, no Infinity in the wire shape.
 */

/** What a download/import source reports. Every field may be absent or junk. */
export interface ProgressLike {
  bytesDownloaded?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  /** Source-computed percentage (0-100). Finite values win over the byte ratio. */
  progress?: number;
  status?: string;
}

/** Sanitised, render-ready projection. Every numeric field is finite or absent. */
export interface ProgressPresentation {
  currentBytes: number;
  totalBytes?: number;
  percentage?: number;
  bytesPerSecond?: number;
  /** A finished transfer (completed / failed / cancelled) — rate is no longer meaningful. */
  terminal: boolean;
}

export interface ProgressRateSample {
  currentBytes: number;
  sampledAtMs: number;
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function finiteNonNegative(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function projectProgress(input: ProgressLike): ProgressPresentation {
  const status = input.status ?? '';
  const terminal = TERMINAL_STATUSES.has(status);
  const currentBytes = finiteNonNegative(input.bytesDownloaded) ?? 0;
  const total = finiteNonNegative(input.totalBytes);
  const totalBytes = total !== undefined && total > 0 ? total : undefined;
  const bytesPerSecond = finiteNonNegative(input.bytesPerSecond);

  let percentage: number | undefined;
  if (status === 'completed') {
    percentage = 100;
  } else {
    const direct = finiteNonNegative(input.progress);
    if (direct !== undefined) {
      percentage = clampPercentage(direct);
    } else if (totalBytes !== undefined) {
      percentage = clampPercentage((currentBytes / totalBytes) * 100);
    }
  }

  return {
    currentBytes,
    ...(totalBytes !== undefined ? { totalBytes } : {}),
    ...(percentage !== undefined ? { percentage } : {}),
    ...(bytesPerSecond !== undefined ? { bytesPerSecond } : {}),
    terminal,
  };
}

/**
 * Rate between two byte observations. The first sample (or a non-increasing
 * one) has no finite rate to report — a resumed or restarted transfer must not
 * average against its own past.
 */
export function sampleProgressRate(
  previous: ProgressRateSample | undefined,
  sample: { currentBytes: number; sampledAtMs: number },
): { sample: ProgressRateSample; bytesPerSecond?: number } {
  const next: ProgressRateSample = {
    currentBytes: finiteNonNegative(sample.currentBytes) ?? 0,
    sampledAtMs: Number.isFinite(sample.sampledAtMs) ? sample.sampledAtMs : Date.now(),
  };
  if (
    !previous ||
    !Number.isFinite(previous.sampledAtMs) ||
    next.sampledAtMs <= previous.sampledAtMs ||
    next.currentBytes < previous.currentBytes
  ) {
    return { sample: next };
  }
  const deltaMs = next.sampledAtMs - previous.sampledAtMs;
  const deltaBytes = next.currentBytes - previous.currentBytes;
  return { sample: next, bytesPerSecond: (deltaBytes / deltaMs) * 1000 };
}
