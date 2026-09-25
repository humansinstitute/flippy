import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('platform/chrome/manifest.json', 'utf8'));
const provider = await readFile('src/page-provider.js', 'utf8');
const broker = await readFile('src/background.js', 'utf8');

test('Chrome is MV3 and only injects into HTTPS top frames', () => {
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.permissions).toContain('nativeMessaging');
  expect(manifest.host_permissions).toEqual(['https://*/*']);
  expect(manifest.content_scripts[0].all_frames).toBe(false);
  expect(manifest.background.service_worker).toBe('background.js');
});

test('provider exposes frozen scoped handles and lifecycle operations', () => {
  expect(provider).toContain("Object.defineProperty(window, 'fipsTransport'");
  expect(provider).toContain('Object.freeze(handle)');
  expect(provider).toContain("rpc('request.pull'");
  expect(provider).toContain("rpc('request.cancel'");
  expect(provider).toContain("rpc('socket.open'");
  expect(provider).toContain('bufferedAmount + size > 4194304');
});

test('broker requires extension UI approval and native messaging', () => {
  expect(broker).toContain('requestApproval(document');
  expect(broker).toContain('chrome.windows.create');
  expect(broker).toContain('chrome.runtime.connectNative(NATIVE_HOST)');
  expect(broker).toContain("sender.frameId !== 0");
});
