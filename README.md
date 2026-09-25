# Flippy

> Flip seamlessly between the old and new internet with Flippy.

Flippy adds the identity-pinned `window.fipsTransport` v2 capability to normal
HTTPS pages in Chrome, Firefox, and Safari. It transports bytes to a peer that
you explicitly approve; the website still owns NIP-98, NIP-42, Tower,
Autopilot, Git, Drive, and application authorization.

This guide is for a local macOS source install. Chrome is the shortest route to
a working installation, followed by Firefox. Safari needs a locally signed
containing app and is not yet a one-command install.

## 1. Prerequisites

Install Git, [Bun](https://bun.sh/), and Rust with Cargo. The supported source
toolchain is Bun 1.3 or newer and Rust 1.91 or newer. Install the browser(s) you
want to test. Safari packaging also requires full Xcode (not only Command Line
Tools), an Apple Development signing identity, and an Apple Developer team.

The Tower-hosted Forgejo origin requires an authorized native Forgejo account.
On a Wingman-managed machine, use the shipped `git-credential-wingman` /
Autopilot credential setup before cloning. Never put an OAuth token or raw
Nostr key in the clone URL, shell history, or repository.

Check everything before cloning:

```sh
git --version
bun --version                 # must be 1.3 or newer
rustc --version               # must be 1.91 or newer
cargo --version
sw_vers

# These print the installed browser versions when present.
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --version
"/Applications/Firefox.app/Contents/MacOS/firefox" --version
defaults read /Applications/Safari.app/Contents/Info CFBundleShortVersionString

# Safari only:
xcodebuild -version
xcrun safari-web-extension-converter --help >/dev/null
security find-identity -v -p codesigning
```

Chrome must support Manifest V3 and Firefox must be 142 or newer (the fixed
minimum in Flippy's Firefox manifest). Use the Safari version shipped with your
current macOS/Xcode combination.

## 2. Clone, install, build, and validate

```sh
git clone https://tower-stable-forgejo.b.otherstuff.ai/rick/flippy.git
cd flippy
bun install --frozen-lockfile
bun run check
cargo build --release --locked --manifest-path native-host/Cargo.toml

# Resolve and verify the exact executable path used in browser manifests.
FLIPPY_ROOT="$(pwd -P)"
FLIPPY_HOST="$FLIPPY_ROOT/native-host/target/release/flippy-native"
test -x "$FLIPPY_HOST"
printf '%s\n' "$FLIPPY_HOST"
```

`bun run check` runs all JavaScript tests, Rust tests, and all three browser
builds. Generated packages are in ignored `dist/`; the native executable is in
ignored `native-host/target/`. Keep this terminal open so `FLIPPY_ROOT` and
`FLIPPY_HOST` remain defined for the registration commands below.

## 3. Chrome installation

### Load the unpacked extension and copy its ID

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the absolute directory printed by:

   ```sh
   printf '%s\n' "$FLIPPY_ROOT/dist/chrome"
   ```

4. Find the Flippy card and copy its **ID** (a 32-character lowercase string).
5. Set it in the same terminal, replacing the example value:

   ```sh
   CHROME_EXTENSION_ID='paste-the-id-from-chrome-here'
   printf '%s\n' "$CHROME_EXTENSION_ID" | grep -Eq '^[a-p]{32}$'
   ```

The unpacked ID is profile/machine specific. If Chrome assigns a different ID
later, regenerate and reinstall the native manifest.

### Generate and register the Chrome native host

```sh
bun scripts/native-manifest.mjs chrome "$CHROME_EXTENSION_ID" "$FLIPPY_HOST"

CHROME_NATIVE_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$CHROME_NATIVE_DIR"
cp "$FLIPPY_ROOT/build/native-manifests/chrome.json" \
  "$CHROME_NATIVE_DIR/au.com.otherstuff.flippy.json"

# Confirm the registered path and exact Chrome origin.
cat "$CHROME_NATIVE_DIR/au.com.otherstuff.flippy.json"
```

The exact registration file is:

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/au.com.otherstuff.flippy.json
```

Quit Chrome completely with **Chrome → Quit Google Chrome**, reopen it, return
to `chrome://extensions`, and click Flippy's **Reload** button once. A tab that
was already open must also be reloaded. Then use the verification recipe below.

## 4. Firefox installation

Flippy's fixed Gecko ID is `flippy@otherstuff.com.au`; do not substitute the
temporary add-on UUID shown elsewhere in Firefox.

### Generate and register the Firefox native host

```sh
bun scripts/native-manifest.mjs firefox 'flippy@otherstuff.com.au' "$FLIPPY_HOST"

FIREFOX_NATIVE_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
mkdir -p "$FIREFOX_NATIVE_DIR"
cp "$FLIPPY_ROOT/build/native-manifests/firefox.json" \
  "$FIREFOX_NATIVE_DIR/au.com.otherstuff.flippy.json"

cat "$FIREFOX_NATIVE_DIR/au.com.otherstuff.flippy.json"
```

The exact registration file is:

```text
~/Library/Application Support/Mozilla/NativeMessagingHosts/au.com.otherstuff.flippy.json
```

### Load it temporarily

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `$FLIPPY_ROOT/dist/firefox/manifest.json` (print the absolute path
   with `printf '%s\n' "$FLIPPY_ROOT/dist/firefox/manifest.json"`).
4. Quit Firefox completely and reopen it after native-host registration.
5. Temporary extensions disappear after a full Firefox restart, so repeat
   steps 1–3 after reopening. Use **Reload** on the Flippy entry after rebuilding.
6. Reload the HTTPS test tab and use the verification recipe below.

## 5. Safari installation (developer build)

Safari Web Extensions must live in a signed macOS containing app. Build the
release Rust host first as shown above, then generate the Xcode project:

```sh
bun run build:safari
xcrun safari-web-extension-converter "$FLIPPY_ROOT/dist/safari/extension" \
  --project-location "$FLIPPY_ROOT/build/safari" \
  --app-name flippy \
  --bundle-identifier au.com.otherstuff.flippy \
  --swift --macos-only --copy-resources --no-open --no-prompt
open "$FLIPPY_ROOT/build/safari/flippy/flippy.xcodeproj"
```

In Xcode:

1. Select both the containing-app target and the Safari Web Extension target.
   Under **Signing & Capabilities**, choose the same Apple Developer team and
   enable automatic signing (or supply matching development profiles).
2. Add one App Group capability to both targets and use the same identifier,
   such as `group.au.com.otherstuff.flippy`. App sandboxing and signing must be
   valid for both embedded products.
3. Add tracked
   `platform/safari/FlippySafariWebExtensionHandler.swift` to the generated
   **Safari Web Extension target**, replacing the converter's handler if it
   created one.
4. Add `$FLIPPY_HOST` to that extension target's **Copy Bundle Resources**
   phase. The built extension bundle must contain an executable named exactly
   `flippy-native` in its Resources directory.
5. The boundary is intentional: `native-adapter.js` calls Safari native
   messaging; the Swift extension handler frames messages and launches the
   embedded Rust host; only the Rust host performs direct identity-pinned FIPS
   networking. Do not replace it with `URLSession`, DNS, or a proxy.
6. Choose **My Mac**, build/run the containing app, then enable Flippy in
   **Safari → Settings → Extensions**. Grant website access for the HTTPS test
   page and reload the tab.

The embedded-process design must still be verified under the exact signing,
sandbox, and distribution entitlements you intend to ship. If the sandbox
denies child processes, the same Rust transport core needs to move behind a
signed App Group/XPC service or be linked into the handler. The source tree is
therefore **not yet a one-command signed Safari install**, and this repository
does not sign, notarize, or publish an app for you. See [Safari packaging](docs/safari.md).

## 6. Verify injection and a real FIPS peer

Flippy injects only into top-level HTTPS pages. Open an HTTPS page you control
(not a browser-internal page), open DevTools Console, and first prove injection:

```js
console.assert(window.fipsTransport?.available === true, 'Flippy was not injected');
console.assert(window.fipsTransport?.version >= 2, 'Unexpected transport version');
Object.isFrozen(window.fipsTransport);
```

Then replace both placeholders below with one real, reachable FIPS service.
The npub in `peerNpub` must exactly match the npub before `.fips`:

```js
const peerNpub = 'npub1replace_with_real_peer';
const endpoint = `http://${peerNpub}.fips:8787`;
const service = await window.fipsTransport.connect({
  endpoint,
  peerNpub,
  purpose: 'service',
});
// Check the approval popup's HTTPS origin, full npub, port, and purpose, then approve.
const response = await service.fetch(`${service.endpoint}/api/status`, {
  signal: AbortSignal.timeout(15_000),
});
console.log(response.status, await response.text());
await service.disconnect();
```

Successful output is a real HTTP status/body from that peer. Injection alone
does not prove native registration or FIPS reachability. Denying the popup
should reject `connect()` with `consent_denied`.

## Troubleshooting and diagnostics

- **`window.fipsTransport` is missing:** use a top-level `https://` page,
  enable/reload Flippy in the browser extension page, then reload the test tab.
  Browser-internal pages, HTTP pages, and subframes are intentionally excluded.
- **Native host not found / disconnected:** confirm the registration filename,
  JSON `name`, and absolute executable `path`; run `test -x "$FLIPPY_HOST"`;
  fully restart the browser. Chrome and Firefox use different registration
  directories.
- **Chrome wrong extension ID:** compare the ID on `chrome://extensions` with
  `allowed_origins` in the registered JSON. Regenerate with that exact ID; it
  must read `chrome-extension://ID/` including the trailing slash.
- **Approval denied:** retry `connect()`, leave the popup open, verify every
  displayed field, and click **Allow once**. Closing the popup is a denial.
- **FIPS peer unreachable:** verify the peer is online, the port is correct,
  IPv6/FIPS mesh routing is active, and no firewall blocks it. Flippy never
  falls back to DNS, a proxy, redirects, or public HTTPS.
- **Identity mismatch:** the endpoint hostname and `peerNpub` must be the same
  valid 32-byte Nostr npub. Copy both from the service owner; do not retarget
  one independently.

Useful local diagnostics (they do not install anything):

```sh
bun run check
cargo run --release --locked --manifest-path native-host/Cargo.toml </dev/null
RUST_BACKTRACE=1 "$FLIPPY_HOST" </dev/null

# Chrome extension/service-worker logs: chrome://extensions → Flippy → Service worker
# Firefox extension logs: about:debugging#/runtime/this-firefox → Flippy → Inspect
# macOS unified logs for either browser/native host:
log stream --style compact --predicate \
  'process == "flippy-native" OR process == "Google Chrome" OR process == "firefox"'
```

In Safari, use **Develop → Web Extension Background Content** and Xcode's run
console. Inspect the built extension's **Build Phases** and bundle Resources if
the Swift handler reports `flippy-native is missing`.

## Uninstall and cleanup

Disable/remove the unpacked or temporary extension in each browser first, then
remove only Flippy's user-level registration files:

```sh
rm -f "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/au.com.otherstuff.flippy.json"
rm -f "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts/au.com.otherstuff.flippy.json"
```

For Safari, disable Flippy in Safari Settings, delete the locally built
containing app through Finder, and remove its Xcode Derived Data through Xcode
Settings → Locations. To remove only reproducible checkout outputs:

```sh
cd "$FLIPPY_ROOT"
rm -rf dist build native-host/target
```

These cleanup commands do not remove the clone. Review each resolved path
before running it. Restart the affected browser after unregistering the host.

## Architecture and security

```text
HTTPS top-level page
  window.fipsTransport (page-provider.js)
        │ private request channel
isolated content bridge → extension background broker → Native Messaging
                                                     ↓
                                      flippy-native (direct FIPS mesh socket)
```

The native host is required. It derives the mesh IPv6 address from the peer
npub, connects directly without DNS or a proxy, rejects redirects, and pins
every request/WebSocket to the approved endpoint. Host loss fails closed.

See the [security model](docs/security.md), [browser packaging](docs/packaging.md),
and [release validation matrix](docs/validation.md). Flippy is MIT licensed;
see [LICENSE](LICENSE).
