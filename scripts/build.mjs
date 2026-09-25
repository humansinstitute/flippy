import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const requested = process.argv[2];
const browsers = requested === 'all' ? ['chrome', 'firefox', 'safari'] : [requested];
if (!browsers.every(browser => ['chrome', 'firefox', 'safari'].includes(browser))) throw new Error('Usage: bun scripts/build.mjs <chrome|firefox|safari|all>');

const sharedFiles = ['page-provider.js', 'content-bridge.js', 'background.js', 'approval.html', 'approval.css', 'approval.js'];
for (const browser of browsers) {
  const destination = browser === 'safari' ? join('dist', 'safari', 'extension') : join('dist', browser);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const file of sharedFiles) await cp(join('src', file), join(destination, file));
  await cp(join('assets', 'icon.svg'), join(destination, 'icon.svg'));
  if (browser === 'safari') await cp(join('platform', 'safari', 'native-adapter.js'), join(destination, 'native-adapter.js'));
  const manifest = JSON.parse(await readFile(join('platform', browser, 'manifest.json'), 'utf8'));
  await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(destination, 'BUILD.json'), `${JSON.stringify({ browser, version: manifest.version, contract: 2, builtAt: new Date().toISOString() }, null, 2)}\n`);
  console.log(`Built ${browser}: ${destination}`);
}
