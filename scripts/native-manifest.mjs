import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';

const [browser, extensionId, binary] = process.argv.slice(2);
if (!['chrome', 'firefox'].includes(browser) || !extensionId || !binary) throw new Error('Usage: bun scripts/native-manifest.mjs <chrome|firefox> <extension-id> <absolute-binary>');
if (browser === 'chrome' && !/^[a-p]{32}$/.test(extensionId)) throw new Error('Chrome extension ID must be 32 lowercase characters in the range a-p');
if (browser === 'firefox' && /\s/.test(extensionId)) throw new Error('Firefox extension ID must not contain whitespace');
if (!isAbsolute(binary)) throw new Error('The native-host binary path must be absolute');
await access(binary, constants.X_OK);
const manifest = {
  name: 'au.com.otherstuff.flippy',
  description: 'Flippy identity-pinned FIPS transport',
  path: binary,
  type: 'stdio',
  ...(browser === 'chrome' ? { allowed_origins: [`chrome-extension://${extensionId}/`] } : { allowed_extensions: [extensionId] }),
};
await mkdir('build/native-manifests', { recursive: true });
const target = `build/native-manifests/${browser}.json`;
await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(target);
const home = homedir();
console.log(browser === 'chrome'
  ? `${home}/Library/Application Support/Google/Chrome/NativeMessagingHosts/au.com.otherstuff.flippy.json`
  : `${home}/Library/Application Support/Mozilla/NativeMessagingHosts/au.com.otherstuff.flippy.json`);
