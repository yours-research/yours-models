import type { HardwareProfile, WgslComputeTier } from '../contracts.js';
import { defaultModelRegistry, ModelRegistry } from './catalog.js';
import {
  computeElevatedLimits,
  computeSlabSizingHint,
  normalizeWebGpuLimits,
} from './limits.js';
import type {
  HardwareProbeResult,
  ModelCatalogEntry,
  WebGpuAdapterInfoLike,
  WebGpuAdapterLike,
  WebGpuDeviceLike,
  WebGpuLimitsLike,
  WebGpuNavigatorLike,
} from './types.js';

export interface HardwareProbeOptions {
  /** Navigator-like object providing `.gpu` and optional `.deviceMemory`. */
  navigator?: WebGpuNavigatorLike;
  /** Override system RAM in GiB (defaults to `navigator.deviceMemory`). */
  systemRamGB?: number;
  /** Override estimated VRAM in GiB if known from platform telemetry. */
  estimatedVramGB?: number;
  /** Request an elevated-limit probe device and read granted limits (default: `true`). */
  requestElevatedDevice?: boolean;
  /** Adapter powerPreference passed to `requestAdapter` (default: `'high-performance'`). */
  powerPreference?: 'low-power' | 'high-performance';
  /** Custom model catalog registry (defaults to `defaultModelRegistry`). */
  registry?: ModelRegistry;
  /** Restrict recommendations to a specific family (`'pragma'` by default). */
  preferredFamily?: 'pragma' | 'reference' | 'all';
}

const GIB = 1024 * 1024 * 1024;

/**
 * Selects the optimal WGSL compute shader dispatch tier from adapter features and limits.
 */
export function selectComputeTier(
  features: Iterable<string>,
  limits?: WebGpuLimitsLike | null,
): WgslComputeTier {
  const featureSet = new Set(Array.from(features, (f) => f.toLowerCase()));
  const hasF16 = featureSet.has('shader-f16');
  const hasSubgroups = featureSet.has('subgroups');
  const workgroupMem = limits?.maxComputeWorkgroupStorageSize;

  if (hasF16 && hasSubgroups && (workgroupMem === undefined || workgroupMem >= 16_384)) {
    return 'tier1-f16-subgroups';
  }
  if (hasF16 && (workgroupMem === undefined || workgroupMem >= 16_384)) {
    return 'tier2-f16-shared';
  }
  return 'tier3-f32-universal';
}

