import { isSafeArtifactPath } from '../manifest/ed25519.js';
import type {
  ModelVaultBackend,
  ResumeJournal,
  StorageQuotaInfo,
  StoredModelMetadata,
  VaultArtifactWriter,
} from './types.js';

export interface MemoryVaultOptions {
  /** Simulated quota in bytes (defaults to `4 GiB`). */
  quotaBytes?: number;
  /** Simulated `navigator.storage.persist()` return value (default: `true`). */
  persisted?: boolean;
}

class MemoryArtifactWriter implements VaultArtifactWriter {
  private buffer: Uint8Array;
  private readonly onUpdate: (buf: Uint8Array) => void;

  constructor(initial: Uint8Array | undefined, totalBytes: number, onUpdate: (buf: Uint8Array) => void) {
    this.buffer = initial && initial.byteLength === totalBytes
      ? initial
      : new Uint8Array(totalBytes);
    if (initial && initial.byteLength !== totalBytes) {
      this.buffer.set(initial.subarray(0, Math.min(initial.byteLength, totalBytes)), 0);
    }
    this.onUpdate = onUpdate;
    this.onUpdate(this.buffer);
  }

  async preallocate(totalBytes: number): Promise<void> {
    if (this.buffer.byteLength !== totalBytes) {
      const next = new Uint8Array(totalBytes);
      next.set(this.buffer.subarray(0, Math.min(this.buffer.byteLength, totalBytes)), 0);
      this.buffer = next;
      this.onUpdate(this.buffer);
    }
  }

  async writeAt(offset: number, data: Uint8Array): Promise<void> {
    if (offset + data.byteLength > this.buffer.byteLength) {
      const next = new Uint8Array(offset + data.byteLength);
      next.set(this.buffer, 0);
      this.buffer = next;
    }
    this.buffer.set(data, offset);
    this.onUpdate(this.buffer);
  }

  async readAt(offset: number, length: number): Promise<Uint8Array> {
    if (offset >= this.buffer.byteLength) {
      return new Uint8Array(0);
    }
    const end = Math.min(this.buffer.byteLength, offset + length);
    return this.buffer.slice(offset, end);
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {}
}

interface StoredModelBucket {
  artifacts: Map<string, Uint8Array>;
  journal: ResumeJournal | null;
  metadata: StoredModelMetadata | null;
}

/**
 * In-memory `ModelVaultBackend` for Node/Vitest environments and ephemeral web demos.
 */
export class MemoryVault implements ModelVaultBackend {
  readonly kind = 'memory' as const;
  private readonly models = new Map<string, StoredModelBucket>();
  private quotaBytes: number;
  private persisted: boolean;

  constructor(options: MemoryVaultOptions = {}) {
    this.quotaBytes = options.quotaBytes ?? 4 * 1024 * 1024 * 1024;
    this.persisted = options.persisted ?? true;
  }

  setQuotaBytes(quotaBytes: number): void {
    this.quotaBytes = quotaBytes;
  }

  private ensureBucket(modelKey: string): StoredModelBucket {
    let bucket = this.models.get(modelKey);
    if (!bucket) {
      bucket = {
        artifacts: new Map(),
        journal: null,
        metadata: null,
      };
      this.models.set(modelKey, bucket);
    }
    return bucket;
  }

  async openArtifactWriter(
    modelKey: string,
    artifactPath: string,
    totalBytes: number,
  ): Promise<VaultArtifactWriter> {
    if (!isSafeArtifactPath(artifactPath)) {
      throw new Error(`Unsafe artifact path: ${artifactPath}`);
    }
    const bucket = this.ensureBucket(modelKey);
    const existing = bucket.artifacts.get(artifactPath);
    return new MemoryArtifactWriter(existing, totalBytes, (buf) => {
      bucket.artifacts.set(artifactPath, buf);
    });
  }

  async readArtifact(modelKey: string, artifactPath: string): Promise<Uint8Array | null> {
    const buf = this.models.get(modelKey)?.artifacts.get(artifactPath);
    return buf ? buf.slice() : null;
  }

  async readArtifactSlice(
    modelKey: string,
    artifactPath: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array | null> {
    const buf = this.models.get(modelKey)?.artifacts.get(artifactPath);
    if (!buf) {
      return null;
    }
    if (offset >= buf.byteLength) {
      return new Uint8Array(0);
    }
    return buf.slice(offset, Math.min(buf.byteLength, offset + length));
  }

  async getArtifactSize(modelKey: string, artifactPath: string): Promise<number | null> {
    const buf = this.models.get(modelKey)?.artifacts.get(artifactPath);
    return buf ? buf.byteLength : null;
  }

  /**
   * Test helper: mutates stored bytes directly on disk without updating journals
   * to simulate silent storage corruption or bitrot before resume verification.
   */
  mutateArtifactByteForTest(
    modelKey: string,
    artifactPath: string,
    offset: number,
    xorMask = 0xff,
  ): void {
    const buf = this.models.get(modelKey)?.artifacts.get(artifactPath);
    if (!buf || offset < 0 || offset >= buf.byteLength) {
      throw new RangeError(`Cannot mutate ${artifactPath} at offset ${offset}`);
    }
    buf[offset] = (buf[offset]! ^ xorMask) & 0xff;
  }

  async readResumeJournal(modelKey: string): Promise<ResumeJournal | null> {
    const journal = this.models.get(modelKey)?.journal;
    return journal ? structuredClone(journal) : null;
  }

  async writeResumeJournal(modelKey: string, journal: ResumeJournal): Promise<void> {
    this.ensureBucket(modelKey).journal = structuredClone(journal);
  }

  async deleteResumeJournal(modelKey: string): Promise<void> {
    const bucket = this.models.get(modelKey);
    if (bucket) {
      bucket.journal = null;
    }
  }

  async commitModel(modelKey: string, metadata: StoredModelMetadata): Promise<void> {
    this.ensureBucket(modelKey).metadata = structuredClone(metadata);
  }

  async readModelMetadata(modelKey: string): Promise<StoredModelMetadata | null> {
    const meta = this.models.get(modelKey)?.metadata;
    return meta ? structuredClone(meta) : null;
  }

  async listModels(): Promise<StoredModelMetadata[]> {
    const out: StoredModelMetadata[] = [];
    for (const bucket of this.models.values()) {
      if (bucket.metadata) {
        out.push(structuredClone(bucket.metadata));
      }
    }
    return out;
  }

  async touchModel(modelKey: string, nowMs = Date.now()): Promise<void> {
    const meta = this.models.get(modelKey)?.metadata;
    if (meta) {
      meta.lastAccessedAt = nowMs;
    }
  }

  async setModelPinned(modelKey: string, pinned: boolean): Promise<boolean> {
    const meta = this.models.get(modelKey)?.metadata;
    if (!meta) {
      return false;
    }
    meta.pinned = pinned;
    return true;
  }

  async deleteModel(modelKey: string): Promise<void> {
    this.models.delete(modelKey);
  }

  async getStorageEstimate(): Promise<StorageQuotaInfo> {
    let usageBytes = 0;
    for (const bucket of this.models.values()) {
      for (const buf of bucket.artifacts.values()) {
        usageBytes += buf.byteLength;
      }
    }
    return {
      supported: true,
      persisted: this.persisted,
      quotaBytes: this.quotaBytes,
      usageBytes,
      availableBytes: Math.max(0, this.quotaBytes - usageBytes),
    };
  }

  async requestPersistence(): Promise<boolean | null> {
    return this.persisted;
  }
}
