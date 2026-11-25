import type { ModelManifestV1, UnsignedModelManifestV1 } from '../contracts.js';
import {
  buildCanonicalManifestPayload,
  verifyCanonicalPayloadMatchesManifest,
} from './canonical.js';
import {
  computeManifestMerkleRoot,
  hexToBytes,
  isValidSha256Hex,
  toBufferSource,
} from './merkle.js';

const textEncoder = new TextEncoder();

// ASN.1 SPKI prefix for raw 32-byte Ed25519 public keys (RFC 8410).
const ED25519_SPKI_PREFIX = new Uint8Array([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

export type Ed25519PublicKeyInput = CryptoKey | Uint8Array | string | JsonWebKey;
export type Ed25519PrivateKeyInput = CryptoKey | Uint8Array | string | JsonWebKey;

export interface VerifyManifestOptions {
  /** One or more pinned Ed25519 public keys trusted by the client/extension. */
  pinnedPublicKeys: readonly Ed25519PublicKeyInput[];
  /** Optional allowed modelId prefix/exact match check. */
  expectedModelId?: string;
  /** Optional minimum/exact version check. */
  expectedVersion?: string;
  /** Whether to verify `merkleRoot` matches `artifacts` (default: `true`). */
  verifyMerkleRoot?: boolean;
}

export interface ManifestVerificationResult {
  valid: boolean;
  reason?: string;
  matchedKeyIndex?: number;
  computedMerkleRoot?: string;
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof globalThis.btoa === 'function') {
    const chunk = 0x8000;
    let bin = '';
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + chunk)));
    }
    return globalThis.btoa(bin);
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    out += B64_ALPHABET[(triplet >> 18) & 63];
    out += B64_ALPHABET[(triplet >> 12) & 63];
    out += i + 1 < bytes.length ? B64_ALPHABET[(triplet >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64_ALPHABET[triplet & 63] : '=';
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.trim();
  if (typeof globalThis.atob === 'function') {
    const bin = globalThis.atob(normalized);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i);
    }
    return out;
  }
  const clean = normalized.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let ptr = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_ALPHABET.indexOf(clean[i]!);
    const c1 = B64_ALPHABET.indexOf(clean[i + 1]!);
    const c2 = i + 2 < clean.length ? B64_ALPHABET.indexOf(clean[i + 2]!) : 0;
    const c3 = i + 3 < clean.length ? B64_ALPHABET.indexOf(clean[i + 3]!) : 0;
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) {
      throw new Error('Invalid base64 character');
    }
    const triplet = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    out[ptr++] = (triplet >> 16) & 0xff;
    if (i + 2 < clean.length) out[ptr++] = (triplet >> 8) & 0xff;
    if (i + 3 < clean.length) out[ptr++] = triplet & 0xff;
  }
  return out.subarray(0, ptr);
}

function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof value === 'object' && value !== null && 'type' in value && 'algorithm' in value;
}

function decodePublicKeyString(input: string): Uint8Array {
  const trimmed = input.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return hexToBytes(trimmed);
  }
  return base64ToBytes(trimmed);
}

/**
 * Generates an extractable Ed25519 key pair using native WebCrypto (`crypto.subtle`).
 */
