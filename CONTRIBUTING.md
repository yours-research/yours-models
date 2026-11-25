# Contributing to `@yours/models`

Thank you for contributing to `@yours/models`!

## Workspace Setup

Requires **Node.js `>= 20.0.0`** (for native WebCrypto `Ed25519` and ESM support).

```bash
npm install
npm run typecheck
npm run build
npm test
```

## Engineering Standards

- **Zero runtime dependencies:** `src/` must rely solely on standard Web APIs (`crypto.subtle`, `fetch`, `ReadableStream`, OPFS, WebGPU) with no `node:*` imports so the bundle runs identically in Chrome MV3 Dedicated Workers, Offscreen Documents, browser pages, and Node `>= 20`.
- **Strict TypeScript:** All code must pass `npm run typecheck` (`strict: true`, `noUnusedLocals`, `noUnusedParameters`, `noUncheckedIndexedAccess`) and emit clean `.d.ts` + `.js` artifacts under `dist/` via `npm run build`.
- **Ecosystem Contract Alignment:** Any change to `ModelManifestV1`, `ModelArtifactEntry`, `HardwareProfile`, or `WgslComputeTier` must remain synchronized with [`docs/ECOSYSTEM_CONTRACTS.md`](./docs/ECOSYSTEM_CONTRACTS.md).
- **Tests:** Add Vitest coverage under `tests/` for every new feature or bug fix, using real WebCrypto keys and local HTTP Range servers where transport or storage behavior is involved.
- **License:** Contributions are licensed under the Apache-2.0 License (`LICENSE`).
