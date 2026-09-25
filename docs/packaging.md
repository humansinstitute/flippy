# Browser packaging

All browsers use the same audited provider, content bridge, broker, and native
protocol. Manifests and native-host registration are platform adapters.

## Chrome

`bun run build:chrome` creates a Manifest V3 unpacked extension in
`dist/chrome`. Register `au.com.otherstuff.flippy` using a Chrome Native
Messaging manifest whose `allowed_origins` contains the installed extension
ID. The service worker keeps one native port while active and revokes state on
disconnect.

## Firefox

`bun run build:firefox` creates `dist/firefox` with a fixed Gecko extension ID
and background script. Its Native Messaging manifest uses `allowed_extensions`
instead of Chrome's `allowed_origins`.

## Safari

`bun run build:safari` creates `dist/safari/extension`, suitable as the input
to `xcrun safari-web-extension-converter`. See [safari.md](safari.md). Safari's
containing app must forward the same length-delimited native protocol to the
shared Rust transport core; it must not replace it with `URLSession` DNS or
proxy networking.