export async function generateEd25519KeyPair(
  extractable = true,
): Promise<CryptoKeyPair> {
  return (await globalThis.crypto.subtle.generateKey(
    { name: 'Ed25519' },
    extractable,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
}

/**
 * Imports an Ed25519 public key from a `CryptoKey`, raw 32-byte key, SPKI DER
 * bytes, hex/base64 string, or JWK.
 */
export async function importEd25519PublicKey(
  input: Ed25519PublicKeyInput,
): Promise<CryptoKey> {
  if (isCryptoKey(input)) {
    return input;
  }
  if (typeof input === 'object' && !(input instanceof Uint8Array)) {
    return globalThis.crypto.subtle.importKey(
      'jwk',
      input,
      { name: 'Ed25519' },
      true,
      ['verify'],
    );
  }
  const bytes = typeof input === 'string' ? decodePublicKeyString(input) : input;
  if (bytes.byteLength === 32) {
    return globalThis.crypto.subtle.importKey(
      'raw',
      toBufferSource(bytes),
      { name: 'Ed25519' },
      true,
      ['verify'],
    );
  }
  return globalThis.crypto.subtle.importKey(
    'spki',
    toBufferSource(bytes),
    { name: 'Ed25519' },
    true,
    ['verify'],
  );
}

/**
 * Imports an Ed25519 private key from a `CryptoKey`, PKCS8 DER bytes/base64, or JWK.
 */
export async function importEd25519PrivateKey(
  input: Ed25519PrivateKeyInput,
): Promise<CryptoKey> {
  if (isCryptoKey(input)) {
    return input;
  }
  if (typeof input === 'object' && !(input instanceof Uint8Array)) {
    return globalThis.crypto.subtle.importKey(
      'jwk',
      input,
      { name: 'Ed25519' },
      true,
      ['sign'],
    );
  }
  const bytes = typeof input === 'string' ? base64ToBytes(input) : input;
  return globalThis.crypto.subtle.importKey(
    'pkcs8',
    toBufferSource(bytes),
    { name: 'Ed25519' },
    true,
    ['sign'],
  );
}

/**
 * Exports an Ed25519 public key as raw 32 bytes (compatible with pinning in source).
 */
export async function exportEd25519PublicKeyRaw(
  publicKey: CryptoKey,
): Promise<Uint8Array> {
  try {
    const raw = await globalThis.crypto.subtle.exportKey('raw', publicKey);
    return new Uint8Array(raw);
  } catch {
    const spki = new Uint8Array(
      await globalThis.crypto.subtle.exportKey('spki', publicKey),
    );
    if (
      spki.byteLength === ED25519_SPKI_PREFIX.length + 32 &&
      ED25519_SPKI_PREFIX.every((b, idx) => spki[idx] === b)
    ) {
      return spki.slice(ED25519_SPKI_PREFIX.length);
    }
    throw new Error('Unexpected Ed25519 SPKI key format.');
  }
}

export async function exportEd25519PublicKeyBase64(
  publicKey: CryptoKey,
): Promise<string> {
  return bytesToBase64(await exportEd25519PublicKeyRaw(publicKey));
}

/**
 * Signs a canonical manifest payload string with an Ed25519 private key.
 */
export async function signCanonicalPayload(
  canonicalPayload: string,
  privateKey: Ed25519PrivateKeyInput,
): Promise<string> {
  const key = await importEd25519PrivateKey(privateKey);
  const bytes = textEncoder.encode(canonicalPayload);
  const sig = await globalThis.crypto.subtle.sign(
    { name: 'Ed25519' },
    key,
    toBufferSource(bytes),
  );
  return bytesToBase64(new Uint8Array(sig));
}

/**
 * Builds `canonicalPayload`, signs it with Ed25519, and returns a complete
 * `ModelManifestV1`. Computes `merkleRoot` automatically if passed empty.
 */
export async function signManifest(
  unsigned: UnsignedModelManifestV1,
  privateKey: Ed25519PrivateKeyInput,
): Promise<ModelManifestV1> {
  const merkleRoot =
    unsigned.merkleRoot || (await computeManifestMerkleRoot(unsigned.artifacts));
  const withMerkle: UnsignedModelManifestV1 = {
    ...unsigned,
    merkleRoot,
  };
  const canonicalPayload = buildCanonicalManifestPayload(withMerkle);
  const signatureBase64 = await signCanonicalPayload(canonicalPayload, privateKey);
  return {
    ...withMerkle,
    canonicalPayload,
    signatureBase64,
  };
}

/**
 * Verifies an Ed25519 signature over a payload string or byte buffer.
 */
export async function verifyEd25519Signature(
  payload: string | Uint8Array,
  signatureBase64: string,
  publicKey: Ed25519PublicKeyInput,
): Promise<boolean> {
  try {
    const key = await importEd25519PublicKey(publicKey);
    const sigBytes = base64ToBytes(signatureBase64);
    if (sigBytes.byteLength !== 64) {
      return false;
    }
    const dataBytes =
      typeof payload === 'string' ? textEncoder.encode(payload) : payload;
    return await globalThis.crypto.subtle.verify(
      { name: 'Ed25519' },
      key,
      toBufferSource(sigBytes),
      toBufferSource(dataBytes),
    );
  } catch {
    return false;
  }
}

export function isSafeArtifactPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.startsWith('\\') || path.includes('\0')) {
    return false;
  }
  if (/^[a-zA-Z]:/.test(path)) {
    return false;
  }
  const segments = path.split(/[/\\]+/);
  return segments.every((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
}

function validateManifestStructure(manifest: ModelManifestV1): string | null {
  if (!manifest || typeof manifest !== 'object') {
    return 'Manifest must be an object.';
  }
  if (manifest.schemaVersion !== 1) {
    return `Unsupported schemaVersion: ${String((manifest as { schemaVersion?: unknown }).schemaVersion)}`;
  }
  if (!manifest.modelId || typeof manifest.modelId !== 'string') {
    return 'Manifest modelId is required.';
  }
  if (!manifest.version || typeof manifest.version !== 'string') {
    return 'Manifest version is required.';
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    return 'Manifest must declare at least one artifact.';
  }
  if (!isValidSha256Hex(manifest.merkleRoot)) {
    return 'Manifest merkleRoot must be a 64-character hex SHA-256 digest.';
  }
  if (typeof manifest.canonicalPayload !== 'string' || !manifest.canonicalPayload) {
    return 'Manifest canonicalPayload is required.';
  }
  if (typeof manifest.signatureBase64 !== 'string' || !manifest.signatureBase64) {
    return 'Manifest signatureBase64 is required.';
  }

  let sumBytes = 0;
  const seenPaths = new Set<string>();
  for (const artifact of manifest.artifacts) {
    if (!isSafeArtifactPath(artifact.path)) {
      return `Unsafe artifact path: ${artifact.path}`;
    }
    if (seenPaths.has(artifact.path)) {
      return `Duplicate artifact path: ${artifact.path}`;
    }
    seenPaths.add(artifact.path);

    if (!Number.isInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) {
      return `Invalid sizeBytes for artifact ${artifact.path}`;
    }
    if (!isValidSha256Hex(artifact.sha256)) {
      return `Invalid sha256 for artifact ${artifact.path}`;
    }
    if (!Array.isArray(artifact.urls) || artifact.urls.length === 0) {
      return `Artifact ${artifact.path} has no download URLs.`;
    }
    if (artifact.chunkSha256 !== undefined) {
      if (!artifact.chunkSizeBytes || artifact.chunkSizeBytes <= 0) {
        return `Artifact ${artifact.path} specifies chunkSha256 without a positive chunkSizeBytes.`;
      }
      const expectedChunks = Math.max(1, Math.ceil(artifact.sizeBytes / artifact.chunkSizeBytes));
      if (artifact.chunkSha256.length !== expectedChunks) {
        return `Artifact ${artifact.path} chunkSha256 count (${artifact.chunkSha256.length}) does not match expected chunk count (${expectedChunks}).`;
      }
      for (const chunkHash of artifact.chunkSha256) {
        if (!isValidSha256Hex(chunkHash)) {
          return `Invalid chunkSha256 digest in artifact ${artifact.path}`;
        }
      }
    }
    sumBytes += artifact.sizeBytes;
  }

  if (sumBytes !== manifest.totalBytes) {
    return `Manifest totalBytes (${manifest.totalBytes}) does not match artifact byte sum (${sumBytes}).`;
  }

  return null;
}

/**
 * Full verification pipeline for `ModelManifestV1`:
 * 1. Structural & path-safety validation.
 * 2. Envelope binding (`canonicalPayload === buildCanonicalManifestPayload(manifest)`).
 * 3. WebCrypto Ed25519 signature verification against pinned public key(s).
 * 4. Merkle root verification over all artifact/chunk SHA-256 digests.
 */
export async function verifySignedManifest(
  manifest: ModelManifestV1,
  options: VerifyManifestOptions,
): Promise<ManifestVerificationResult> {
  const structuralError = validateManifestStructure(manifest);
  if (structuralError) {
    return { valid: false, reason: structuralError };
  }

  if (options.expectedModelId && manifest.modelId !== options.expectedModelId) {
    return {
      valid: false,
      reason: `Expected modelId ${options.expectedModelId}, got ${manifest.modelId}.`,
    };
  }
  if (options.expectedVersion && manifest.version !== options.expectedVersion) {
    return {
      valid: false,
      reason: `Expected version ${options.expectedVersion}, got ${manifest.version}.`,
    };
  }
  if (options.pinnedPublicKeys.length === 0) {
    return {
      valid: false,
      reason: 'At least one pinned Ed25519 public key is required.',
    };
  }

  const canonicalCheck = verifyCanonicalPayloadMatchesManifest(manifest);
  if (!canonicalCheck.ok) {
    return { valid: false, reason: canonicalCheck.reason };
  }

  let matchedKeyIndex = -1;
  for (let i = 0; i < options.pinnedPublicKeys.length; i++) {
    const ok = await verifyEd25519Signature(
      manifest.canonicalPayload,
      manifest.signatureBase64,
      options.pinnedPublicKeys[i]!,
    );
    if (ok) {
      matchedKeyIndex = i;
      break;
    }
  }
  if (matchedKeyIndex < 0) {
    return {
      valid: false,
      reason: 'Ed25519 signature verification failed against all pinned public keys.',
    };
  }

  let computedMerkleRoot: string | undefined;
  if (options.verifyMerkleRoot !== false) {
    computedMerkleRoot = await computeManifestMerkleRoot(manifest.artifacts);
    if (computedMerkleRoot !== manifest.merkleRoot.toLowerCase()) {
      return {
        valid: false,
        matchedKeyIndex,
        computedMerkleRoot,
        reason: `Merkle root mismatch: expected ${manifest.merkleRoot}, computed ${computedMerkleRoot}.`,
      };
    }
  }

  return {
    valid: true,
    matchedKeyIndex,
    computedMerkleRoot,
  };
}
