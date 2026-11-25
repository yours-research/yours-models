import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deriveModelKey,
  downloadVerifiedModel,
  exportEd25519PublicKeyRaw,
  generateEd25519KeyPair,
  MemoryVault,
  OpfsAsyncVault,
  OpfsSyncVault,
  RedirectCache,
  sha256Hex,
  signManifest,
  StorageQuotaManager,
  WorkStealingModelDownloader,
  type DownloadTelemetry,
  type ModelManifestV1,
  type OpfsDirectoryHandleLike,
  type OpfsFileHandleLike,
  type OpfsSyncAccessHandleLike,
  type OpfsWritableStreamLike,
} from '../src/index.js';

interface TestServerHandle {
  origin: string;
  requests: Array<{ method: string; url: string; range?: string }>;
  close: () => Promise<void>;
}

async function startRangeServer(
  files: Record<string, Uint8Array>,
  options: {
    corruptOnce?: (path: string, rangeHeader: string | undefined, attempt: number) => boolean;
    redirectPrefix?: string;
    cdnPrefix?: string;
  } = {},
): Promise<TestServerHandle> {
  const requests: Array<{ method: string; url: string; range?: string }> = [];
  const attemptCounts = new Map<string, number>();

  const server = http.createServer((req, res) => {
    const reqUrl = req.url ?? '/';
    const method = req.method ?? 'GET';
    const rangeHeader = req.headers.range;
    requests.push({ method, url: reqUrl, range: rangeHeader });

    if (options.redirectPrefix && reqUrl.startsWith(options.redirectPrefix)) {
      const targetPath = (options.cdnPrefix ?? '/cdn') + reqUrl.slice(options.redirectPrefix.length);
      res.writeHead(302, { Location: targetPath });
      res.end();
      return;
    }

    const cleanPath =
      options.cdnPrefix && reqUrl.startsWith(options.cdnPrefix)
        ? reqUrl.slice(options.cdnPrefix.length)
        : reqUrl;
    const key = cleanPath.replace(/^\/+/, '');
    const data = files[key];
    if (!data) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    if (method === 'HEAD') {
      res.writeHead(200, {
        'Content-Length': String(data.byteLength),
        'Accept-Ranges': 'bytes',
      });
      res.end();
      return;
    }

    if (rangeHeader) {
      const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
      if (!match) {
        res.writeHead(416);
        res.end();
        return;
      }
      const start = Number(match[1]);
      const end = Math.min(data.byteLength - 1, Number(match[2]));
      if (start > end || start >= data.byteLength) {
        res.writeHead(416);
        res.end();
        return;
      }

      const slice = data.slice(start, end + 1);
      const countKey = `${key}:${rangeHeader}`;
      const attempt = (attemptCounts.get(countKey) ?? 0) + 1;
      attemptCounts.set(countKey, attempt);

      if (options.corruptOnce?.(key, rangeHeader, attempt) && slice.byteLength > 10) {
        // Flip 1 byte in the middle of the chunk!
        const mid = Math.floor(slice.byteLength / 2);
        slice[mid] = (slice[mid]! ^ 0x55) & 0xff;
      }

      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(slice.byteLength),
        'Content-Range': `bytes ${start}-${end}/${data.byteLength}`,
        'Accept-Ranges': 'bytes',
      });
      res.end(Buffer.from(slice));
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(data.byteLength),
      'Accept-Ranges': 'bytes',
    });
    res.end(Buffer.from(data));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function makeDeterministicBytes(size: number, seed = 13): Uint8Array {
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    buf[i] = (i * 31 + seed + (i >> 8)) & 0xff;
  }
  return buf;
}

