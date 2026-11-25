import { describe, expect, it } from 'vitest';
import {
  computeElevatedLimits,
  computeSlabSizingHint,
  defaultModelRegistry,
  ModelRegistry,
  probeHardware,
  recommendModel,
  selectComputeTier,
  type WebGpuAdapterLike,
  type WebGpuNavigatorLike,
} from '../src/index.js';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

function makeMockGpuNavigator(config: {
  features: string[];
  limits: Record<string, number>;
  vendor?: string;
  description?: string;
  deviceMemory?: number;
}): WebGpuNavigatorLike {
  const adapter: WebGpuAdapterLike = {
    features: new Set(config.features),
    limits: config.limits,
    info: {
      vendor: config.vendor ?? 'generic',
      architecture: 'mock-arch',
      device: 'mock-gpu',
      description: config.description ?? 'Mock GPU',
    },
    async requestDevice(descriptor) {
      const reqLimits = descriptor?.requiredLimits ?? {};
      return {
        features: new Set(config.features),
        limits: {
          ...config.limits,
          maxBufferSize: Math.min(
            reqLimits.maxBufferSize ?? 256 * MIB,
            config.limits.maxBufferSize ?? 256 * MIB,
          ),
          maxStorageBufferBindingSize: Math.min(
            reqLimits.maxStorageBufferBindingSize ?? 128 * MIB,
            config.limits.maxStorageBufferBindingSize ?? 128 * MIB,
          ),
        },
        destroy() {},
      };
    },
  };

  return {
    deviceMemory: config.deviceMemory,
    gpu: {
      async requestAdapter() {
        return adapter;
      },
    },
  };
}

describe('WebGPU Hardware Prober & Model Recommender', () => {
  it('falls back cleanly to cpu-only and Pragma-1-Nano when WebGPU is absent', async () => {
    const result = await probeHardware({
      navigator: { deviceMemory: 8 },
    });
    expect(result.profile.hasWebGpu).toBe(false);
    expect(result.profile.tier).toBe('cpu-only');
    expect(result.profile.recommendedModelId).toBe('Pragma-1-Nano');
    expect(result.error).toContain('unavailable');
  });

  it('selects tier1-f16-subgroups and Pragma-1-4B on high-end discrete GPU', async () => {
    const nav = makeMockGpuNavigator({
      features: ['shader-f16', 'subgroups'],
      limits: {
        maxBufferSize: 4 * GIB,
        maxStorageBufferBindingSize: 2 * GIB,
        maxComputeWorkgroupStorageSize: 32_768,
        maxComputeInvocationsPerWorkgroup: 1024,
        maxStorageBuffersPerShaderStage: 10,
      },
      vendor: 'nvidia',
      description: 'NVIDIA GeForce RTX 4070',
      deviceMemory: 32,
    });

    const result = await probeHardware({ navigator: nav });
    expect(result.profile.hasWebGpu).toBe(true);
    expect(result.profile.tier).toBe('tier1-f16-subgroups');
    expect(result.profile.recommendedModelId).toBe('Pragma-1-4B');
    expect(result.grantedLimits?.maxBufferSize).toBe(4 * GIB);
    expect(result.grantedLimits?.maxStorageBufferBindingSize).toBe(2 * GIB);
    expect(result.slabSizing.recommendedMaxSlabBytes).toBe(128 * MIB);
    expect(result.slabSizing.recommendedChunkSizeBytes).toBe(16 * MIB);
  });

  it('selects tier2-f16-shared and Pragma-1-2B on mid-range integrated laptop GPU', async () => {
    const nav = makeMockGpuNavigator({
      features: ['shader-f16'],
      limits: {
        maxBufferSize: 1.5 * GIB,
        maxStorageBufferBindingSize: 512 * MIB,
        maxComputeWorkgroupStorageSize: 32_768,
      },
      vendor: 'intel',
      description: 'Intel Iris Xe Graphics',
      deviceMemory: 4,
    });

    const result = await probeHardware({ navigator: nav });
    expect(result.profile.tier).toBe('tier2-f16-shared');
    expect(result.profile.recommendedModelId).toBe('Pragma-1-2B');
    expect(result.profile.estimatedVramGB).toBeLessThan(3.5);
  });

  it('selects tier3-f32-universal and tight slab sizing on low-limit mobile/fallback GPU', async () => {
    const nav = makeMockGpuNavigator({
      features: [],
      limits: {
        maxBufferSize: 256 * MIB,
        maxStorageBufferBindingSize: 48 * MIB,
        maxComputeWorkgroupStorageSize: 16_384,
      },
      vendor: 'arm',
      description: 'Mali-G57',
      deviceMemory: 2,
    });

    const result = await probeHardware({ navigator: nav });
    expect(result.profile.tier).toBe('tier3-f32-universal');
    expect(result.profile.recommendedModelId).toBe('Pragma-1-Nano');
    expect(result.slabSizing.recommendedMaxSlabBytes).toBe(32 * MIB);
    expect(result.slabSizing.recommendedChunkSizeBytes).toBe(8 * MIB);
  });

  it('computes elevated limits clamped to adapter maximums and supports custom ModelRegistry', () => {
    const elevated = computeElevatedLimits(
      { maxBufferSize: 2 * GIB, maxStorageBufferBindingSize: 1 * GIB },
      { maxBufferSize: 8 * GIB, maxStorageBufferBindingSize: 4 * GIB },
    );
    expect(elevated.maxBufferSize).toBe(2 * GIB);
    expect(elevated.maxStorageBufferBindingSize).toBe(1 * GIB);

    expect(selectComputeTier(['shader-f16', 'subgroups'], { maxComputeWorkgroupStorageSize: 32_768 })).toBe(
      'tier1-f16-subgroups',
    );
    expect(selectComputeTier(['shader-f16'], { maxComputeWorkgroupStorageSize: 8_192 })).toBe(
      'tier3-f32-universal',
    );

    const slab = computeSlabSizingHint(
      { maxBufferSize: 96 * MIB, maxStorageBufferBindingSize: 96 * MIB },
      true,
    );
    expect(slab.recommendedMaxSlabBytes).toBe(64 * MIB);

    // Extensible non-hardcoded catalog
    const customRegistry = defaultModelRegistry.clone();
    customRegistry.register({
      id: 'Pragma-2-7B',
      modelId: 'yours-research/Pragma-2-7B-WGSL',
      displayName: 'Pragma-2 7B',
      family: 'pragma',
      architecture: 'qwen35-deltanet',
      quantization: 'q4f16',
      parameterCountBillions: 7.0,
      approxSizeBytes: 4.5 * GIB,
      minVramGB: 6.0,
      minRamGB: 16,
      minStorageBufferBindingBytes: 128 * MIB,
      preferredTiers: ['tier1-f16-subgroups'],
      description: 'Future 7B preset',
    });
    expect(new ModelRegistry().get('Pragma-2-7B')).toBeUndefined();

    const rec = recommendModel(
      {
        hasWebGpu: true,
        tier: 'tier1-f16-subgroups',
        maxStorageBufferBindingSize: 1 * GIB,
        maxBufferSize: 4 * GIB,
        estimatedVramGB: 8.0,
        systemRamGB: 16,
      },
      customRegistry,
    );
    expect(rec.recommendedModelId).toBe('Pragma-2-7B');
  });
});
