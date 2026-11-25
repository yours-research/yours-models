import { isSafeArtifactPath } from '../manifest/ed25519.js';
import type {
  ModelVaultBackend,
  OpfsDirectoryHandleLike,
  OpfsFileHandleLike,
  OpfsSyncAccessHandleLike,
  ResumeJournal,
  StorageQuotaInfo,
  StoredModelMetadata,
  VaultArtifactWriter,
} from './types.js';

export const DEFAULT_VAULT_ROOT_DIR = 'yours-models-vault';
const RESUME_JOURNAL_FILE = 'resume.part.json';
const MODEL_META_FILE = 'model.meta.json';
const ARTIFACTS_SUBDIR = 'artifacts';

export interface OpfsVaultOptions {
  /** Root directory name under OPFS (default: `yours-models-vault`). */
  rootDirName?: string;
  /** Optional OPFS directory provider (defaults to `navigator.storage.getDirectory()`). */
  getRootDir?: () => Promise<OpfsDirectoryHandleLike>;
}

const textEncoder = new TextEncoder();

export async function getDefaultOpfsRoot(): Promise<OpfsDirectoryHandleLike> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    throw new Error('OPFS (navigator.storage.getDirectory) is unavailable in this environment.');
  }
  return (await navigator.storage.getDirectory()) as unknown as OpfsDirectoryHandleLike;
}

export async function getOptionalFile(
  dir: OpfsDirectoryHandleLike,
  name: string,
): Promise<OpfsFileHandleLike | null> {
  try {
    return await dir.getFileHandle(name, { create: false });
  } catch {
    return null;
  }
}

export async function getOptionalDir(
  dir: OpfsDirectoryHandleLike,
  name: string,
): Promise<OpfsDirectoryHandleLike | null> {
  try {
    return await dir.getDirectoryHandle(name, { create: false });
  } catch {
    return null;
  }
}

export async function resolveArtifactParentDir(
  artifactsDir: OpfsDirectoryHandleLike,
  artifactPath: string,
  create: boolean,
): Promise<{ dir: OpfsDirectoryHandleLike; fileName: string } | null> {
  if (!isSafeArtifactPath(artifactPath)) {
    throw new Error(`Unsafe artifact path: ${artifactPath}`);
  }
  const parts = artifactPath.split('/').filter(Boolean);
  const fileName = parts.pop();
  if (!fileName) {
    throw new Error(`Empty artifact filename: ${artifactPath}`);
  }
  let current = artifactsDir;
  for (const part of parts) {
    try {
      current = await current.getDirectoryHandle(part, { create });
    } catch {
      if (!create) {
        return null;
      }
      throw new Error(`Failed to open OPFS subdirectory: ${part}`);
    }
  }
  return { dir: current, fileName };
}

export async function writeSmallTextFile(
  dir: OpfsDirectoryHandleLike,
  name: string,
  content: string,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  if (typeof handle.createSyncAccessHandle === 'function') {
    const sync = await handle.createSyncAccessHandle();
    try {
      const encoded = textEncoder.encode(content);
      sync.truncate(0);
      sync.write(encoded, { at: 0 });
      sync.flush();
    } finally {
      sync.close();
    }
    return;
  }
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    await writable.write(content);
    await writable.close();
  } catch (err) {
    await writable.abort?.(err).catch(() => {});
    throw err;
  }
}

export async function readSmallJsonFile<T>(
  dir: OpfsDirectoryHandleLike,
  name: string,
): Promise<T | null> {
  const handle = await getOptionalFile(dir, name);
  if (!handle) {
    return null;
  }
  try {
    const file = await handle.getFile();
    return JSON.parse(await file.text()) as T;
  } catch {
    return null;
  }
}

class SyncOpfsArtifactWriter implements VaultArtifactWriter {
  private readonly handle: OpfsSyncAccessHandleLike;
  private closed = false;

  constructor(handle: OpfsSyncAccessHandleLike) {
    this.handle = handle;
  }

  async preallocate(totalBytes: number): Promise<void> {
    if (this.handle.getSize() !== totalBytes) {
      this.handle.truncate(totalBytes);
    }
  }

  async writeAt(offset: number, data: Uint8Array): Promise<void> {
    if (this.closed) {
      throw new Error('Cannot write to a closed OpfsSyncVault writer.');
    }
    let written = 0;
    while (written < data.byteLength) {
      const n = this.handle.write(data.subarray(written), { at: offset + written });
      if (n <= 0) {
        throw new Error(`SyncAccessHandle.write stalled at offset ${offset + written}`);
      }
      written += n;
    }
  }