function isLikelyUnifiedMemory(adapterInfo?: WebGpuAdapterInfoLike | null): boolean {
  const haystack = [
    adapterInfo?.vendor,
    adapterInfo?.architecture,
    adapterInfo?.device,
    adapterInfo?.description,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return (
    haystack.includes('apple') ||
    haystack.includes('intel') ||
    haystack.includes('uhd') ||
    haystack.includes('iris') ||
    haystack.includes('radeon graphics') ||
    haystack.includes('mali') ||
    haystack.includes('adreno') ||
    haystack.includes('swiftshader')
  );
}

/**
 * Estimates usable GPU VRAM in GiB from WebGPU buffer limits, adapter info,
 * and optional system RAM (`navigator.deviceMemory`).
 */
export function estimateVramGB(
  limits: WebGpuLimitsLike | null | undefined,
  systemRamGB?: number,
  adapterInfo?: WebGpuAdapterInfoLike | null,
): number | undefined {
  const normalized = normalizeWebGpuLimits(limits);
  if (normalized.maxBufferSize <= 0 && normalized.maxStorageBufferBindingSize <= 0) {
    return undefined;
  }

  const maxBufGB = normalized.maxBufferSize / GIB;
  const maxStorageGB = normalized.maxStorageBufferBindingSize / GIB;
  const unified = isLikelyUnifiedMemory(adapterInfo);

  let estimated: number;
  if (unified && typeof systemRamGB === 'number' && systemRamGB > 0) {
    // Unified-memory GPUs share host RAM (~60% usable by WebGPU), bounded cleanly.
    const unifiedBudget = Number((systemRamGB * 0.6).toFixed(2));
    estimated = maxBufGB >= 1 ? Math.max(maxBufGB, unifiedBudget) : Math.min(maxBufGB * 1.5, unifiedBudget);
  } else if (maxBufGB >= 2 && maxStorageGB >= 1) {
    // Chromium Dawn commonly caps maxBufferSize at 2–4 GiB on 6–24 GiB discrete GPUs.
    estimated = Math.max(4, Number((maxBufGB * 2).toFixed(2)));
  } else if (maxBufGB >= 1 && maxStorageGB >= 0.25) {
    estimated = Number(Math.max(2, maxBufGB * 1.5).toFixed(2));
  } else {
    estimated = Number(Math.max(0.25, maxBufGB).toFixed(2));
  }

  if (typeof systemRamGB === 'number' && systemRamGB > 0 && unified) {
    estimated = Math.min(estimated, Number((systemRamGB * 0.75).toFixed(2)));
  }

  return Number(estimated.toFixed(2));
}

export interface RecommendModelInput {
  hasWebGpu: boolean;
  tier: WgslComputeTier | 'cpu-only';
  maxStorageBufferBindingSize: number;
  maxBufferSize: number;
  maxComputeWorkgroupStorageSize?: number;
  estimatedVramGB?: number;
  systemRamGB?: number;
  preferredFamily?: 'pragma' | 'reference' | 'all';
}

function isModelCompatible(
  entry: ModelCatalogEntry,
  input: RecommendModelInput,
): boolean {
  if (!input.hasWebGpu || input.tier === 'cpu-only') {
    return false;
  }
  if (input.maxStorageBufferBindingSize < entry.minStorageBufferBindingBytes) {
    return false;
  }
  if (input.maxBufferSize < entry.minStorageBufferBindingBytes) {
    return false;
  }
  if (
    entry.minWorkgroupStorageBytes !== undefined &&
    input.maxComputeWorkgroupStorageSize !== undefined &&
    input.maxComputeWorkgroupStorageSize > 0 &&
    input.maxComputeWorkgroupStorageSize < entry.minWorkgroupStorageBytes
  ) {
    return false;
  }
  if (input.estimatedVramGB !== undefined && input.estimatedVramGB < entry.minVramGB) {
    return false;
  }
  if (input.systemRamGB !== undefined && input.systemRamGB < entry.minRamGB) {
    return false;
  }
  return true;
}

/**
 * Selects the best model preset from the registry given probed hardware limits.
 */
export function recommendModel(
  input: RecommendModelInput,
  registry: ModelRegistry = defaultModelRegistry,
): {
  recommendedModelId: string;
  compatibleModels: ModelCatalogEntry[];
  reason: string;
} {
  const familyFilter =
    input.preferredFamily && input.preferredFamily !== 'all'
      ? { family: input.preferredFamily }
      : undefined;
  let candidates = registry.list(familyFilter);
  if (candidates.length === 0) {
    candidates = registry.list();
  }

  // Sort from largest parameter count (highest quality) down to smallest fallback.
  const sortedDesc = [...candidates].sort(
    (a, b) => b.parameterCountBillions - a.parameterCountBillions,
  );
  const smallestFallback =
    sortedDesc[sortedDesc.length - 1]?.id ?? 'Pragma-1-Nano';

  if (!input.hasWebGpu || input.tier === 'cpu-only') {
    return {
      recommendedModelId: smallestFallback,
      compatibleModels: [],
      reason: `WebGPU unavailable (cpu-only mode); falling back to smallest preset ${smallestFallback}.`,
    };
  }

  const compatibleModels = sortedDesc.filter((entry) =>
    isModelCompatible(entry, input),
  );

  // Prefer tier1/tier2 capable flagship if compatible; on tier3-f32-universal,
  // avoid recommending a multi-GB 4B model if VRAM/limits are borderline.
  let chosen = compatibleModels[0];
  if (chosen && input.tier === 'tier3-f32-universal' && chosen.parameterCountBillions >= 4) {
    const mid = compatibleModels.find((m) => m.parameterCountBillions <= 2.5);
    if (mid && (input.estimatedVramGB === undefined || input.estimatedVramGB < 6)) {
      chosen = mid;
    }
  }

  if (chosen) {
    return {
      recommendedModelId: chosen.id,
      compatibleModels,
      reason: `Selected ${chosen.id} for ${input.tier} (est. VRAM ${input.estimatedVramGB ?? 'unknown'} GB, maxStorageBufferBinding ${(input.maxStorageBufferBindingSize / (1024 * 1024)).toFixed(0)} MiB).`,
    };
  }

  return {
    recommendedModelId: smallestFallback,
    compatibleModels: [],
    reason: `No catalog preset met all hardware thresholds; falling back to ${smallestFallback}.`,
  };
}

async function readAdapterInfo(
  adapter: WebGpuAdapterLike,
): Promise<Required<WebGpuAdapterInfoLike>> {
  let raw: WebGpuAdapterInfoLike | undefined = adapter.info;
  if (!raw && typeof adapter.requestAdapterInfo === 'function') {
    try {
      raw = await adapter.requestAdapterInfo();
    } catch {
      raw = undefined;
    }
  }
  return {
    vendor: raw?.vendor || 'unknown',
    architecture: raw?.architecture || 'unknown',
    device: raw?.device || 'unknown',
    description: raw?.description || 'unknown',
  };
}

/**
 * Probes WebGPU adapter features, elevated buffer limits, WGSL compute tier,
 * dynamic slab sizing, and recommends the optimal Pragma / WebGPU model.
 */
export async function probeHardware(
  options: HardwareProbeOptions = {},
): Promise<HardwareProbeResult> {
  const probedAt = new Date().toISOString();
  const nav: WebGpuNavigatorLike | undefined =
    options.navigator ??
    (typeof navigator !== 'undefined'
      ? (navigator as unknown as WebGpuNavigatorLike)
      : undefined);
  const registry = options.registry ?? defaultModelRegistry;
  const preferredFamily = options.preferredFamily ?? 'pragma';
  const systemRamGB = options.systemRamGB ?? nav?.deviceMemory;

  const buildFallbackResult = (error: string): HardwareProbeResult => {
    const slabSizing = computeSlabSizingHint(null, false);
    const rec = recommendModel(
      {
        hasWebGpu: false,
        tier: 'cpu-only',
        maxStorageBufferBindingSize: 0,
        maxBufferSize: 0,
        systemRamGB,
        preferredFamily,
      },
      registry,
    );
    const profile: HardwareProfile = {
      hasWebGpu: false,
      tier: 'cpu-only',
      maxStorageBufferBindingSize: 0,
      maxBufferSize: 0,
      recommendedModelId: rec.recommendedModelId,
    };
    return {
      profile,
      features: [],
      hasShaderF16: false,
      hasSubgroups: false,
      adapterInfo: null,
      adapterLimits: null,
      grantedLimits: null,
      slabSizing,
      ...(systemRamGB !== undefined ? { estimatedSystemRamGB: systemRamGB } : {}),
      compatibleModels: rec.compatibleModels,
      recommendationReason: rec.reason,
      probedAt,
      error,
    };
  };

  if (!nav?.gpu || typeof nav.gpu.requestAdapter !== 'function') {
    return buildFallbackResult('navigator.gpu is unavailable in this environment.');
  }

  try {
    const adapter = await nav.gpu.requestAdapter({
      powerPreference: options.powerPreference ?? 'high-performance',
    });
    if (!adapter) {
      return buildFallbackResult('navigator.gpu.requestAdapter() returned null.');
    }

    const features = Array.from(adapter.features, (f) => String(f)).sort();
    const featureSet = new Set(features.map((f) => f.toLowerCase()));
    const hasShaderF16 = featureSet.has('shader-f16');
    const hasSubgroups = featureSet.has('subgroups');
    const adapterInfo = await readAdapterInfo(adapter);
    const adapterLimits = normalizeWebGpuLimits(adapter.limits);

    let grantedLimits: { maxBufferSize: number; maxStorageBufferBindingSize: number } | null =
      null;
    let effectiveLimits = adapterLimits;

    if (options.requestElevatedDevice !== false) {
      let probeDevice: WebGpuDeviceLike | null = null;
      try {
        probeDevice = await adapter.requestDevice({
          requiredLimits: computeElevatedLimits(adapter.limits),
        });
      } catch {
        try {
          probeDevice = await adapter.requestDevice();
        } catch {
          probeDevice = null;
        }
      }
      if (probeDevice) {
        const deviceLimits = normalizeWebGpuLimits(probeDevice.limits);
        grantedLimits = {
          maxBufferSize: deviceLimits.maxBufferSize,
          maxStorageBufferBindingSize: deviceLimits.maxStorageBufferBindingSize,
        };
        if (
          deviceLimits.maxBufferSize > 0 &&
          deviceLimits.maxStorageBufferBindingSize > 0
        ) {
          effectiveLimits = deviceLimits;
        }
        probeDevice.destroy?.();
      }
    }

    const tier = selectComputeTier(features, effectiveLimits);
    const slabSizing = computeSlabSizingHint(effectiveLimits, true);
    const vramGB =
      options.estimatedVramGB ??
      estimateVramGB(effectiveLimits, systemRamGB, adapterInfo);

    const rec = recommendModel(
      {
        hasWebGpu: true,
        tier,
        maxStorageBufferBindingSize: effectiveLimits.maxStorageBufferBindingSize,
        maxBufferSize: effectiveLimits.maxBufferSize,
        maxComputeWorkgroupStorageSize: effectiveLimits.maxComputeWorkgroupStorageSize,
        estimatedVramGB: vramGB,
        systemRamGB,
        preferredFamily,
      },
      registry,
    );

    const profile: HardwareProfile = {
      hasWebGpu: true,
      tier,
      adapterVendor: adapterInfo.vendor,
      maxStorageBufferBindingSize: effectiveLimits.maxStorageBufferBindingSize,
      maxBufferSize: effectiveLimits.maxBufferSize,
      ...(vramGB !== undefined ? { estimatedVramGB: vramGB } : {}),
      recommendedModelId: rec.recommendedModelId,
    };

    return {
      profile,
      features,
      hasShaderF16,
      hasSubgroups,
      adapterInfo,
      adapterLimits,
      grantedLimits,
      slabSizing,
      ...(systemRamGB !== undefined ? { estimatedSystemRamGB: systemRamGB } : {}),
      compatibleModels: rec.compatibleModels,
      recommendationReason: rec.reason,
      probedAt,
    };
  } catch (err) {
    return buildFallbackResult(err instanceof Error ? err.message : String(err));
  }
}