async function buildSignedTestManifest(
  artifactsSpec: Array<{ path: string; data: Uint8Array; chunkSizeBytes: number; urls: string[] }>,
  modelId = 'yours-research/Pragma-1-4B-WGSL',
  version = '1.0.0',
): Promise<{ manifest: ModelManifestV1; publicKeyRaw: Uint8Array }> {
  const kp = await generateEd25519KeyPair();
  const publicKeyRaw = await exportEd25519PublicKeyRaw(kp.publicKey);
  const artifacts = [];
  let totalBytes = 0;

  for (const spec of artifactsSpec) {
    const chunkSha256: string[] = [];
    for (let off = 0; off < spec.data.byteLength; off += spec.chunkSizeBytes) {
      const end = Math.min(spec.data.byteLength, off + spec.chunkSizeBytes);
      chunkSha256.push(await sha256Hex(spec.data.subarray(off, end)));
    }
    artifacts.push({
      path: spec.path,
      sizeBytes: spec.data.byteLength,
      sha256: await sha256Hex(spec.data),
      chunkSizeBytes: spec.chunkSizeBytes,
      chunkSha256,
      urls: spec.urls,
    });
    totalBytes += spec.data.byteLength;
  }

  const manifest = await signManifest(
    {
      schemaVersion: 1,
      modelId,
      version,
      architecture: 'qwen35-deltanet',
      quantization: 'q4f16',
      totalBytes,
      merkleRoot: '',
      artifacts,
    },
    kp.privateKey,
  );

  return { manifest, publicKeyRaw };
}

/**
 * In-memory mock OPFS FileSystemDirectoryHandle implementing both
 * `createSyncAccessHandle()` (Dedicated Worker) and `createWritable()` (async fallback).
 */
function createMockOpfsRoot(): OpfsDirectoryHandleLike {
  const makeDir = (name: string): OpfsDirectoryHandleLike => {
    const dirs = new Map<string, OpfsDirectoryHandleLike>();
    const files = new Map<string, { data: Uint8Array }>();

    const makeFileHandle = (fileName: string, entry: { data: Uint8Array }): OpfsFileHandleLike => ({
      kind: 'file',
      name: fileName,
      async getFile() {
        const snapshot = entry.data.slice();
        return {
          size: snapshot.byteLength,
          async arrayBuffer() {
            return snapshot.buffer;
          },
          async text() {
            return new TextDecoder().decode(snapshot);
          },
          slice(start = 0, end = snapshot.byteLength) {
            return new Blob([snapshot.subarray(start, end)]);
          },
        };
      },
      async createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritableStreamLike> {
        let buffer = options?.keepExistingData ? entry.data.slice() : new Uint8Array(0);
        let cursor = 0;
        const ensureSize = (size: number) => {
          if (size > buffer.byteLength) {
            const next = new Uint8Array(size);
            next.set(buffer, 0);
            buffer = next;
          }
        };
        return {
          async seek(pos: number) {
            cursor = pos;
          },
          async write(chunk) {
            if (typeof chunk === 'string') {
              const encoded = new TextEncoder().encode(chunk);
              ensureSize(cursor + encoded.byteLength);
              buffer.set(encoded, cursor);
              cursor += encoded.byteLength;
            } else if (chunk instanceof Uint8Array || chunk instanceof ArrayBuffer) {
              const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
              ensureSize(cursor + bytes.byteLength);
              buffer.set(bytes, cursor);
              cursor += bytes.byteLength;
            } else {
              const pos = chunk.position ?? cursor;
              const bytes =
                typeof chunk.data === 'string'
                  ? new TextEncoder().encode(chunk.data)
                  : chunk.data instanceof Uint8Array
                    ? chunk.data
                    : new Uint8Array(chunk.data);
              ensureSize(pos + bytes.byteLength);
              buffer.set(bytes, pos);
              cursor = pos + bytes.byteLength;
            }
          },
          async close() {
            entry.data = buffer;
          },
          async abort() {},
        };
      },
      async createSyncAccessHandle(): Promise<OpfsSyncAccessHandleLike> {
        return {
          getSize() {
            return entry.data.byteLength;
          },
          truncate(newSize: number) {
            const next = new Uint8Array(newSize);
            next.set(entry.data.subarray(0, Math.min(entry.data.byteLength, newSize)), 0);
            entry.data = next;
          },
          write(buf: ArrayBufferView, options?: { at?: number }) {
            const at = options?.at ?? 0;
            const src = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
            if (at + src.byteLength > entry.data.byteLength) {
              const next = new Uint8Array(at + src.byteLength);
              next.set(entry.data, 0);
              entry.data = next;
            }
            entry.data.set(src, at);
            return src.byteLength;
          },
          read(buf: ArrayBufferView, options?: { at?: number }) {
            const at = options?.at ?? 0;
            if (at >= entry.data.byteLength) {
              return 0;
            }
            const dst = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
            const count = Math.min(dst.byteLength, entry.data.byteLength - at);
            dst.set(entry.data.subarray(at, at + count), 0);
            return count;
          },
          flush() {},
          close() {},
        };
      },
    });

    const dirHandle: OpfsDirectoryHandleLike = {
      kind: 'directory',
      name,
      async getDirectoryHandle(subName: string, options?: { create?: boolean }) {
        let sub = dirs.get(subName);
        if (!sub) {
          if (!options?.create) {
            throw new Error(`Directory not found: ${subName}`);
          }
          sub = makeDir(subName);
          dirs.set(subName, sub);
        }
        return sub;
      },
      async getFileHandle(fileName: string, options?: { create?: boolean }) {
        let entry = files.get(fileName);
        if (!entry) {
          if (!options?.create) {
            throw new Error(`File not found: ${fileName}`);
          }
          entry = { data: new Uint8Array(0) };
          files.set(fileName, entry);
        }
        return makeFileHandle(fileName, entry);
      },
      async removeEntry(entryName: string) {
        dirs.delete(entryName);
        files.delete(entryName);
      },
      async *entries() {
        for (const [dName, dHandle] of dirs.entries()) {
          yield [dName, dHandle];
        }
        for (const [fName, fEntry] of files.entries()) {
          yield [fName, makeFileHandle(fName, fEntry)];
        }
      },
    };
    return dirHandle;
  };

  return makeDir('opfs-root');
}

