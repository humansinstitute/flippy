import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [browser, extensionId, binary] = process.argv.slice(2);
if (!['chrome', 'firefox'].includes(browser) || !extensionId || !binary) throw new Error('Usage: bun scripts/native-manifest.mjs <chrome|firefox> <extension-id> <absolute-binary>');
const manifest = {
  name: 'au.com.otherstuff.flippy',
  description: 'Flippy identity-pinned FIPS transport',
  path: resolve(binary),
  type: 'stdio',
  ...(browser === 'chrome' ? { allowed_origins: [`chrome-extension://${extensionId}/`] } : { allowed_extensions: [extensionId] }),
};
await mkdir('build/native-manifests', { recursive: true });
const target = `build/native-manifests/${browser}.json`;
await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(target);
console.log(browser === 'chrome'
  ? 'Install under Chrome NativeMessagingHosts for the target OS.'
  : 'Install under Mozilla NativeMessagingHosts for the target OS.');
