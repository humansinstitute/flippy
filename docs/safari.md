# Safari packaging

Safari Web Extensions run inside a containing macOS app. After
`bun run build:safari`, create or refresh the Xcode wrapper with:

```sh
xcrun safari-web-extension-converter dist/safari/extension \
  --project-location build/safari --app-name flippy --bundle-identifier au.com.otherstuff.flippy \
  --swift --macos-only --copy-resources --no-open --no-prompt
```

Keep the converter's `--app-name` lowercase: current Xcode tooling otherwise
capitalizes only the parent bundle identifier and rejects the embedded extension
as having a non-prefixed identifier. The installed product name can be changed
in Xcode without changing either bundle identifier.

The generated project is intentionally ignored because it contains local Xcode
state and signing choices. Add the tracked
`platform/safari/FlippySafariWebExtensionHandler.swift` to the generated Web
Extension target and embed the release `flippy-native` executable in the
Web Extension target's Resources. The handler maintains the framed native process and
preserves `native-host/PROTOCOL.md`. Do not route through `URLSession`: its DNS,
redirect, cookie, and proxy behavior violates the FIPS transport contract.

Before release, select a team, use an App Group for the containing app and
extension, confirm the extension is enabled in Safari, and run the physical
browser matrix in `docs/validation.md`.

Launching an embedded helper from a sandboxed Safari extension must be verified
under the intended signing and App Store entitlements. If that runtime denies
child processes, link the same Rust core into the extension handler or place it
behind an App Group/XPC service; do not substitute ambient Safari networking.
