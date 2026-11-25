import { describe, expect, it } from 'vitest';
import {
  buildCanonicalManifestPayload,
  canonicalizeJson,
  computeManifestMerkleRoot,
  computeMerkleProof,
  computeMerkleRoot,
  exportEd25519PublicKeyBase64,
  exportEd25519PublicKeyRaw,
  generateEd25519KeyPair,
  RedirectCache,
  sha256Hex,
  signManifest,
  StreamingSha256,
  verifyEd25519Signature,
  verifyMerkleProof,
  verifySignedManifest,
  verifyStreamSha256,
  type ModelArtifactEntry,
  type ModelManifestV1,
} from '../src/index.js';

describe('Canonical JSON & Ed25519 Signed Manifests', () => {
  it('canonicalizes objects deterministically regardless of key insertion order', () => {
    const a = { z: 1, a: { d: 'hello', b: [true, null, 42] }, m: undefined };
    const b = { a: { b: [true, null, 42], d: 'hello' }, z: 1 };
    expect(canonicalizeJson(a)).toBe(canonicalizeJson(b));
    expect(canonicalizeJson(a)).toBe('{"a":{"b":[true,null,42],"d":"hello"},"z":1}');
    expect(canonicalizeJson(-0)).toBe('0');
  });

  it('signs and verifies a ModelManifestV1 with real WebCrypto Ed25519 keys', async () => {
    const kp = await generateEd25519KeyPair();
    const pubRaw = await exportEd25519PublicKeyRaw(kp.publicKey);
    const pubB64 = await exportEd25519PublicKeyBase64(kp.publicKey);
    expect(pubRaw.byteLength).toBe(32);

    const chunk0 = new Uint8Array(64).fill(0x11);
    const chunk1 = new Uint8Array(32).fill(0x22);
    const full = new Uint8Array([...chunk0, ...chunk1]);

    const artifact: ModelArtifactEntry = {
      path: 'slab0.part00.bin',
      sizeBytes: full.byteLength,
      sha256: await sha256Hex(full),
      chunkSizeBytes: 64,
      chunkSha256: [await sha256Hex(chunk0), await sha256Hex(chunk1)],
      urls: ['https://cdn.yours.sh/pragma/slab0.part00.bin'],
    };

    const manifest = await signManifest(
      {
        schemaVersion: 1,
        modelId: 'yours-research/Pragma-1-4B-WGSL',
        version: '1.0.0',
        architecture: 'qwen35-deltanet',
        quantization: 'q4f16',
        totalBytes: full.byteLength,
        merkleRoot: '',
        artifacts: [artifact],
      },
      kp.privateKey,
    );

    const resRaw = await verifySignedManifest(manifest, {
      pinnedPublicKeys: [pubRaw],
      expectedModelId: 'yours-research/Pragma-1-4B-WGSL',
    });
    expect(resRaw.valid).toBe(true);
    expect(resRaw.matchedKeyIndex).toBe(0);

    const resB64 = await verifySignedManifest(manifest, {
      pinnedPublicKeys: [pubB64],
    });
    expect(resB64.valid).toBe(true);
  });

  it('rejects tampered manifest fields, envelope tampering, wrong keys, and path traversal', async () => {
    const kp1 = await generateEd25519KeyPair();
    const kp2 = await generateEd25519KeyPair();
    const pub1 = await exportEd25519PublicKeyRaw(kp1.publicKey);
    const pub2 = await exportEd25519PublicKeyRaw(kp2.publicKey);

    const payload = new Uint8Array(128).fill(0xab);
    const signed = await signManifest(
      {
        schemaVersion: 1,
        modelId: 'yours-research/Pragma-1-2B-WGSL',
        version: '1.0.0',
        architecture: 'qwen35-deltanet',
        quantization: 'q4f16',
        totalBytes: payload.byteLength,
        merkleRoot: '',
        artifacts: [
          {
            path: 'slab0.bin',
            sizeBytes: payload.byteLength,
            sha256: await sha256Hex(payload),
            urls: ['https://cdn.yours.sh/slab0.bin'],
          },
        ],
      },
      kp1.privateKey,
    );

    // Wrong pinned key
    const wrongKey = await verifySignedManifest(signed, { pinnedPublicKeys: [pub2] });
    expect(wrongKey.valid).toBe(false);

    // Envelope tampering: keep old valid canonicalPayload + signatureBase64, mutate artifact URL
    const tamperedUrl: ModelManifestV1 = {
      ...signed,
      artifacts: [
        {
          ...signed.artifacts[0]!,
          urls: ['https://evil.example/slab0.bin'],
        },
      ],
    };
    const envelopeRes = await verifySignedManifest(tamperedUrl, { pinnedPublicKeys: [pub1] });
    expect(envelopeRes.valid).toBe(false);
    expect(envelopeRes.reason).toContain('canonicalPayload');

    // Recompute canonicalPayload without re-signing -> signature fails
    const resignedPayloadOnly: ModelManifestV1 = {
      ...tamperedUrl,
      canonicalPayload: buildCanonicalManifestPayload(tamperedUrl),
    };
    const sigRes = await verifySignedManifest(resignedPayloadOnly, { pinnedPublicKeys: [pub1] });
    expect(sigRes.valid).toBe(false);
    expect(sigRes.reason).toContain('Ed25519');

    // Tampered signature byte
    const badSig: ModelManifestV1 = {
      ...signed,
      signatureBase64: 'A'.repeat(86) + '==',
    };
    expect(await verifyEd25519Signature(signed.canonicalPayload, badSig.signatureBase64, pub1)).toBe(false);

    // Path traversal attempt even if signed by a compromised build
    const unsafeManifest = await signManifest(
      {
        schemaVersion: 1,
        modelId: 'yours-research/Pragma-1-2B-WGSL',
        version: '1.0.0',
        architecture: 'qwen35-deltanet',
        quantization: 'q4f16',
        totalBytes: payload.byteLength,
        merkleRoot: '',
        artifacts: [
          {
            path: '../escape.bin',
            sizeBytes: payload.byteLength,
            sha256: await sha256Hex(payload),
            urls: ['https://cdn.yours.sh/slab0.bin'],
          },
        ],
      },
      kp1.privateKey,
    );
    const pathRes = await verifySignedManifest(unsafeManifest, { pinnedPublicKeys: [pub1] });
    expect(pathRes.valid).toBe(false);
    expect(pathRes.reason).toContain('Unsafe artifact path');
  });

  it('computes SHA-256 Merkle roots, inclusion proofs, and StreamingSha256 accurately', async () => {
    const chunks = [
      new Uint8Array([1, 2, 3, 4]),
      new Uint8Array([5, 6, 7, 8, 9]),
      new Uint8Array(1024).map((_, i) => i & 0xff),
    ];
    const leafHexes = await Promise.all(chunks.map((c) => sha256Hex(c)));
    const root = await computeMerkleRoot(leafHexes);

    for (let i = 0; i < leafHexes.length; i++) {
      const proof = await computeMerkleProof(leafHexes, i);
      expect(await verifyMerkleProof(leafHexes[i]!, proof, root)).toBe(true);
      expect(await verifyMerkleProof('0'.repeat(64), proof, root)).toBe(false);
    }

    const artifact: ModelArtifactEntry = {
      path: 'weights.bin',
      sizeBytes: 1033,
      sha256: await sha256Hex(new Uint8Array([...chunks[0]!, ...chunks[1]!, ...chunks[2]!])),
      chunkSizeBytes: 512,
      chunkSha256: leafHexes,
      urls: ['https://cdn.yours.sh/weights.bin'],
    };
    expect(await computeManifestMerkleRoot([artifact])).toBe(root);

    // StreamingSha256 matches WebCrypto across uneven block boundaries
    const combined = new Uint8Array(5000).map((_, i) => (i * 17 + 3) & 0xff);
    const expected = await sha256Hex(combined);
    const hasher = new StreamingSha256();
    hasher.update(combined.subarray(0, 17));
    hasher.update(combined.subarray(17, 130));
    hasher.update(combined.subarray(130, 2049));
    hasher.update(combined.subarray(2049));
    expect(hasher.digestHex()).toBe(expected);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(combined.subarray(0, 1000));
        controller.enqueue(combined.subarray(1000, 3500));
        controller.enqueue(combined.subarray(3500));
        controller.close();
      },
    });
    const streamRes = await verifyStreamSha256(stream, expected, combined.byteLength);
    expect(streamRes.ok).toBe(true);
    expect(streamRes.actualBytes).toBe(combined.byteLength);
  });

  it('caches pre-resolved CDN redirects within TTL and enforces allowedHosts', async () => {
    let now = 1_700_000_000_000;
    let resolveCalls = 0;
    const mockFetch = (async (input: string | URL | Request) => {
      resolveCalls += 1;
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      expect(url).toContain('huggingface.co');
      return {
        ok: true,
        status: 200,
        url: 'https://us.aws.cdn.hf.co/xet/signed-blob?Expires=1700003600',
        body: null,
      } as unknown as Response;
    }) as typeof fetch;

    const cache = new RedirectCache({
      fetchImpl: mockFetch,
      allowedHosts: ['huggingface.co', '*.cdn.hf.co'],
      nowMs: () => now,
    });

    const source = 'https://huggingface.co/yours-research/Pragma-1-4B-WGSL/resolve/main/slab0.bin';
    const r1 = await cache.resolve(source);
    const r2 = await cache.resolve(source);
    expect(r1).toBe('https://us.aws.cdn.hf.co/xet/signed-blob?Expires=1700003600');
    expect(r2).toBe(r1);
    expect(resolveCalls).toBe(1);
    expect(cache.getStats().hits).toBe(1);

    // Advance past signed Expires minus safety margin -> re-resolves
    now = 1_700_003_600_000;
    await cache.resolve(source);
    expect(resolveCalls).toBe(2);

    // Reject unallowed host
    await expect(cache.resolve('https://untrusted.example/model.bin')).rejects.toThrow(
      'not allowlisted',
    );
  });
});
