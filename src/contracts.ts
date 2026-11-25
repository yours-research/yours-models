/**
 * Shared TypeScript contracts for `@yours/models` matching `docs/ECOSYSTEM_CONTRACTS.md` (v1.0).
 */

export type WgslComputeTier =
  | 'tier1-f16-subgroups'
  | 'tier2-f16-shared'
  | 'tier3-f32-universal';

export type ModelArchitecture =
  | 'qwen35-deltanet'
  | 'qwen3-gqa'
  | 'gemma4'
  | 'custom';

export type ModelQuantization = 'q4f16' | 'q4' | 'fp16';

export interface ModelArtifactEntry {
  /** Relative POSIX path inside the model bundle, e.g. `slab0.part00.bin`. */
  path: string;
  /** Exact uncompressed byte length of the artifact. */
  sizeBytes: number;
  /** Lowercase hex SHA-256 digest of the entire artifact. */
  sha256: string;
  /** Optional chunk granularity (typically 8–16 MiB) for Range verification. */
  chunkSizeBytes?: number;
  /** Ordered lowercase hex SHA-256 digests for each chunk of size `chunkSizeBytes`. */
  chunkSha256?: string[];
  /** Primary HTTP/3 CDN URL + optional multi-origin mirrors. */
  urls: string[];
}

export interface ModelManifestV1 {
  schemaVersion: 1;
  /** Canonical model identifier, e.g. `yours-research/Pragma-1-4B-WGSL`. */
  modelId: string;
  /** Immutable semantic or content-addressed version string. */
  version: string;
  architecture: ModelArchitecture;
  quantization: ModelQuantization;
  /** Sum of `sizeBytes` across all `artifacts`. */
  totalBytes: number;
  /** Hex SHA-256 Merkle root over all artifact/chunk hashes. */
  merkleRoot: string;
  artifacts: ModelArtifactEntry[];
  /** Deterministic canonical JSON string over the unsigned manifest fields. */
  canonicalPayload: string;
  /** Base64-encoded Ed25519 signature over `canonicalPayload`. */
  signatureBase64: string;
}

export type UnsignedModelManifestV1 = Omit<
  ModelManifestV1,
  'canonicalPayload' | 'signatureBase64'
>;

export interface HardwareProfile {
  hasWebGpu: boolean;
  tier: WgslComputeTier | 'cpu-only';
  adapterVendor?: string;
  maxStorageBufferBindingSize: number;
  maxBufferSize: number;
  estimatedVramGB?: number;
  /** Recommended catalog entry ID, e.g. `Pragma-1-4B`, `Pragma-1-2B`, `Pragma-1-Nano`. */
  recommendedModelId: string;
}
