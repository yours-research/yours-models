import type { ModelArtifactEntry } from '../contracts.js';

const HEX_SHA256_RE = /^[0-9a-f]{64}$/;
const textEncoder = new TextEncoder();

export function toBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.buffer instanceof ArrayBuffer) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim().toLowerCase();
  if (normalized.length % 2 !== 0 || !/^[0-9a-f]*$/.test(normalized)) {
    throw new Error(`Invalid hex string of length ${hex.length}`);
  }
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function isValidSha256Hex(hex: string): boolean {
  return HEX_SHA256_RE.test(hex.toLowerCase());
}

/**
 * Computes raw SHA-256 bytes using WebCrypto (`crypto.subtle.digest`).
 */
export async function sha256Bytes(
  input: Uint8Array | ArrayBuffer | string,
): Promise<Uint8Array> {
  const bytes =
    typeof input === 'string'
      ? textEncoder.encode(input)
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : input;
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    toBufferSource(bytes),
  );
  return new Uint8Array(digest);
}

/**
 * Computes lowercase hex SHA-256 digest using WebCrypto (`crypto.subtle.digest`).
 */
export async function sha256Hex(
  input: Uint8Array | ArrayBuffer | string,
): Promise<string> {
  return bytesToHex(await sha256Bytes(input));
}

/**
 * Verifies a single chunk/buffer against an expected hex SHA-256 digest using
 * native WebCrypto.
 */
export async function verifyChunkSha256(
  data: Uint8Array,
  expectedSha256Hex: string,
): Promise<{ ok: boolean; actualSha256: string }> {
  const actualSha256 = await sha256Hex(data);
  return {
    ok: actualSha256 === expectedSha256Hex.toLowerCase(),
    actualSha256,
  };
}

// FIPS 180-4 SHA-256 constants for streaming incremental verification without
// buffering multi-hundred-MiB artifacts in JS memory.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Pure TypeScript streaming FIPS 180-4 SHA-256 hasher for incremental
 * `ReadableStream` verification when an artifact is larger than RAM budget.
 */
export class StreamingSha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly buffer = new Uint8Array(64);
  private readonly work = new Uint32Array(64);
  private bufferLen = 0;
  private totalBytes = 0;
  private finalized = false;

  update(chunk: Uint8Array): this {
    if (this.finalized) {
      throw new Error('Cannot update StreamingSha256 after digest() was called.');
    }
    let offset = 0;
    this.totalBytes += chunk.byteLength;

    if (this.bufferLen > 0) {
      const needed = 64 - this.bufferLen;
      if (chunk.byteLength < needed) {
        this.buffer.set(chunk, this.bufferLen);
        this.bufferLen += chunk.byteLength;
        return this;
      }
      this.buffer.set(chunk.subarray(0, needed), this.bufferLen);
      this.compressBlock(this.buffer, 0);
      this.bufferLen = 0;
      offset = needed;
    }

    while (offset + 64 <= chunk.byteLength) {
      this.compressBlock(chunk, offset);
      offset += 64;
    }

    if (offset < chunk.byteLength) {
      this.buffer.set(chunk.subarray(offset), 0);
      this.bufferLen = chunk.byteLength - offset;
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.finalized) {
      throw new Error('StreamingSha256.digest() can only be called once.');
    }
    this.finalized = true;

    const totalBits = this.totalBytes * 8;
    const padLen = this.bufferLen < 56 ? 56 - this.bufferLen : 120 - this.bufferLen;
    const tail = new Uint8Array(padLen + 8);
    tail[0] = 0x80;

    const highBits = Math.floor(totalBits / 0x100000000);
    const lowBits = totalBits >>> 0;
    const view = new DataView(tail.buffer);
    view.setUint32(padLen, highBits, false);
    view.setUint32(padLen + 4, lowBits, false);

    // Feed final padded blocks directly without touching totalBytes.
    this.buffer.set(tail.subarray(0, Math.min(tail.length, 64 - this.bufferLen)), this.bufferLen);
    let tailOffset = 64 - this.bufferLen;
    this.compressBlock(this.buffer, 0);
    while (tailOffset < tail.length) {
      this.compressBlock(tail, tailOffset);
      tailOffset += 64;
    }

    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) {
      outView.setUint32(i * 4, this.state[i]!, false);
    }
    return out;
  }

  digestHex(): string {
    return bytesToHex(this.digest());
  }

  private compressBlock(data: Uint8Array, offset: number): void {
    const w = this.work;
    for (let i = 0; i < 16; i++) {
      const idx = offset + i * 4;
      w[i] =
        ((data[idx]! << 24) |
          (data[idx + 1]! << 16) |
          (data[idx + 2]! << 8) |
          data[idx + 3]!) >>>
        0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = this.state[0]!;
    let b = this.state[1]!;
    let c = this.state[2]!;
    let d = this.state[3]!;
    let e = this.state[4]!;
    let f = this.state[5]!;
    let g = this.state[6]!;
    let h = this.state[7]!;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.state[0] = (this.state[0]! + a) >>> 0;
    this.state[1] = (this.state[1]! + b) >>> 0;
    this.state[2] = (this.state[2]! + c) >>> 0;
    this.state[3] = (this.state[3]! + d) >>> 0;
    this.state[4] = (this.state[4]! + e) >>> 0;
    this.state[5] = (this.state[5]! + f) >>> 0;
    this.state[6] = (this.state[6]! + g) >>> 0;
    this.state[7] = (this.state[7]! + h) >>> 0;
  }
}

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * Streams a `ReadableStream<Uint8Array>` through `StreamingSha256`, verifying
 * optional byte count and expected lowercase hex SHA-256 digest.
 */