describe('Work-Stealing Downloader, OPFS Vaults & Quota Manager', () => {
  const servers: TestServerHandle[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await servers.pop()!.close();
    }
  });

  it('downloads via parallel Range requests, caches 302 redirects once, and emits telemetry', async () => {
    const chunkSize = 16 * 1024;
    const blob = makeDeterministicBytes(chunkSize * 6 + 777, 5);
    const server = await startRangeServer(
      { 'slab0.part00.bin': blob },
      { redirectPrefix: '/hub', cdnPrefix: '/cdn' },
    );
    servers.push(server);

    const { manifest, publicKeyRaw } = await buildSignedTestManifest([
      {
        path: 'slab0.part00.bin',
        data: blob,
        chunkSizeBytes: chunkSize,
        urls: [`${server.origin}/hub/slab0.part00.bin`],
      },
    ]);

    const vault = new MemoryVault();
    const redirectCache = new RedirectCache();
    const progressEvents: DownloadTelemetry[] = [];

    const result = await downloadVerifiedModel(manifest, {
      vault,
      pinnedPublicKeys: [publicKeyRaw],
      concurrency: 4,
      redirectCache,
      onProgress: (t) => progressEvents.push(t),
    });

    expect(result.totalBytes).toBe(blob.byteLength);
    expect(result.networkBytesDownloaded).toBe(blob.byteLength);
    expect(result.verifiedChunks).toBe(7);
    expect(result.recoveredCorruptions).toBe(0);
    expect(result.redirectStats.resolutions).toBe(1);

    // Confirm /hub/ was only resolved once across all 7 Range chunk requests!
    const hubHits = server.requests.filter((r) => r.url.startsWith('/hub/'));
    expect(hubHits.length).toBe(1);
    const cdnRangeHits = server.requests.filter((r) => r.url.startsWith('/cdn/') && r.range);
    expect(cdnRangeHits.length).toBe(7);

    const stored = await vault.readArtifact(result.modelKey, 'slab0.part00.bin');
    expect(stored).toEqual(blob);
    expect(progressEvents.some((e) => e.phase === 'complete')).toBe(true);
  });

  it('detects 1-byte mid-chunk corruption and recovers via single-chunk Range retry', async () => {
    const chunkSize = 32 * 1024;
    const blob = makeDeterministicBytes(chunkSize * 4, 9);
    const targetRange = `bytes=${chunkSize * 2}-${chunkSize * 3 - 1}`;

    const server = await startRangeServer(
      { 'slab0.bin': blob },
      {
        corruptOnce: (_path, range, attempt) => range === targetRange && attempt === 1,
      },
    );
    servers.push(server);

    const { manifest, publicKeyRaw } = await buildSignedTestManifest([
      {
        path: 'slab0.bin',
        data: blob,
        chunkSizeBytes: chunkSize,
        urls: [`${server.origin}/slab0.bin`],
      },
    ]);

    const vault = new MemoryVault();
    const result = await downloadVerifiedModel(manifest, {
      vault,
      pinnedPublicKeys: [publicKeyRaw],
      concurrency: 4,
      retryBaseDelayMs: 5,
    });

    expect(result.recoveredCorruptions).toBe(1);
    expect(result.verifiedChunks).toBe(4);
    const retriedRangeCalls = server.requests.filter((r) => r.range === targetRange);
    expect(retriedRangeCalls.length).toBe(2);
    // Other chunks were fetched only once!
    const firstChunkCalls = server.requests.filter((r) => r.range === `bytes=0-${chunkSize - 1}`);
    expect(firstChunkCalls.length).toBe(1);

    expect(await vault.readArtifact(result.modelKey, 'slab0.bin')).toEqual(blob);
  });

  it('resumes interrupted download via bitmap journal and re-fetches disk-corrupted chunks', async () => {
    const chunkSize = 16 * 1024;
    const blob = makeDeterministicBytes(chunkSize * 6, 42);
    const server = await startRangeServer({ 'weights.bin': blob });
    servers.push(server);

    const { manifest, publicKeyRaw } = await buildSignedTestManifest([
      {
        path: 'weights.bin',
        data: blob,
        chunkSizeBytes: chunkSize,
        urls: [`${server.origin}/weights.bin`],
      },
    ]);

    const vault = new MemoryVault();
    const ac = new AbortController();
    let aborted = false;

    // Abort after 3 chunks are verified
    await expect(
      downloadVerifiedModel(manifest, {
        vault,
        pinnedPublicKeys: [publicKeyRaw],
        concurrency: 1,
        signal: ac.signal,
        onProgress: (t) => {
          if (t.verifiedChunks >= 3 && !aborted) {
            aborted = true;
            ac.abort(new Error('Simulated power loss'));
          }
        },
      }),
    ).rejects.toThrow('Simulated power loss');

    const modelKey = await deriveModelKey(manifest.modelId, manifest.version);
    const journalBeforeResume = await vault.readResumeJournal(modelKey);
    expect(journalBeforeResume).not.toBeNull();

    // Corrupt 1 byte inside chunk 0 on disk to ensure resume verification catches it!
    vault.mutateArtifactByteForTest(modelKey, 'weights.bin', 123);

    server.requests.length = 0;

    const resumed = await downloadVerifiedModel(manifest, {
      vault,
      pinnedPublicKeys: [publicKeyRaw],
      concurrency: 4,
    });

    expect(resumed.resumedFromJournal).toBe(true);
    // 2 valid chunks (chunks 1 & 2) were skipped; chunk 0 was detected as corrupted on disk & re-fetched!
    expect(resumed.recoveredCorruptions).toBe(1);
    expect(resumed.resumedBytes).toBe(chunkSize * 2);
    expect(resumed.networkBytesDownloaded).toBe(chunkSize * 4);
    expect(await vault.readArtifact(modelKey, 'weights.bin')).toEqual(blob);
    expect(await vault.readResumeJournal(modelKey)).toBeNull();

    // Verify server only served the 4 missing/corrupted ranges
    const rangeReqs = server.requests.filter((r) => Boolean(r.range));
    expect(rangeReqs.length).toBe(4);
  });

  it('work-steals across multiple origin mirrors in round-robin fashion', async () => {
    const chunkSize = 8 * 1024;
    const blob = makeDeterministicBytes(chunkSize * 8, 77);
    const serverA = await startRangeServer({ 'shard.bin': blob });
    const serverB = await startRangeServer({ 'shard.bin': blob });
    servers.push(serverA, serverB);

    const { manifest, publicKeyRaw } = await buildSignedTestManifest([
      {
        path: 'shard.bin',
        data: blob,
        chunkSizeBytes: chunkSize,
        urls: [`${serverA.origin}/shard.bin`, `${serverB.origin}/shard.bin`],
      },
    ]);

    const vault = new MemoryVault();
    const res = await downloadVerifiedModel(manifest, {
      vault,
      pinnedPublicKeys: [publicKeyRaw],
      concurrency: 4,
    });

    const aRanges = serverA.requests.filter((r) => Boolean(r.range)).length;
    const bRanges = serverB.requests.filter((r) => Boolean(r.range)).length;
    expect(aRanges).toBeGreaterThan(0);
    expect(bRanges).toBeGreaterThan(0);
    expect(aRanges + bRanges).toBe(8);
    expect(Object.keys(res.originStats)).toHaveLength(2);
  });

  it('works with OpfsSyncVault and OpfsAsyncVault including nested paths', async () => {
    const chunkSize = 16 * 1024;
    const blob = makeDeterministicBytes(chunkSize * 3 + 512, 3);
    const server = await startRangeServer({ 'onnx/slab0.bin': blob });
    servers.push(server);

    const { manifest, publicKeyRaw } = await buildSignedTestManifest([
      {
        path: 'onnx/slab0.bin',
        data: blob,
        chunkSizeBytes: chunkSize,
        urls: [`${server.origin}/onnx/slab0.bin`],
      },
    ]);

    const syncRoot = createMockOpfsRoot();
    const syncVault = new OpfsSyncVault({ getRootDir: async () => syncRoot });
    const syncRes = await new WorkStealingModelDownloader({
      vault: syncVault,
      pinnedPublicKeys: [publicKeyRaw],
      concurrency: 4,
    }).download(manifest);
    expect(await syncVault.readArtifact(syncRes.modelKey, 'onnx/slab0.bin')).toEqual(blob);

    const asyncRoot = createMockOpfsRoot();
    const asyncVault = new OpfsAsyncVault({ getRootDir: async () => asyncRoot });
    const asyncRes = await new WorkStealingModelDownloader({
      vault: asyncVault,
      pinnedPublicKeys: [publicKeyRaw],
      concurrency: 4,
    }).download(manifest);
    expect(await asyncVault.readArtifact(asyncRes.modelKey, 'onnx/slab0.bin')).toEqual(blob);
  });

  it('enforces storage quota via LRU eviction while respecting pinned models', async () => {
    const chunkSize = 32 * 1024;
    const blobA = makeDeterministicBytes(chunkSize * 2, 1); // 64 KiB
    const blobB = makeDeterministicBytes(chunkSize * 2, 2); // 64 KiB
    const blobC = makeDeterministicBytes(chunkSize * 2, 3); // 64 KiB

    const server = await startRangeServer({
      'a.bin': blobA,
      'b.bin': blobB,
      'c.bin': blobC,
    });
    servers.push(server);

    const mA = await buildSignedTestManifest(
      [{ path: 'a.bin', data: blobA, chunkSizeBytes: chunkSize, urls: [`${server.origin}/a.bin`] }],
      'yours-research/Model-A',
    );
    const mB = await buildSignedTestManifest(
      [{ path: 'b.bin', data: blobB, chunkSizeBytes: chunkSize, urls: [`${server.origin}/b.bin`] }],
      'yours-research/Model-B',
    );
    const mC = await buildSignedTestManifest(
      [{ path: 'c.bin', data: blobC, chunkSizeBytes: chunkSize, urls: [`${server.origin}/c.bin`] }],
      'yours-research/Model-C',
    );

    // Total capacity allows 2 models (140 KiB), so installing Model-C requires evicting 1 old model.
    const vault = new MemoryVault({ quotaBytes: 140 * 1024 });
    const quota = new StorageQuotaManager(vault);

    const resA = await downloadVerifiedModel(mA.manifest, {
      vault,
      pinnedPublicKeys: [mA.publicKeyRaw],
      pinned: true,
    });
    const resB = await downloadVerifiedModel(mB.manifest, {
      vault,
      pinnedPublicKeys: [mB.publicKeyRaw],
      pinned: false,
    });

    // Make A older than B, yet A is pinned so B must be evicted instead!
    await quota.touchModel(resA.modelKey, 1_000);
    await quota.touchModel(resB.modelKey, 2_000);

    const resC = await downloadVerifiedModel(mC.manifest, {
      vault,
      pinnedPublicKeys: [mC.publicKeyRaw],
    });

    const installed = await quota.listModels();
    const keys = installed.map((m) => m.modelKey);
    expect(keys).toContain(resA.modelKey);
    expect(keys).toContain(resC.modelKey);
    expect(keys).not.toContain(resB.modelKey);
  });
});
