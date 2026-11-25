import type { ModelManifestV1, UnsignedModelManifestV1 } from '../contracts.js';

/**
 * Deterministically serializes any JSON-compatible value with lexicographically
 * sorted object keys (RFC 8785 / JCS style). Undefined object properties are
 * omitted to match `JSON.stringify` semantics.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  const kind = typeof value;
  if (kind === 'boolean' || kind === 'string') {
    return JSON.stringify(value);
  }
  if (kind === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Cannot canonicalize non-finite number: ${String(value)}`);
    }
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => (item === undefined ? 'null' : canonicalizeJson(item)));
    return `[${items.join(',')}]`;
  }
  if (kind === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const entries: string[] = [];
    for (const key of keys) {
      const prop = record[key];
      if (prop === undefined) {
        continue;
      }
      entries.push(`${JSON.stringify(key)}:${canonicalizeJson(prop)}`);
    }
    return `{${entries.join(',')}}`;
  }
  throw new TypeError(`Unsupported value type in canonical JSON: ${kind}`);
}

/**
 * Extracts the unsigned fields of a `ModelManifestV1` and produces its
 * deterministic canonical JSON payload string.
 */
export function buildCanonicalManifestPayload(
  manifest: UnsignedModelManifestV1 | ModelManifestV1,
): string {
  const unsigned: UnsignedModelManifestV1 = {
    schemaVersion: manifest.schemaVersion,
    modelId: manifest.modelId,
    version: manifest.version,
    architecture: manifest.architecture,
    quantization: manifest.quantization,
    totalBytes: manifest.totalBytes,
    merkleRoot: manifest.merkleRoot,
    artifacts: manifest.artifacts.map((artifact) => ({
      path: artifact.path,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      ...(artifact.chunkSizeBytes !== undefined
        ? { chunkSizeBytes: artifact.chunkSizeBytes }
        : {}),
      ...(artifact.chunkSha256 !== undefined
        ? { chunkSha256: [...artifact.chunkSha256] }
        : {}),
      urls: [...artifact.urls],
    })),
  };
  return canonicalizeJson(unsigned);
}

/**
 * Verifies that `manifest.canonicalPayload` matches the manifest's actual
 * unsigned fields, preventing envelope-tampering attacks where a valid
 * signature over an old `canonicalPayload` accompanies modified fields.
 */
export function verifyCanonicalPayloadMatchesManifest(
  manifest: ModelManifestV1,
): { ok: true } | { ok: false; expected: string; reason: string } {
  const expected = buildCanonicalManifestPayload(manifest);
  if (manifest.canonicalPayload !== expected) {
    return {
      ok: false,
      expected,
      reason: 'Manifest canonicalPayload does not match manifest fields.',
    };
  }
  return { ok: true };
}
