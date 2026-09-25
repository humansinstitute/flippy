# Flippy

> Flip seamlessly between the old and new internet with Flippy.

Flippy brings the identity-pinned `window.fipsTransport` v2 capability to
ordinary Chrome, Firefox, and Safari pages outside the Wingman Suite browser.
It deliberately separates transport consent from application authentication:
Flippy carries bytes to one approved FIPS peer; applications continue to own
NIP-98, NIP-42, Tower, Autopilot, Git, and Drive policy.

## Architecture

```text
HTTPS top-level page
  window.fipsTransport (page-provider.js)
        │ private request channel
isolated content bridge → extension background broker → Native Messaging
                                                     ↓
                                      flippy-native (direct FIPS mesh socket)
```

The native host is not an optional proxy. Browser networking cannot preserve
the canonical security boundary: derive the mesh IPv6 address from the peer
npub, dial it directly without DNS or a proxy, reject redirects, and pin every
request and WebSocket to the approved endpoint. If the host is missing or
disconnects, Flippy fails closed.

The provider supports frozen endpoint-scoped handles, streaming fetch bodies,
`AbortSignal`, bounded WebSockets, independent revocation, and document-wide
revocation. Up to eight grants may coexist per top-level document.

## Build and test

Requirements: Bun 1.3+, Rust 1.91+, and Xcode for Safari packaging.

```sh
bun install
bun run test:chrome
cargo test --manifest-path native-host/Cargo.toml
bun run build:chrome

bun run test:firefox
bun run build:firefox

bun run test:safari
bun run build:safari
```

Generated packages go under ignored `dist/`. `bun run check` validates all
shared code, the native host, and every browser package.

## Install for development

1. Build `flippy-native` with `cargo build --release --manifest-path native-host/Cargo.toml`.
2. Generate the browser-specific Native Messaging manifest with
   `bun scripts/native-manifest.mjs <chrome|firefox> <extension-id> <absolute-binary-path>`.
3. Install that manifest in the browser location printed by the script.
4. Load `dist/chrome` unpacked, `dist/firefox` temporarily, or use the Safari
   containing-app project described in [docs/safari.md](docs/safari.md).
5. Open an HTTPS application, call `window.fipsTransport.connect(...)`, and
   approve the exact origin, peer, and port in Flippy's approval window.

No store publication or live browser installation is performed by this repo.

## Example

```js
const transport = window.fipsTransport;
if (!transport?.available || transport.version < 2) throw new Error('Flippy unavailable');

const service = await transport.connect({
  endpoint: 'http://npub1example.fips:8787',
  peerNpub: 'npub1example',
  purpose: 'service',
});

const response = await service.fetch(`${service.endpoint}/api/status`, {
  signal: AbortSignal.timeout(15_000),
});
await service.disconnect();
```

See [the security model](docs/security.md) and [browser packaging](docs/packaging.md).
