import type { ModelManifestV1 } from '../contracts.js';
import { base64ToBytes, bytesToBase64 } from '../manifest/ed25519.js';
import { sha256Hex } from '../manifest/merkle.js';

export interface OpfsSyncAccessHandleLike {
  getSize(): number;
  truncate(newSize: number): void;
  write(buffer: ArrayBufferView, options?: { at?: number }): number;
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  flush(): void;
  close(): void;
}

export interface OpfsWritableStreamLike {
  seek?(position: number): Promise<void>;
  write(
    data:
      | Uint8Array
      | ArrayBuffer
      | string
      | { type: 'write'; position?: number; data: Uint8Array | ArrayBuffer | string },
  ): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

export interface OpfsFileLike {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  slice(start?: number, end?: number): Blob;
}

export interface OpfsFileHandleLike {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<OpfsFileLike>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritableStreamLike>;
  createSyncAccessHandle?: () => Promise<OpfsSyncAccessHandleLike>;
}

export interface OpfsDirectoryHandleLike {
  readonly kind: 'directory';
  readonly name: string;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsDirectoryHandleLike>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<OpfsFileHandleLike>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  entries?(): AsyncIterableIterator<[string, OpfsFileHandleLike | OpfsDirectoryHandleLike]>;
}

export interface VaultArtifactWriter {
  preallocate(totalBytes: number): Promise<void>;
  writeAt(offset: number, data: Uint8Array): Promise<void>;
  readAt(offset: number, length: number): Promise<Uint8Array>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface ResumeArtifactState {
  path: string;
  sizeBytes: number;
  chunkSizeBytes: number;
  totalChunks: number;
  /** Compact base64-encoded bitset tracking verified chunks on disk. */
  bitmapBase64: string;
  completed: boolean;
}

export interface ResumeJournal {
  schemaVersion: 1;
  modelKey: string;
  modelId: string;
  version: string;
  merkleRoot: string;
  totalBytes: number;
  updatedAt: number;
  artifacts: Record<string, ResumeArtifactState>;
}

export interface StoredModelMetadata {
  schemaVersion: 1;
  modelKey: string;
  modelId: string;
  version: string;
  merkleRoot: string;
  totalBytes: number;
  pinned: boolean;
  installedAt: number;
  lastAccessedAt: number;
  manifest: ModelManifestV1;
}

export interface StorageQuotaInfo {
  supported: boolean;
  persisted: boolean | null;
  quotaBytes: number | null;
  usageBytes: number | null;
  availableBytes: number | null;
}

export interface ModelVaultBackend {
  readonly kind: 'opfs-sync' | 'opfs-async' | 'memory';
  openArtifactWriter(
    modelKey: string,
    artifactPath: string,
    totalBytes: number,
  ): Promise<VaultArtifactWriter>;
  readArtifact(modelKey: string, artifactPath: string): Promise<Uint8Array | null>;
  readArtifactSlice(
    modelKey: string,
    artifactPath: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array | null>;
  getArtifactSize(modelKey: string, artifactPath: string): Promise<number | null>;
  readResumeJournal(modelKey: string): Promise<ResumeJournal | null>;
  writeResumeJournal(modelKey: string, journal: ResumeJournal): Promise<void>;
  deleteResumeJournal(modelKey: string): Promise<void>;
  commitModel(modelKey: string, metadata: StoredModelMetadata): Promise<void>;
  readModelMetadata(modelKey: string): Promise<StoredModelMetadata | null>;
  listModels(): Promise<StoredModelMetadata[]>;
  touchModel(modelKey: string, nowMs?: number): Promise<void>;
  setModelPinned(modelKey: string, pinned: boolean): Promise<boolean>;
  deleteModel(modelKey: string): Promise<void>;
  getStorageEstimate(): Promise<StorageQuotaInfo>;
  requestPersistence(): Promise<boolean | null>;
}

/**
 * Derives a deterministic, filesystem-safe OPFS directory key for a `(modelId, version)` pair.
 */
export async function deriveModelKey(modelId: string, version: string): Promise<string> {
  const slug = `${modelId}-${version}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const digest = await sha256Hex(`${modelId}@${version}`);
  return `${slug || 'model'}-${digest.slice(0, 12)}`;
}

export function encodeChunkBitmap(
  completedChunks: Iterable<number>,
  totalChunks: number,
): string {
  const byteLen = Math.ceil(Math.max(0, totalChunks) / 8);
  const bytes = new Uint8Array(byteLen);
  for (const idx of completedChunks) {
    if (idx >= 0 && idx < totalChunks) {
      bytes[idx >> 3]! |= 1 << (idx & 7);
    }
  }
  return bytesToBase64(bytes);
}

export function decodeChunkBitmap(bitmapBase64: string, totalChunks: number): Set<number> {
  const out = new Set<number>();
  if (!bitmapBase64 || totalChunks <= 0) {
    return out;
  }
  const bytes = base64ToBytes(bitmapBase64);
  for (let idx = 0; idx < totalChunks; idx++) {
    const byteIdx = idx >> 3;
    if (byteIdx >= bytes.length) {
      break;
    }
    if ((bytes[byteIdx]! & (1 << (idx & 7))) !== 0) {
      out.add(idx);
    }
  }
  return out;
}
