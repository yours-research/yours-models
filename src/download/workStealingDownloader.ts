import type { ModelArtifactEntry, ModelManifestV1 } from '../contracts.js';
import {
  verifySignedManifest,
  type Ed25519PublicKeyInput,
} from '../manifest/ed25519.js';
import { StreamingSha256, verifyChunkSha256 } from '../manifest/merkle.js';
import { OriginMirrorPool, RedirectCache } from '../manifest/resolver.js';
import { StorageQuotaManager } from '../vault/quotaManager.js';
import {
  decodeChunkBitmap,
  deriveModelKey,
  encodeChunkBitmap,
  type ModelVaultBackend,
  type ResumeArtifactState,
  type ResumeJournal,
  type StoredModelMetadata,
  type VaultArtifactWriter,
} from '../vault/types.js';

export const DEFAULT_CONCURRENCY = 8;
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 16;
export const DEFAULT_CHUNK_SIZE_BYTES = 16 * 1024 * 1024; // 16 MiB sweet spot

export type DownloadPhase =
  | 'verifying-manifest'
  | 'checking-quota'
  | 'verifying-resume'
  | 'downloading'
  | 'finalizing'
  | 'complete';

export interface DownloadTelemetry {
  phase: DownloadPhase;
  modelId: string;
  version: string;
  /** Total verified bytes available (resumed + newly downloaded). */
  bytesDownloaded: number;
  /** Bytes downloaded over the network during this session. */
  networkBytesDownloaded: number;
  /** Bytes skipped from a verified partial download on disk. */
  resumedBytes: number;
  totalBytes: number;
  speedMiBs: number;
  etaSec: number;
  activeWorkers: number;
  verifiedChunks: number;
  totalChunks: number;
  recoveredCorruptions: number;
  elapsedMs: number;
}

export interface WorkStealingDownloadOptions {
  vault: ModelVaultBackend;
  /** Pinned Ed25519 public key(s) used to verify `ModelManifestV1`. */
  pinnedPublicKeys: readonly Ed25519PublicKeyInput[];
  /** Number of concurrent Range fetch workers (default `8`, clamped `1..16`). */
  concurrency?: number;
  /** Fallback chunk size when artifact omits `chunkSizeBytes` (default `16 MiB`). */
  defaultChunkSizeBytes?: number;
  /** Maximum per-chunk retries on network or SHA-256 corruption (default `4`). */
  maxChunkRetries?: number;
  /** Base exponential backoff delay in ms (default `150`). */
  retryBaseDelayMs?: number;
  /** Optional `RedirectCache` instance to reuse across downloads. */
  redirectCache?: RedirectCache;
  /** Pre-resolve primary URLs once per artifact before spawning workers (default `true`). */
  preResolveRedirects?: boolean;
  /** Optional host allowlist passed to RedirectCache & URL checks. */
  allowedHosts?: readonly string[];
  /** Re-verify committed chunks on disk during resume (default `true`). */
  verifyExistingOnResume?: boolean;
  /** Mark installed model as pinned against LRU eviction (default `false`). */
  pinned?: boolean;
  /** Safety storage headroom required when running quota checks (default `0`). */
  safetyHeadroomBytes?: number;
  /** Custom `fetch` implementation. */
  fetchImpl?: typeof fetch;
  /** Progress callback. */
  onProgress?: (telemetry: DownloadTelemetry) => void;
  /** AbortSignal for cooperative cancellation (preserves resume journal). */
  signal?: AbortSignal;
}

export interface DownloadResult {
  modelKey: string;
  metadata: StoredModelMetadata;
  resumedFromJournal: boolean;
  resumedBytes: number;
  networkBytesDownloaded: number;
  totalBytes: number;
  verifiedChunks: number;
  recoveredCorruptions: number;
  elapsedMs: number;
  redirectStats: ReturnType<RedirectCache['getStats']>;
  originStats: ReturnType<OriginMirrorPool['getOriginStats']>;
}

interface ChunkTask {
  artifactIndex: number;
  artifact: ModelArtifactEntry;
  chunkIndex: number;
  offset: number;
  length: number;
  expectedChunkSha256?: string;
  attempt: number;
}

function clampConcurrency(value: number | undefined): number {
  const raw = value ?? DEFAULT_CONCURRENCY;
  if (!Number.isFinite(raw)) {
    return DEFAULT_CONCURRENCY;
  }
  return Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, Math.floor(raw)));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Download aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Download aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('Model download aborted.');
  }
}

export class WorkStealingModelDownloader {
  private readonly options: WorkStealingDownloadOptions;

  constructor(options: WorkStealingDownloadOptions) {
    this.options = options;
  }

