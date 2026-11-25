import { OpfsSyncVault, resolveArtifactParentDir, type OpfsVaultOptions } from './opfsSyncVault.js';
import type { ModelVaultBackend, OpfsFileHandleLike, VaultArtifactWriter } from './types.js';

class AsyncOpfsArtifactWriter implements VaultArtifactWriter {
  private readonly fileHandle: OpfsFileHandleLike;
  private writeQueue: Promise<void> = Promise.resolve();
  private totalBytes = 0;

  constructor(fileHandle: OpfsFileHandleLike, totalBytes: number) {
    this.fileHandle = fileHandle;
    this.totalBytes = totalBytes;
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(task);
    this.writeQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async preallocate(totalBytes: number): Promise<void> {
    this.totalBytes = totalBytes;
  }

  async writeAt(offset: number, data: Uint8Array): Promise<void> {
    return this.enqueue(async () => {
      const existing = await this.fileHandle.getFile();
      const writable = await this.fileHandle.createWritable({
        keepExistingData: existing.size > 0,
      });
      try {
        if (typeof writable.seek === 'function') {
          if (existing.size < offset && existing.size === 0 && this.totalBytes > 0) {
            // Keep sparse writes valid even if underlying implementation doesn't auto-extend on seek.
            await writable.write({ type: 'write', position: offset, data });
          } else {
            await writable.seek(offset);
            await writable.write(data);
          }
        } else {
          await writable.write({ type: 'write', position: offset, data });
        }
        await writable.close();
      } catch (err) {
        await writable.abort?.(err).catch(() => {});
        throw err;
      }
    });
  }

  async readAt(offset: number, length: number): Promise<Uint8Array> {
    return this.enqueue(async () => {
      const file = await this.fileHandle.getFile();
      if (offset >= file.size) {
        return new Uint8Array(0);
      }
      const end = Math.min(file.size, offset + length);
      return new Uint8Array(await file.slice(offset, end).arrayBuffer());
    });
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  async close(): Promise<void> {
    await this.writeQueue;
  }
}

/**
 * Fallback OPFS backend for Window / Offscreen Document contexts where
 * `FileSystemSyncAccessHandle` is unavailable. Uses `FileSystemWritableFileStream`
 * with per-file serialized positional writes.
 */
export class OpfsAsyncVault extends OpfsSyncVault {
  override readonly kind: ModelVaultBackend['kind'] = 'opfs-async';

  constructor(options: OpfsVaultOptions = {}) {
    super(options);
  }

  override async openArtifactWriter(
    modelKey: string,
    artifactPath: string,
    totalBytes: number,
  ): Promise<VaultArtifactWriter> {
    const modelDir = await this.getModelDir(modelKey, true);
    if (!modelDir) {
      throw new Error(`Unable to open model directory: ${modelKey}`);
    }
    const artifactsDir = await modelDir.getDirectoryHandle('artifacts', { create: true });
    const resolved = await resolveArtifactParentDir(artifactsDir, artifactPath, true);
    if (!resolved) {
      throw new Error(`Unable to resolve artifact path: ${artifactPath}`);
    }
    const fileHandle = await resolved.dir.getFileHandle(resolved.fileName, { create: true });
    return new AsyncOpfsArtifactWriter(fileHandle, totalBytes);
  }
}