export async function verifyStreamSha256(
  stream: ReadableStream<Uint8Array>,
  expectedSha256Hex: string,
  expectedBytes?: number,
): Promise<{ ok: boolean; actualSha256: string; actualBytes: number }> {
  const hasher = new StreamingSha256();
  const reader = stream.getReader();
  let actualBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value && value.byteLength > 0) {
        hasher.update(value);
        actualBytes += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const actualSha256 = hasher.digestHex();
  const bytesOk = expectedBytes === undefined || actualBytes === expectedBytes;
  return {
    ok: bytesOk && actualSha256 === expectedSha256Hex.toLowerCase(),
    actualSha256,
    actualBytes,
  };
}

export interface MerkleProofNode {
  position: 'left' | 'right';
  hash: string;
}

async function hashLeaf(leafHex: string): Promise<Uint8Array> {
  const leafBytes = hexToBytes(leafHex);
  const prefixed = new Uint8Array(1 + leafBytes.length);
  prefixed[0] = 0x00;
  prefixed.set(leafBytes, 1);
  return sha256Bytes(prefixed);
}

async function hashNode(left: Uint8Array, right: Uint8Array): Promise<Uint8Array> {
  const prefixed = new Uint8Array(1 + left.length + right.length);
  prefixed[0] = 0x01;
  prefixed.set(left, 1);
  prefixed.set(right, 1 + left.length);
  return sha256Bytes(prefixed);
}

/**
 * Computes a domain-separated binary SHA-256 Merkle root over ordered hex leaf digests.
 * Leaf nodes hash `0x00 || leafBytes`; internal nodes hash `0x01 || left || right`.
 * An odd trailing node is promoted directly to the next level.
 */
export async function computeMerkleRoot(leafHashesHex: readonly string[]): Promise<string> {
  if (leafHashesHex.length === 0) {
    return sha256Hex(new Uint8Array(0));
  }
  let level = await Promise.all(leafHashesHex.map((hex) => hashLeaf(hex)));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      if (right) {
        next.push(await hashNode(left, right));
      } else {
        next.push(left);
      }
    }
    level = next;
  }
  return bytesToHex(level[0]!);
}

/**
 * Computes a Merkle inclusion proof for the leaf at `leafIndex`.
 */
export async function computeMerkleProof(
  leafHashesHex: readonly string[],
  leafIndex: number,
): Promise<MerkleProofNode[]> {
  if (leafIndex < 0 || leafIndex >= leafHashesHex.length) {
    throw new RangeError(`Leaf index ${leafIndex} out of bounds [0, ${leafHashesHex.length})`);
  }
  let level = await Promise.all(leafHashesHex.map((hex) => hashLeaf(hex)));
  let idx = leafIndex;
  const proof: MerkleProofNode[] = [];

  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1];
      if (right) {
        if (i === idx) {
          proof.push({ position: 'right', hash: bytesToHex(right) });
        } else if (i + 1 === idx) {
          proof.push({ position: 'left', hash: bytesToHex(left) });
        }
        next.push(await hashNode(left, right));
      } else {
        next.push(left);
      }
    }
    idx = Math.floor(idx / 2);
    level = next;
  }
  return proof;
}

/**
 * Verifies a Merkle inclusion proof against an expected hex root.
 */
export async function verifyMerkleProof(
  leafHex: string,
  proof: readonly MerkleProofNode[],
  expectedRootHex: string,
): Promise<boolean> {
  let current = await hashLeaf(leafHex);
  for (const step of proof) {
    const sibling = hexToBytes(step.hash);
    current =
      step.position === 'left'
        ? await hashNode(sibling, current)
        : await hashNode(current, sibling);
  }
  return bytesToHex(current) === expectedRootHex.toLowerCase();
}

/**
 * Extracts ordered leaf digests for `ModelManifestV1`: uses per-chunk
 * `chunkSha256` entries when present, otherwise falls back to the artifact's
 * whole-file `sha256`.
 */
export function collectManifestMerkleLeaves(
  artifacts: readonly ModelArtifactEntry[],
): string[] {
  const leaves: string[] = [];
  for (const artifact of artifacts) {
    if (artifact.chunkSha256 && artifact.chunkSha256.length > 0) {
      for (const chunkHash of artifact.chunkSha256) {
        leaves.push(chunkHash.toLowerCase());
      }
    } else {
      leaves.push(artifact.sha256.toLowerCase());
    }
  }
  return leaves;
}

/**
 * Computes the canonical `merkleRoot` for an ordered list of manifest artifacts.
 */
export async function computeManifestMerkleRoot(
  artifacts: readonly ModelArtifactEntry[],
): Promise<string> {
  return computeMerkleRoot(collectManifestMerkleLeaves(artifacts));
}