  async readAt(offset: number, length: number): Promise<Uint8Array> {
    const buf = new Uint8Array(length);
    let readTotal = 0;
    while (readTotal < length) {
      const n = this.handle.read(buf.subarray(readTotal), { at: offset + readTotal });
      if (n <= 0) {
        break;
      }
      readTotal += n;
    }
    return readTotal === length ? buf : buf.subarray(0, readTotal);
  }

  async flush(): Promise<void> {
    if (!this.closed) {
      this.handle.flush();
    }
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.handle.flush();
      this.handle.close();
    }
  }
}

/**
 * High-throughput OPFS backend for Dedicated Web Workers using synchronous
 * `FileSystemSyncAccessHandle` positional reads/writes with zero JS-stream overhead.
 */
export class OpfsSyncVault implements ModelVaultBackend {
  readonly kind: ModelVaultBackend['kind'] = 'opfs-sync';
  private readonly rootDirName: string;
  private readonly getRootDirFn: () => Promise<OpfsDirectoryHandleLike>;

  constructor(options: OpfsVaultOptions = {}) {
    this.rootDirName = options.rootDirName ?? DEFAULT_VAULT_ROOT_DIR;
    this.getRootDirFn = options.getRootDir ?? getDefaultOpfsRoot;
  }

  protected async getVaultDir(create: boolean): Promise<OpfsDirectoryHandleLike | null> {
    const root = await this.getRootDirFn();
    try {
      return await root.getDirectoryHandle(this.rootDirName, { create });
    } catch {
      return null;
    }
  }

  protected async getModelDir(
    modelKey: string,
    create: boolean,
  ): Promise<OpfsDirectoryHandleLike | null> {
    const vaultDir = await this.getVaultDir(create);
    if (!vaultDir) {
      return null;
    }
    try {
      return await vaultDir.getDirectoryHandle(modelKey, { create });
    } catch {
      return null;
    }
  }

  async openArtifactWriter(
    modelKey: string,
    artifactPath: string,
    totalBytes: number,
  ): Promise<VaultArtifactWriter> {
    const modelDir = await this.getModelDir(modelKey, true);
    if (!modelDir) {
      throw new Error(`Unable to open model directory: ${modelKey}`);
    }
    const artifactsDir = await modelDir.getDirectoryHandle(ARTIFACTS_SUBDIR, { create: true });
    const resolved = await resolveArtifactParentDir(artifactsDir, artifactPath, true);
    if (!resolved) {
      throw new Error(`Unable to resolve artifact path: ${artifactPath}`);
    }
    const fileHandle = await resolved.dir.getFileHandle(resolved.fileName, { create: true });
    if (typeof fileHandle.createSyncAccessHandle !== 'function') {
      throw new Error(
        'FileSystemFileHandle.createSyncAccessHandle() is only available inside a Dedicated Worker. Use OpfsAsyncVault outside workers.',
      );
    }
    const syncHandle = await fileHandle.createSyncAccessHandle();
    const writer = new SyncOpfsArtifactWriter(syncHandle);
    await writer.preallocate(totalBytes);
    return writer;
  }

