import type { ModelCatalogEntry } from './types.js';

const MIB = 1024 * 1024;

/**
 * Built-in catalog of Yours Research Pragma WGSL models and WebGPU reference
 * presets. Extend via `ModelRegistry.register(...)`.
 */
export const DEFAULT_PRAGMA_CATALOG: readonly ModelCatalogEntry[] = [
  {
    id: 'Pragma-1-4B',
    modelId: 'yours-research/Pragma-1-4B-WGSL',
    displayName: 'Pragma-1 4B (WGSL Q4F16)',
    family: 'pragma',
    architecture: 'qwen35-deltanet',
    quantization: 'q4f16',
    parameterCountBillions: 4.0,
    approxSizeBytes: 2_651_081_621, // Pre-repacked 2.47 GiB WGSL bundle
    minVramGB: 3.5,
    minRamGB: 8,
    minStorageBufferBindingBytes: 128 * MIB,
    minWorkgroupStorageBytes: 16_384,
    preferredTiers: ['tier1-f16-subgroups', 'tier2-f16-shared', 'tier3-f32-universal'],
    manifestUrl: 'https://huggingface.co/yours-research/Pragma-1-4B-WGSL/resolve/main/manifest.v1.signed.json',
    tags: ['pragma', 'flagship', 'browser-agent', 'tool-use'],
    description:
      'Flagship 4B Qwen3.5-DeltaNet browser-agent model pre-repacked into <=128 MiB WGSL slabs.',
  },
  {
    id: 'Pragma-1-2B',
    modelId: 'yours-research/Pragma-1-2B-WGSL',
    displayName: 'Pragma-1 2B (WGSL Q4F16)',
    family: 'pragma',
    architecture: 'qwen35-deltanet',
    quantization: 'q4f16',
    parameterCountBillions: 2.0,
    approxSizeBytes: 1_450_000_000,
    minVramGB: 2.0,
    minRamGB: 4,
    minStorageBufferBindingBytes: 64 * MIB,
    minWorkgroupStorageBytes: 16_384,
    preferredTiers: ['tier1-f16-subgroups', 'tier2-f16-shared', 'tier3-f32-universal'],
    manifestUrl: 'https://huggingface.co/yours-research/Pragma-1-2B-WGSL/resolve/main/manifest.v1.signed.json',
    tags: ['pragma', 'balanced', 'laptop-gpu'],
    description:
      'Balanced 2B browser-agent model tuned for 4–8 GB laptops and integrated GPUs.',
  },
  {
    id: 'Pragma-1-Nano',
    modelId: 'yours-research/Pragma-1-Nano-WGSL',
    displayName: 'Pragma-1 Nano (WGSL Q4F16)',
    family: 'pragma',
    architecture: 'qwen35-deltanet',
    quantization: 'q4f16',
    parameterCountBillions: 0.8,
    approxSizeBytes: 680_000_000,
    minVramGB: 0.9,
    minRamGB: 2,
    minStorageBufferBindingBytes: 32 * MIB,
    minWorkgroupStorageBytes: 16_384,
    preferredTiers: ['tier1-f16-subgroups', 'tier2-f16-shared', 'tier3-f32-universal'],
    manifestUrl: 'https://huggingface.co/yours-research/Pragma-1-Nano-WGSL/resolve/main/manifest.v1.signed.json',
    tags: ['pragma', 'ultra-light', 'fallback', 'mobile'],
    description:
      'Ultra-compact sub-1B WGSL model for low-VRAM devices, mobile GPUs, and CPU fallback.',
  },
  {
    id: 'Qwen3-1.7B-WGSL',
    modelId: 'yours-research/Qwen3-1.7B-WGSL',
    displayName: 'Qwen3 1.7B Reference (WGSL Q4F16)',
    family: 'reference',
    architecture: 'qwen3-gqa',
    quantization: 'q4f16',
    parameterCountBillions: 1.7,
    approxSizeBytes: 1_240_000_000,
    minVramGB: 1.8,
    minRamGB: 4,
    minStorageBufferBindingBytes: 64 * MIB,
    minWorkgroupStorageBytes: 16_384,
    preferredTiers: ['tier1-f16-subgroups', 'tier2-f16-shared', 'tier3-f32-universal'],
    tags: ['reference', 'qwen3-gqa'],
    description: 'Reference Qwen3-GQA WGSL preset for cross-architecture evaluation.',
  },
  {
    id: 'Gemma4-E2B-WGSL',
    modelId: 'yours-research/Gemma4-E2B-WGSL',
    displayName: 'Gemma 4 E2B Reference (WGSL Q4F16)',
    family: 'reference',
    architecture: 'gemma4',
    quantization: 'q4f16',
    parameterCountBillions: 2.3,
    approxSizeBytes: 1_750_000_000,
    minVramGB: 2.5,
    minRamGB: 6,
    minStorageBufferBindingBytes: 64 * MIB,
    minWorkgroupStorageBytes: 16_384,
    preferredTiers: ['tier1-f16-subgroups', 'tier2-f16-shared', 'tier3-f32-universal'],
    tags: ['reference', 'gemma4'],
    description: 'Reference Gemma 4 E2B WGSL preset for multi-backend validation.',
  },
];

export interface ModelCatalogFilter {
  family?: 'pragma' | 'reference';
  architecture?: ModelCatalogEntry['architecture'];
  tag?: string;
}

/**
 * Extensible model catalog registry allowing callers to inspect, override, or
 * register custom Pragma / WebGPU presets without hardcoding.
 */
export class ModelRegistry {
  private readonly entries = new Map<string, ModelCatalogEntry>();

  constructor(initialEntries: readonly ModelCatalogEntry[] = DEFAULT_PRAGMA_CATALOG) {
    this.registerMany(initialEntries);
  }

  register(entry: ModelCatalogEntry): this {
    this.entries.set(entry.id, {
      ...entry,
      preferredTiers: [...entry.preferredTiers],
      ...(entry.tags ? { tags: [...entry.tags] } : {}),
    });
    return this;
  }

  registerMany(entries: readonly ModelCatalogEntry[]): this {
    for (const entry of entries) {
      this.register(entry);
    }
    return this;
  }

  unregister(id: string): boolean {
    return this.entries.delete(id);
  }

  get(id: string): ModelCatalogEntry | undefined {
    return this.entries.get(id);
  }

  list(filter?: ModelCatalogFilter): ModelCatalogEntry[] {
    let out = Array.from(this.entries.values());
    if (filter?.family) {
      out = out.filter((e) => e.family === filter.family);
    }
    if (filter?.architecture) {
      out = out.filter((e) => e.architecture === filter.architecture);
    }
    if (filter?.tag) {
      const tag = filter.tag;
      out = out.filter((e) => e.tags?.includes(tag));
    }
    return out;
  }

  clone(): ModelRegistry {
    return new ModelRegistry(this.list());
  }
}

export const defaultModelRegistry = new ModelRegistry();
