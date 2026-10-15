/**
 * Advice for the GPU (mnn) image-generation path — the slow, quality-sensitive one used
 * when the device has no compatible NPU. Warn about settings below the minimum
 * resolution or step count. The NPU (qnn) and CoreML (ANE) paths get no advice.
 *
 * Pure + data-driven: it branches on the backend AS DATA (not a Platform/device check),
 * so it's unit-testable and the same rule drives the card on every surface.
 */
export interface ImageGenAdvice {
  /** Surface the advisory card at all (any tip applies). */
  show: boolean;
  /** Steps are below the quality floor for the GPU path. */
  raiseSteps: boolean;
  /** Resolution is below what SD1.5 can render coherently → garbage output. */
  raiseSize: boolean;
}

/** Below this, GPU-path output is visibly undercooked (muddy). */
export const QUALITY_STEP_FLOOR = 20;
/**
 * Minimum selectable resolution. This floor is separate from the 512x512 default.
 */
export const SWEET_SPOT_SIZE = 256;

/** Platform step counts. */
export const MAX_IMAGE_STEPS = 50;
const IMAGE_STEP_DEFAULTS = {
  android: MAX_IMAGE_STEPS,
  ios: MAX_IMAGE_STEPS,
} as const;

/** One owner for the platform default. Persisted user values still take precedence. */
export function defaultImageSteps(platform: string): number {
  return platform === 'ios'
    ? IMAGE_STEP_DEFAULTS.ios
    : IMAGE_STEP_DEFAULTS.android;
}

export function getImageGenAdvice(opts: {
  backend?: string | null;
  steps: number;
  width: number;
}): ImageGenAdvice {
  // Only the mnn (GPU/CPU) path is slow + step/size-sensitive. qnn (NPU) / coreml (ANE)
  // are fast and fixed-resolution, so tuning there isn't the same trade-off.
  if (opts.backend !== 'mnn') {
    return { show: false, raiseSteps: false, raiseSize: false };
  }
  const raiseSteps = opts.steps < QUALITY_STEP_FLOOR;
  const raiseSize = opts.width > 0 && opts.width < SWEET_SPOT_SIZE;
  return { show: raiseSteps || raiseSize, raiseSteps, raiseSize };
}
