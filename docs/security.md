# Security and threat model

## Authority

A grant binds one top-level HTTPS origin to one exact
`http://<32-byte-npub>.fips:<port>` endpoint and purpose. The npub encoded in
the hostname is the transport identity. A supplied `peerNpub` must match it.
Approval is per document request and is displayed by extension-owned UI.

The page provider, handles, capability metadata, and messages exposed to page
code are frozen. Opaque document, request, and grant identifiers are generated
outside the page. The isolated bridge accepts messages only from its own window
and its current document nonce. The background verifies the sender is a
top-level frame and keys all state to tab, frame, document, and origin.

## Fail-closed invariants

- No ambient `fetch`, DNS resolution, public HTTPS endpoint, CORS proxy,
  loopback listener, PAC/system proxy, redirect, or hostname retargeting.
- The native host derives `fd00::/8` mesh IPv6 from SHA-256 of the decoded
  x-only npub and connects directly to that address and approved port.
- Request URLs and WebSocket URLs must match the grant's scheme, host, and port.
- Cookies, `Host`, `Origin`, forwarding headers, and hop-by-hop headers are not
  accepted from the caller. Response cookies and redirect locations are hidden.
- Host loss, navigation, tab removal, extension suspension, or explicit
  disconnect closes affected requests and sockets. Late generation replies are
  ignored and cannot restore authority.
- Queue, frame, grant, request, and body limits are enforced on both sides.

## Deliberately out of scope

Flippy never signs, authenticates, stores Nostr keys, proves application
identity, or makes service authorization decisions. Those protocols remain in
the application above the pinned byte transport. Direct `.fips` WApp
navigation is also separate.

## Known packaging boundary

Chrome and Firefox Native Messaging hosts are installed separately from an
unpacked/store extension. Safari requires a signed containing macOS app and
App Extension. Store review, signing, notarization, and physical-browser smoke
tests are release operations and are intentionally not performed here.
