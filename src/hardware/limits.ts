import type { NormalizedWebGpuLimits, SlabSizingHint, WebGpuLimitsLike } from './types.js';

const MIB = 1024 * 1024;
const DEFAULT_MAX_SLAB_BYTES = 128 * MIB;
const MIN_SLAB_BYTES = 16 * MIB;

export function normalizeWebGpuLimits(limits?: WebGpuLimitsLike | null): NormalizedWebGpuLimits {
  return {
    maxBufferSize: limits?.maxBufferSize ?? 0,
    maxStorageBufferBindingSize: limits?.maxStorageBufferBindingSize ?? 0,
    maxComputeWorkgroupStorageSize: limits?.maxComputeWorkgroupStorageSize ?? 0,
    maxComputeInvocationsPerWorkgroup: limits?.maxComputeInvocationsPerWorkgroup ?? 0,
    maxStorageBuffersPerShaderStage: limits?.maxStorageBuffersPerShaderStage ?? 0,
  };
}

/**
 * Computes elevated WebGPU device limits clamped to adapter capabilities so
 * runtimes do not get stuck on WebGPU's 128 MiB / 256 MiB defaults.
 * Ensures `maxStorageBufferBindingSize <= maxBufferSize <= adapterLimits.maxBufferSize`.
 */
export function computeElevatedLimits(
  adapterLimits: WebGpuLimitsLike,
  requestedLimits?: Record<string, number>,
): Record<string, number> {
  const elevated: Record<string, number> = { ...(requestedLimits ?? {}) };

  const adapterMaxBuffer = adapterLimits.maxBufferSize;
  const reqMaxBuffer = requestedLimits?.maxBufferSize;
  if (typeof adapterMaxBuffer === 'number' && adapterMaxBuffer > 0) {
    elevated.maxBufferSize =
      typeof reqMaxBuffer === 'number' && reqMaxBuffer > 0
        ? Math.min(Math.max(reqMaxBuffer, adapterMaxBuffer), adapterMaxBuffer)
        : adapterMaxBuffer;
  }

  const effectiveMaxBuffer = elevated.maxBufferSize ?? adapterMaxBuffer;
  const adapterMaxStorage = adapterLimits.maxStorageBufferBindingSize;
  const reqMaxStorage = requestedLimits?.maxStorageBufferBindingSize;
  if (typeof adapterMaxStorage === 'number' && adapterMaxStorage > 0) {
    const rawTarget =
      typeof reqMaxStorage === 'number' && reqMaxStorage > 0
        ? Math.max(reqMaxStorage, adapterMaxStorage)
        : adapterMaxStorage;
    elevated.maxStorageBufferBindingSize =
      typeof effectiveMaxBuffer === 'number' && effectiveMaxBuffer > 0
        ? Math.min(rawTarget, adapterMaxStorage, effectiveMaxBuffer)
        : Math.min(rawTarget, adapterMaxStorage);
  }

  return elevated;
}

/**
 * Computes dynamic WGSL weight slab sizing and Range chunk sizing hints
 * based on adapter buffer limits.
 */
export function computeSlabSizingHint(
  limits: WebGpuLimitsLike | null | undefined,
  hasWebGpu: boolean,
): SlabSizingHint {
  const normalized = normalizeWebGpuLimits(limits);
  if (!hasWebGpu) {
    return {
      recommendedMaxSlabBytes: 32 * MIB,
      recommendedChunkSizeBytes: 8 * MIB,
      maxStorageBufferBindingSize: 0,
      maxBufferSize: 0,
      maxComputeWorkgroupStorageSize: 0,
    };
  }

  const ceiling = Math.min(
    normalized.maxStorageBufferBindingSize > 0
      ? normalized.maxStorageBufferBindingSize
      : DEFAULT_MAX_SLAB_BYTES,
    normalized.maxBufferSize > 0 ? normalized.maxBufferSize : DEFAULT_MAX_SLAB_BYTES,
  );

  let recommendedMaxSlabBytes = DEFAULT_MAX_SLAB_BYTES;
  if (ceiling < DEFAULT_MAX_SLAB_BYTES) {
    // Pick the largest power-of-two MiB bucket (64, 32, 16) that fits safely.
    if (ceiling >= 64 * MIB) {
      recommendedMaxSlabBytes = 64 * MIB;
    } else if (ceiling >= 32 * MIB) {
      recommendedMaxSlabBytes = 32 * MIB;
    } else {
      recommendedMaxSlabBytes = Math.max(4 * MIB, Math.min(MIN_SLAB_BYTES, ceiling));
    }
  }

  // Use 16 MiB Range chunks for high-limit adapters, 8 MiB on tighter devices.
  const recommendedChunkSizeBytes =
    recommendedMaxSlabBytes >= 64 * MIB ? 16 * MIB : 8 * MIB;

  return {
    recommendedMaxSlabBytes,
    recommendedChunkSizeBytes,
    maxStorageBufferBindingSize: normalized.maxStorageBufferBindingSize,
    maxBufferSize: normalized.maxBufferSize,
    maxComputeWorkgroupStorageSize: normalized.maxComputeWorkgroupStorageSize,
  };
}
