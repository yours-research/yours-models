import type { ModelVaultBackend, StorageQuotaInfo, StoredModelMetadata } from './types.js';

export interface QuotaEnsureOptions {
  /** Extra free headroom required beyond the incoming model size (default: 0). */
  safetyHeadroomBytes?: number;
  /** Model keys that must never be evicted during this operation. */
  protectModelKeys?: readonly string[];
  /** Whether to request `navigator.storage.persist()` first (default: `true`). */
  requestPersist?: boolean;
}

export interface QuotaEnsureResult {
  ok: boolean;
  persisted: boolean | null;
  freedBytes: number;
  evictedModelKeys: string[];
  availableBytesBefore: number | null;
  availableBytesAfter: number | null;
  reason?: string;
}

export interface EvictionResult {
  freedBytes: number;
  evictedModelKeys: string[];
}

/**
 * Manages OPFS storage persistence, pre-download quota checks, and LRU / pinned
 * model garbage collection across stored models.
 */
export class StorageQuotaManager {
  private readonly vault: ModelVaultBackend;

  constructor(vault: ModelVaultBackend) {
    this.vault = vault;
  }

  async requestPersistence(): Promise<boolean | null> {
    return this.vault.requestPersistence();
  }

  async estimateQuota(): Promise<
    StorageQuotaInfo & { storedModelCount: number; storedModelsBytes: number }
  > {
    const [quota, models] = await Promise.all([
      this.vault.getStorageEstimate(),
      this.vault.listModels(),
    ]);
    let storedModelsBytes = 0;
    for (const model of models) {
      storedModelsBytes += model.totalBytes;
    }
    return {
      ...quota,
      storedModelCount: models.length,
      storedModelsBytes,
    };
  }

  async listModels(): Promise<StoredModelMetadata[]> {
    const models = await this.vault.listModels();
    return models.sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
  }

  async pinModel(modelKey: string): Promise<boolean> {
    return this.vault.setModelPinned(modelKey, true);
  }

  async unpinModel(modelKey: string): Promise<boolean> {
    return this.vault.setModelPinned(modelKey, false);
  }

  async touchModel(modelKey: string, nowMs = Date.now()): Promise<void> {
    await this.vault.touchModel(modelKey, nowMs);
  }

  /**
   * Evicts least-recently-used unpinned models until at least `bytesToFree`
   * have been reclaimed (or no evictable models remain).
   */
  async evictLru(
    bytesToFree: number,
    protectModelKeys: readonly string[] = [],
  ): Promise<EvictionResult> {
    if (bytesToFree <= 0) {
      return { freedBytes: 0, evictedModelKeys: [] };
    }
    const protectedSet = new Set(protectModelKeys);
    const models = await this.vault.listModels();

    const evictable = models
      .filter((m) => !m.pinned && !protectedSet.has(m.modelKey))
      .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

    let freedBytes = 0;
    const evictedModelKeys: string[] = [];

    for (const candidate of evictable) {
      if (freedBytes >= bytesToFree) {
        break;
      }
      await this.vault.deleteModel(candidate.modelKey);
      freedBytes += candidate.totalBytes;
      evictedModelKeys.push(candidate.modelKey);
    }

    return { freedBytes, evictedModelKeys };
  }

  /**
   * Ensures sufficient storage quota exists for `requiredBytes`, automatically
   * running LRU eviction on unpinned models if needed.
   */
  async ensureSpaceForModel(
    requiredBytes: number,
    options: QuotaEnsureOptions = {},
  ): Promise<QuotaEnsureResult> {
    const persisted =
      options.requestPersist !== false ? await this.requestPersistence() : null;
    const headroom = Math.max(0, options.safetyHeadroomBytes ?? 0);
    const totalNeeded = Math.max(0, requiredBytes) + headroom;

    const before = await this.vault.getStorageEstimate();
    if (!before.supported || before.availableBytes === null) {
      return {
        ok: true,
        persisted,
        freedBytes: 0,
        evictedModelKeys: [],
        availableBytesBefore: before.availableBytes,
        availableBytesAfter: before.availableBytes,
      };
    }

    if (before.availableBytes >= totalNeeded) {
      return {
        ok: true,
        persisted,
        freedBytes: 0,
        evictedModelKeys: [],
        availableBytesBefore: before.availableBytes,
        availableBytesAfter: before.availableBytes,
      };
    }

    const deficit = totalNeeded - before.availableBytes;
    const eviction = await this.evictLru(deficit, options.protectModelKeys ?? []);
    const after = await this.vault.getStorageEstimate();
    const availableAfter = after.availableBytes ?? before.availableBytes + eviction.freedBytes;
    const ok = availableAfter >= totalNeeded;

    return {
      ok,
      persisted,
      freedBytes: eviction.freedBytes,
      evictedModelKeys: eviction.evictedModelKeys,
      availableBytesBefore: before.availableBytes,
      availableBytesAfter: availableAfter,
      ...(ok
        ? {}
        : {
            reason: `Insufficient storage quota: need ${totalNeeded} B, available ${availableAfter} B after evicting ${eviction.evictedModelKeys.length} unpinned model(s).`,
          }),
    };
  }
}