  async readArtifact(modelKey: string, artifactPath: string): Promise<Uint8Array | null> {
    const fileHandle = await this.findArtifactHandle(modelKey, artifactPath);
    if (!fileHandle) {
      return null;
    }
    const file = await fileHandle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  async readArtifactSlice(
    modelKey: string,
    artifactPath: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array | null> {
    const fileHandle = await this.findArtifactHandle(modelKey, artifactPath);
    if (!fileHandle) {
      return null;
    }
    const file = await fileHandle.getFile();
    if (offset >= file.size) {
      return new Uint8Array(0);
    }
    const end = Math.min(file.size, offset + length);
    return new Uint8Array(await file.slice(offset, end).arrayBuffer());
  }

  async getArtifactSize(modelKey: string, artifactPath: string): Promise<number | null> {
    const fileHandle = await this.findArtifactHandle(modelKey, artifactPath);
    if (!fileHandle) {
      return null;
    }
    const file = await fileHandle.getFile();
    return file.size;
  }

  private async findArtifactHandle(
    modelKey: string,
    artifactPath: string,
  ): Promise<OpfsFileHandleLike | null> {
    const modelDir = await this.getModelDir(modelKey, false);
    if (!modelDir) {
      return null;
    }
    const artifactsDir = await getOptionalDir(modelDir, ARTIFACTS_SUBDIR);
    if (!artifactsDir) {
      return null;
    }
    const resolved = await resolveArtifactParentDir(artifactsDir, artifactPath, false);
    if (!resolved) {
      return null;
    }
    return getOptionalFile(resolved.dir, resolved.fileName);
  }

  async readResumeJournal(modelKey: string): Promise<ResumeJournal | null> {
    const modelDir = await this.getModelDir(modelKey, false);
    if (!modelDir) {
      return null;
    }
    return readSmallJsonFile<ResumeJournal>(modelDir, RESUME_JOURNAL_FILE);
  }

  async writeResumeJournal(modelKey: string, journal: ResumeJournal): Promise<void> {
    const modelDir = await this.getModelDir(modelKey, true);
    if (!modelDir) {
      throw new Error(`Unable to open model directory for journal: ${modelKey}`);
    }
    await writeSmallTextFile(modelDir, RESUME_JOURNAL_FILE, JSON.stringify(journal));
  }

  async deleteResumeJournal(modelKey: string): Promise<void> {
    const modelDir = await this.getModelDir(modelKey, false);
    if (!modelDir) {
      return;
    }
    await modelDir.removeEntry(RESUME_JOURNAL_FILE).catch(() => {});
  }

  async commitModel(modelKey: string, metadata: StoredModelMetadata): Promise<void> {
    const modelDir = await this.getModelDir(modelKey, true);
    if (!modelDir) {
      throw new Error(`Unable to open model directory for commit: ${modelKey}`);
    }
    await writeSmallTextFile(modelDir, MODEL_META_FILE, JSON.stringify(metadata));
  }

  async readModelMetadata(modelKey: string): Promise<StoredModelMetadata | null> {
    const modelDir = await this.getModelDir(modelKey, false);
    if (!modelDir) {
      return null;
    }
    return readSmallJsonFile<StoredModelMetadata>(modelDir, MODEL_META_FILE);
  }

  async listModels(): Promise<StoredModelMetadata[]> {
    const vaultDir = await this.getVaultDir(false);
    if (!vaultDir || typeof vaultDir.entries !== 'function') {
      return [];
    }
    const models: StoredModelMetadata[] = [];
    for await (const [, handle] of vaultDir.entries()) {
      if (handle.kind === 'directory') {
        const meta = await readSmallJsonFile<StoredModelMetadata>(handle, MODEL_META_FILE);
        if (meta && meta.schemaVersion === 1) {
          models.push(meta);
        }
      }
    }
    return models;
  }

  async touchModel(modelKey: string, nowMs = Date.now()): Promise<void> {
    const meta = await this.readModelMetadata(modelKey);
    if (!meta) {
      return;
    }
    meta.lastAccessedAt = nowMs;
    await this.commitModel(modelKey, meta);
  }

  async setModelPinned(modelKey: string, pinned: boolean): Promise<boolean> {
    const meta = await this.readModelMetadata(modelKey);
    if (!meta) {
      return false;
    }
    meta.pinned = pinned;
    await this.commitModel(modelKey, meta);
    return true;
  }

  async deleteModel(modelKey: string): Promise<void> {
    const vaultDir = await this.getVaultDir(false);
    if (!vaultDir) {
      return;
    }
    await vaultDir.removeEntry(modelKey, { recursive: true }).catch(() => {});
  }

  async getStorageEstimate(): Promise<StorageQuotaInfo> {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) {
      return {
        supported: false,
        persisted: null,
        quotaBytes: null,
        usageBytes: null,
        availableBytes: null,
      };
    }
    try {
      const [estimate, persisted] = await Promise.all([
        navigator.storage.estimate(),
        typeof navigator.storage.persisted === 'function'
          ? navigator.storage.persisted().catch(() => null)
          : Promise.resolve(null),
      ]);
      const quotaBytes = estimate.quota ?? null;
      const usageBytes = estimate.usage ?? null;
      const availableBytes =
        quotaBytes !== null && usageBytes !== null
          ? Math.max(0, quotaBytes - usageBytes)
          : null;
      return {
        supported: true,
        persisted,
        quotaBytes,
        usageBytes,
        availableBytes,
      };
    } catch {
      return {
        supported: false,
        persisted: null,
        quotaBytes: null,
        usageBytes: null,
        availableBytes: null,
      };
    }
  }

  async requestPersistence(): Promise<boolean | null> {
    if (typeof navigator === 'undefined' || typeof navigator.storage?.persist !== 'function') {
      return null;
    }
    try {
      return await navigator.storage.persist();
    } catch {
      return null;
    }
  }
}