  async download(manifest: ModelManifestV1): Promise<DownloadResult> {
    const startMs = performance.now();
    const signal = this.options.signal;
    assertNotAborted(signal);

    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const concurrency = clampConcurrency(this.options.concurrency);
    const defaultChunkSize = Math.max(
      1,
      this.options.defaultChunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES,
    );
    const maxChunkRetries = Math.max(1, this.options.maxChunkRetries ?? 4);
    const retryBaseDelayMs = Math.max(0, this.options.retryBaseDelayMs ?? 150);
    const verifyExistingOnResume = this.options.verifyExistingOnResume ?? true;

    const redirectCache =
      this.options.redirectCache ??
      new RedirectCache({
        fetchImpl,
        allowedHosts: this.options.allowedHosts,
      });
    const mirrorPool = new OriginMirrorPool();
    const quotaManager = new StorageQuotaManager(this.options.vault);
    const modelKey = await deriveModelKey(manifest.modelId, manifest.version);

    let verifiedChunks = 0;
    let totalChunks = 0;
    let bytesDownloaded = 0;
    let networkBytesDownloaded = 0;
    let resumedBytes = 0;
    let recoveredCorruptions = 0;
    let activeWorkers = 0;

    const emitProgress = (phase: DownloadPhase) => {
      if (!this.options.onProgress) {
        return;
      }
      const elapsedMs = Math.max(1, performance.now() - startMs);
      const elapsedSec = elapsedMs / 1000;
      const speedMiBs =
        networkBytesDownloaded > 0
          ? networkBytesDownloaded / (1024 * 1024) / elapsedSec
          : 0;
      const remainingBytes = Math.max(0, manifest.totalBytes - bytesDownloaded);
      const etaSec =
        speedMiBs > 0 ? remainingBytes / (speedMiBs * 1024 * 1024) : 0;

      this.options.onProgress({
        phase,
        modelId: manifest.modelId,
        version: manifest.version,
        bytesDownloaded,
        networkBytesDownloaded,
        resumedBytes,
        totalBytes: manifest.totalBytes,
        speedMiBs,
        etaSec,
        activeWorkers,
        verifiedChunks,
        totalChunks,
        recoveredCorruptions,
        elapsedMs,
      });
    };

    // 1. Verify signed manifest before touching storage or network.
    emitProgress('verifying-manifest');
    const manifestResult = await verifySignedManifest(manifest, {
      pinnedPublicKeys: this.options.pinnedPublicKeys,
    });
    if (!manifestResult.valid) {
      throw new Error(`Manifest verification failed: ${manifestResult.reason}`);
    }

    // 2. Check if already fully installed & valid.
    const existingMeta = await this.options.vault.readModelMetadata(modelKey);
    if (
      existingMeta &&
      existingMeta.merkleRoot === manifest.merkleRoot &&
      existingMeta.totalBytes === manifest.totalBytes
    ) {
      let allPresent = true;
      for (const art of manifest.artifacts) {
        const size = await this.options.vault.getArtifactSize(modelKey, art.path);
        if (size !== art.sizeBytes) {
          allPresent = false;
          break;
        }
      }
      if (allPresent) {
        await this.options.vault.touchModel(modelKey);
        bytesDownloaded = manifest.totalBytes;
        resumedBytes = manifest.totalBytes;
        emitProgress('complete');
        return {
          modelKey,
          metadata: existingMeta,
          resumedFromJournal: true,
          resumedBytes: manifest.totalBytes,
          networkBytesDownloaded: 0,
          totalBytes: manifest.totalBytes,
          verifiedChunks: manifest.artifacts.length,
          recoveredCorruptions: 0,
          elapsedMs: performance.now() - startMs,
          redirectStats: redirectCache.getStats(),
          originStats: mirrorPool.getOriginStats(),
        };
      }
    }

    // 3. Request persistence and ensure sufficient quota (with LRU eviction if needed).
    emitProgress('checking-quota');
    const quotaResult = await quotaManager.ensureSpaceForModel(manifest.totalBytes, {
      safetyHeadroomBytes: this.options.safetyHeadroomBytes,
      protectModelKeys: [modelKey],
      requestPersist: true,
    });
    if (!quotaResult.ok) {
      throw new Error(quotaResult.reason ?? 'Insufficient storage quota for model download.');
    }

    // 4. Inspect resume journal and verify already-committed chunks on disk.
    emitProgress('verifying-resume');
    const priorJournal = await this.options.vault.readResumeJournal(modelKey);
    const journalMatches =
      priorJournal !== null &&
      priorJournal.schemaVersion === 1 &&
      priorJournal.modelId === manifest.modelId &&
      priorJournal.version === manifest.version &&
      priorJournal.merkleRoot === manifest.merkleRoot &&
      priorJournal.totalBytes === manifest.totalBytes;

    const resumedFromJournal = journalMatches;
    const completedChunkSets = new Map<string, Set<number>>();
    const journalArtifacts: Record<string, ResumeArtifactState> = {};
    const queue: ChunkTask[] = [];

    for (let artIdx = 0; artIdx < manifest.artifacts.length; artIdx++) {
      assertNotAborted(signal);
      const artifact = manifest.artifacts[artIdx]!;
      const chunkSize =
        artifact.chunkSizeBytes && artifact.chunkSizeBytes > 0
          ? artifact.chunkSizeBytes
          : defaultChunkSize;
      const chunkCount =
        artifact.sizeBytes === 0 ? 1 : Math.ceil(artifact.sizeBytes / chunkSize);
      totalChunks += chunkCount;

      const priorArt = journalMatches ? priorJournal?.artifacts[artifact.path] : undefined;
      const candidateCompleted =
        priorArt &&
        priorArt.sizeBytes === artifact.sizeBytes &&
        priorArt.totalChunks === chunkCount
          ? decodeChunkBitmap(priorArt.bitmapBase64, chunkCount)
          : new Set<number>();

      const verifiedSet = new Set<number>();
      const diskSize = await this.options.vault.getArtifactSize(modelKey, artifact.path);
      const hasFileOfExpectedSize = diskSize === artifact.sizeBytes;

      for (let chunkIdx = 0; chunkIdx < chunkCount; chunkIdx++) {
        const offset = chunkIdx * chunkSize;
        const length =
          artifact.sizeBytes === 0
            ? 0
            : Math.min(chunkSize, artifact.sizeBytes - offset);
        const expectedChunkSha256 = artifact.chunkSha256?.[chunkIdx];

        let chunkAlreadyValid = false;
        if (hasFileOfExpectedSize && candidateCompleted.has(chunkIdx)) {
          if (!verifyExistingOnResume) {
            chunkAlreadyValid = true;
          } else if (expectedChunkSha256) {
            const diskSlice = await this.options.vault.readArtifactSlice(
              modelKey,
              artifact.path,
              offset,
              length,
            );
            if (diskSlice && diskSlice.byteLength === length) {
              const check = await verifyChunkSha256(diskSlice, expectedChunkSha256);
              if (check.ok) {
                chunkAlreadyValid = true;
              } else {
                recoveredCorruptions += 1;
              }
            }
          } else if (chunkCount === 1) {
            const diskSlice = await this.options.vault.readArtifactSlice(
              modelKey,
              artifact.path,
              0,
              artifact.sizeBytes,
            );
            if (diskSlice && diskSlice.byteLength === artifact.sizeBytes) {
              const check = await verifyChunkSha256(diskSlice, artifact.sha256);
              if (check.ok) {
                chunkAlreadyValid = true;
              } else {
                recoveredCorruptions += 1;
              }
            }
          }
        }

        if (chunkAlreadyValid) {
          verifiedSet.add(chunkIdx);
          verifiedChunks += 1;
          bytesDownloaded += length;
          resumedBytes += length;
        } else {
          queue.push({
            artifactIndex: artIdx,
            artifact,
            chunkIndex: chunkIdx,
            offset,
            length,
            expectedChunkSha256,
            attempt: 0,
          });
        }
      }

      completedChunkSets.set(artifact.path, verifiedSet);
      journalArtifacts[artifact.path] = {
        path: artifact.path,
        sizeBytes: artifact.sizeBytes,
        chunkSizeBytes: chunkSize,
        totalChunks: chunkCount,
        bitmapBase64: encodeChunkBitmap(verifiedSet, chunkCount),
        completed: verifiedSet.size === chunkCount,
      };
    }

    const journal: ResumeJournal = {
      schemaVersion: 1,
      modelKey,
      modelId: manifest.modelId,
      version: manifest.version,
      merkleRoot: manifest.merkleRoot,
      totalBytes: manifest.totalBytes,
      updatedAt: Date.now(),
      artifacts: journalArtifacts,
    };
    await this.options.vault.writeResumeJournal(modelKey, journal);

    // 5. Open artifact writers only for artifacts that still have pending chunks.
    const writers = new Map<string, VaultArtifactWriter>();
    const pendingArtifactPaths = new Set(queue.map((task) => task.artifact.path));
    for (const artifact of manifest.artifacts) {
      if (pendingArtifactPaths.has(artifact.path)) {
        const writer = await this.options.vault.openArtifactWriter(
          modelKey,
          artifact.path,
          artifact.sizeBytes,
        );
        writers.set(artifact.path, writer);
      }
    }

    // Serialize journal persistence so concurrent workers never race JSON writes.
    let journalWriteChain = Promise.resolve();
    const persistJournal = (artifactPath: string, chunkIdx: number) => {
      const set = completedChunkSets.get(artifactPath)!;
      set.add(chunkIdx);
      const artState = journal.artifacts[artifactPath]!;
      artState.bitmapBase64 = encodeChunkBitmap(set, artState.totalChunks);
      artState.completed = set.size === artState.totalChunks;
      journal.updatedAt = Date.now();
      const snapshot = structuredClone(journal);
      journalWriteChain = journalWriteChain.then(() =>
        this.options.vault.writeResumeJournal(modelKey, snapshot),
      );
      return journalWriteChain;
    };

    try {
      // Optional one-time redirect pre-resolution per artifact URL so Hub resolver
      // isn't hammered by `concurrency` simultaneous workers.
      if (this.options.preResolveRedirects !== false && queue.length > 0) {
        const uniqueUrls = new Set<string>();
        for (const task of queue) {
          for (const url of task.artifact.urls) {
            uniqueUrls.add(url);
          }
        }
        await Promise.all(
          Array.from(uniqueUrls).map((url) =>
            redirectCache.resolve(url, signal).catch(() => url),
          ),
        );
      }

      emitProgress('downloading');

      // 6. Dynamic work-stealing worker pool.
      let fatalError: Error | null = null;
      const retryQueue: ChunkTask[] = [];
      let inFlightTasks = 0;

      const takeNextTask = (): ChunkTask | undefined => {
        if (queue.length > 0) {
          return queue.shift();
        }
        if (retryQueue.length > 0) {
          return retryQueue.shift();
        }
        return undefined;
      };

      const fetchAndVerifyChunk = async (task: ChunkTask): Promise<void> => {
        if (task.length === 0) {
          // Zero-byte artifact shortcut.
          const check = await verifyChunkSha256(new Uint8Array(0), task.artifact.sha256);
          if (!check.ok) {
            throw new Error(`Zero-byte SHA-256 mismatch for ${task.artifact.path}`);
          }
          verifiedChunks += 1;
          await persistJournal(task.artifact.path, task.chunkIndex);
          return;
        }

        const mirrorUrl = mirrorPool.acquireMirror(task.artifact.urls);
        const chunkStartMs = performance.now();
        let targetUrl = mirrorUrl;

        try {
          targetUrl = await redirectCache.resolve(mirrorUrl, signal);
          const rangeEnd = task.offset + task.length - 1;
          const isSingleFullRange =
            task.offset === 0 && task.length === task.artifact.sizeBytes;

          const response = await fetchImpl(targetUrl, {
            method: 'GET',
            headers: {
              Range: `bytes=${task.offset}-${rangeEnd}`,
            },
            redirect: 'follow',
            signal,
          });

          if (response.url && response.url !== targetUrl) {
            redirectCache.recordResolved(mirrorUrl, response.url);
          }

          if (response.status !== 206 && !(isSingleFullRange && response.status === 200)) {
            await response.body?.cancel().catch(() => {});
            throw new Error(
              `Unexpected HTTP ${response.status} for ${task.artifact.path} range ${task.offset}-${rangeEnd}`,
            );
          }

          const rawBuf = new Uint8Array(await response.arrayBuffer());
          if (rawBuf.byteLength !== task.length) {
            throw new Error(
              `Range byte length mismatch for ${task.artifact.path} chunk ${task.chunkIndex}: expected ${task.length}, got ${rawBuf.byteLength}`,
            );
          }

          const expectedHash =
            task.expectedChunkSha256 ??
            (isSingleFullRange ? task.artifact.sha256 : undefined);
          if (expectedHash) {
            const check = await verifyChunkSha256(rawBuf, expectedHash);
            if (!check.ok) {
              recoveredCorruptions += 1;
              throw new CorruptionError(
                `SHA-256 mismatch on ${task.artifact.path} chunk ${task.chunkIndex}: expected ${expectedHash}, got ${check.actualSha256}`,
              );
            }
          }

          const writer = writers.get(task.artifact.path)!;
          await writer.writeAt(task.offset, rawBuf);
          mirrorPool.releaseSuccess(
            mirrorUrl,
            rawBuf.byteLength,
            performance.now() - chunkStartMs,
          );

          bytesDownloaded += rawBuf.byteLength;
          networkBytesDownloaded += rawBuf.byteLength;
          verifiedChunks += 1;
          await persistJournal(task.artifact.path, task.chunkIndex);
          emitProgress('downloading');
        } catch (err) {
          mirrorPool.releaseFailure(mirrorUrl);
          throw err;
        }
      };

      const workerCount = Math.min(concurrency, Math.max(1, queue.length));
      const runWorker = async (): Promise<void> => {
        while (!fatalError) {
          assertNotAborted(signal);
          const task = takeNextTask();
          if (!task) {
            if (inFlightTasks === 0) {
              return;
            }
            // Wait briefly for an in-flight retryable task to finish or fail.
            await sleep(20, signal);
            if (!queue.length && !retryQueue.length && inFlightTasks === 0) {
              return;
            }
            continue;
          }

          inFlightTasks += 1;
          activeWorkers += 1;
          try {
            await fetchAndVerifyChunk(task);
          } catch (err) {
            if (signal?.aborted) {
              fatalError =
                err instanceof Error ? err : new Error('Download aborted.');
              return;
            }
            if (task.attempt + 1 < maxChunkRetries) {
              const nextAttempt = task.attempt + 1;
              const delayMs = retryBaseDelayMs * 2 ** (nextAttempt - 1);
              await sleep(delayMs, signal).catch(() => {});
              retryQueue.push({ ...task, attempt: nextAttempt });
            } else {
              fatalError =
                err instanceof Error ? err : new Error(String(err));
              return;
            }
          } finally {
            activeWorkers -= 1;
            inFlightTasks -= 1;
          }
        }
      };

      if (queue.length > 0) {
        await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
      }

      if (fatalError) {
        throw fatalError;
      }

      await journalWriteChain;

      // Flush and close all opened writers before final verification.
      emitProgress('finalizing');
      for (const writer of writers.values()) {
        await writer.flush();
        await writer.close();
      }
      writers.clear();

      // 7. Verify whole-artifact SHA-256 digests cleanly via streaming readback.
      for (const artifact of manifest.artifacts) {
        assertNotAborted(signal);
        const size = await this.options.vault.getArtifactSize(modelKey, artifact.path);
        if (size !== artifact.sizeBytes) {
          throw new Error(
            `Final size mismatch for ${artifact.path}: expected ${artifact.sizeBytes}, got ${String(size)}`,
          );
        }
        const hasher = new StreamingSha256();
        const readChunkSize = 4 * 1024 * 1024;
        for (let offset = 0; offset < artifact.sizeBytes; offset += readChunkSize) {
          const len = Math.min(readChunkSize, artifact.sizeBytes - offset);
          const slice = await this.options.vault.readArtifactSlice(
            modelKey,
            artifact.path,
            offset,
            len,
          );
          if (!slice || slice.byteLength !== len) {
            throw new Error(`Missing artifact bytes during final readback: ${artifact.path}`);
          }
          hasher.update(slice);
        }
        const actualSha256 = hasher.digestHex();
        if (actualSha256 !== artifact.sha256.toLowerCase()) {
          throw new Error(
            `Final SHA-256 verification failed for ${artifact.path}: expected ${artifact.sha256}, got ${actualSha256}`,
          );
        }
      }

      // 8. Commit metadata and remove resume journal.
      const now = Date.now();
      const metadata: StoredModelMetadata = {
        schemaVersion: 1,
        modelKey,
        modelId: manifest.modelId,
        version: manifest.version,
        merkleRoot: manifest.merkleRoot,
        totalBytes: manifest.totalBytes,
        pinned: this.options.pinned ?? false,
        installedAt: now,
        lastAccessedAt: now,
        manifest,
      };
      await this.options.vault.commitModel(modelKey, metadata);
      await this.options.vault.deleteResumeJournal(modelKey);

      emitProgress('complete');

      return {
        modelKey,
        metadata,
        resumedFromJournal,
        resumedBytes,
        networkBytesDownloaded,
        totalBytes: manifest.totalBytes,
        verifiedChunks,
        recoveredCorruptions,
        elapsedMs: performance.now() - startMs,
        redirectStats: redirectCache.getStats(),
        originStats: mirrorPool.getOriginStats(),
      };
    } finally {
      await journalWriteChain.catch(() => {});
      for (const writer of writers.values()) {
        await writer.close().catch(() => {});
      }
    }
  }
}

class CorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CorruptionError';
  }
}

export async function downloadVerifiedModel(
  manifest: ModelManifestV1,
  options: WorkStealingDownloadOptions,
): Promise<DownloadResult> {
  const downloader = new WorkStealingModelDownloader(options);
  return downloader.download(manifest);
}
