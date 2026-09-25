# Release validation

Automated checks cover provider shape, origin/grant isolation, approval,
streaming, cancellation, revocation, browser manifests, native framing,
endpoint parsing, mesh-address derivation, direct HTTP, and redirect rejection.

Release checks still requiring installed browsers and a reachable FIPS peer:

- Chrome: unpacked install, approval UI, service-worker suspension/reconnect,
  SSE, upload cancellation, WebSocket bounds, navigation revocation.
- Firefox: temporary and signed-package install, approval UI, background
  lifecycle, SSE/WebSocket parity.
- Safari: signed containing app, extension enablement, native handler, approval,
  navigation/relaunch revocation, SSE/WebSocket parity.
- All: reject wrong peer, missing native host, redirect, DNS/proxy fallback,
  subframe access, cross-origin navigation, and late replies.
