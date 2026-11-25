import type {
  HardwareProfile,
  ModelArchitecture,
  ModelQuantization,
  WgslComputeTier,
} from '../contracts.js';

export interface WebGpuLimitsLike {
  maxBufferSize?: number;
  maxStorageBufferBindingSize?: number;
  maxComputeWorkgroupStorageSize?: number;
  maxComputeInvocationsPerWorkgroup?: number;
  maxStorageBuffersPerShaderStage?: number;
}

export interface WebGpuAdapterInfoLike {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}

export interface WebGpuDeviceLostInfoLike {
  reason?: string;
  message?: string;
}

export interface WebGpuDeviceLike {
  limits: WebGpuLimitsLike;
  features: Iterable<string>;
  lost?: Promise<WebGpuDeviceLostInfoLike>;
  destroy?: () => void;
}

export interface WebGpuDeviceDescriptorLike {
  requiredFeatures?: Iterable<string>;
  requiredLimits?: Record<string, number>;
  [key: string]: unknown;
}

export interface WebGpuAdapterLike {
  limits: WebGpuLimitsLike;
  features: Iterable<string>;
  info?: WebGpuAdapterInfoLike;
  requestAdapterInfo?: () => Promise<WebGpuAdapterInfoLike>;
  requestDevice: (descriptor?: WebGpuDeviceDescriptorLike) => Promise<WebGpuDeviceLike>;
}

export interface WebGpuNavigatorLike {
  deviceMemory?: number;
  gpu?: {
    requestAdapter: (options?: {
      powerPreference?: 'low-power' | 'high-performance';
      forceFallbackAdapter?: boolean;
    }) => Promise<WebGpuAdapterLike | null>;
  };
}

export interface NormalizedWebGpuLimits {
  maxBufferSize: number;
  maxStorageBufferBindingSize: number;
  maxComputeWorkgroupStorageSize: number;
  maxComputeInvocationsPerWorkgroup: number;
  maxStorageBuffersPerShaderStage: number;
}

export interface SlabSizingHint {
  /** Recommended maximum WGSL weight slab file size in bytes (e.g. 128 MiB). */
  recommendedMaxSlabBytes: number;
  /** Recommended HTTP Range fetch chunk size in bytes (8 MiB or 16 MiB). */
  recommendedChunkSizeBytes: number;
  maxStorageBufferBindingSize: number;
  maxBufferSize: number;
  maxComputeWorkgroupStorageSize: number;
}

export interface ModelCatalogEntry {
  /** Short catalog identifier, e.g. `Pragma-1-4B`. */
  id: string;
  /** Full repository/manifest model ID, e.g. `yours-research/Pragma-1-4B-WGSL`. */
  modelId: string;
  displayName: string;
  family: 'pragma' | 'reference';
  architecture: ModelArchitecture;
  quantization: ModelQuantization;
  parameterCountBillions: number;
  approxSizeBytes: number;
  minVramGB: number;
  minRamGB: number;
  minStorageBufferBindingBytes: number;
  minWorkgroupStorageBytes?: number;
  preferredTiers: WgslComputeTier[];
  manifestUrl?: string;
  tags?: string[];
  description: string;
}

export interface HardwareProbeResult {
  profile: HardwareProfile;
  features: string[];
  hasShaderF16: boolean;
  hasSubgroups: boolean;
  adapterInfo: Required<WebGpuAdapterInfoLike> | null;
  adapterLimits: NormalizedWebGpuLimits | null;
  grantedLimits: {
    maxBufferSize: number;
    maxStorageBufferBindingSize: number;
  } | null;
  slabSizing: SlabSizingHint;
  estimatedSystemRamGB?: number;
  compatibleModels: ModelCatalogEntry[];
  recommendationReason: string;
  probedAt: string;
  error?: string;
}
