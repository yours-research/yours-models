# `@yours/models` Architecture

`@yours/models` provides the verified model distribution, persistent OPFS storage, and WebGPU hardware-capability layer for `yours-browser-extension` and `yours.sh` web demos.

See [`docs/ECOSYSTEM_CONTRACTS.md`](./docs/ECOSYSTEM_CONTRACTS.md) for the cross-repository contracts (`ModelManifestV1`, `ModelArtifactEntry`, `HardwareProfile`, `WgslComputeTier`).

---

## Design Principles

1. **Zero Trust on Transport, Pinned Ed25519 Root of Trust:**
   - Clients embed only a pinned 32-byte Ed25519 public key.
   - `verifySignedManifest` enforces:
     1. Structural & path-safety validation (no absolute paths or `..` traversal).
     2. Envelope binding: `manifest.canonicalPayload === buildCanonicalManifestPayload(manifest)` so an attacker cannot reuse a valid `(canonicalPayload, signatureBase64)` pair while mutating outer fields such as `artifacts[].urls` or `merkleRoot`.
     3. Native WebCrypto `crypto.subtle.verify('Ed25519', ...)` signature check.
     4. Domain-separated SHA-256 Merkle tree verification (`0x00 || leaf` and `0x01 || left || right`) over every artifact/chunk hash.

2. **Bypass Single-Socket HTTP/2 Throttling:**
   - Chromium coalesces `fetch()` calls to a single HTTP/2 hostname onto one TCP socket, which throttles against certain edges (`~1.53 MiB/s` on Xet CAS vs `21.74–22.83 MiB/s` over multi-socket parallel `Range`).
   - `RedirectCache` pre-resolves Hub `302` redirects once per artifact (honoring CloudFront `Expires` / `X-Amz-Expires` headers and an optional MV3 host allowlist).
   - `OriginMirrorPool` distributes chunk Range requests across `artifact.urls[]` mirrors using round-robin + EWMA throughput/cooldown scoring so workers steer around throttled or failing origins.

3. **Worker-First OPFS Storage & Fast Verified Resume:**
   - `OpfsSyncVault` targets Dedicated Web Workers via `FileSystemFileHandle.createSyncAccessHandle()`, preallocating shards and writing chunks at exact positional byte offsets (`write(buf, { at })`) without `WritableStream` overhead.
   - `OpfsAsyncVault` provides a window/offscreen fallback using `createWritable({ keepExistingData: true })` with per-file write serialization so concurrent downloads never hit Chromium's single-writer lock error.
   - `MemoryVault` implements the identical `ModelVaultBackend` interface for unit tests and ephemeral web demos.
   - `resume.part.json` stores a compact base64 chunk bitmap. On restart, `WorkStealingModelDownloader` reads already-committed chunks from disk, verifies their SHA-256 digests (~`1.3–1.8 GiB/s`), skips valid chunks, and re-queues missing or corrupted ranges.

4. **Storage Quota & LRU/Pinned Eviction:**
   - `StorageQuotaManager` calls `navigator.storage.persist()`, inspects `navigator.storage.estimate()`, and evicts unpinned models in least-recently-used (`lastAccessedAt`) order when installing a new model requires headroom.

5. **WebGPU Hardware Probing & Dynamic Slab Sizing:**
   - `probeHardware` inspects `navigator.gpu.requestAdapter()`, requests elevated device limits via `computeElevatedLimits` (avoiding WebGPU's 128 MiB / 256 MiB defaults), selects a `WgslComputeTier` (`tier1-f16-subgroups`, `tier2-f16-shared`, `tier3-f32-universal`, or `cpu-only`), computes slab/chunk sizing hints, and selects the best compatible preset from `ModelRegistry`.
