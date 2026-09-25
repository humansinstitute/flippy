import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('platform/safari/manifest.json', 'utf8'));
const guide = await readFile('docs/safari.md', 'utf8');
const adapter = await readFile('platform/safari/native-adapter.js', 'utf8');
const handler = await readFile('platform/safari/FlippySafariWebExtensionHandler.swift', 'utf8');
test('Safari package preserves native transport boundary', () => {
  expect(manifest.permissions).toContain('nativeMessaging');
  expect(manifest.content_scripts[0].all_frames).toBe(false);
  expect(guide).toContain('safari-web-extension-converter');
  expect(guide).toContain('Do not route through `URLSession`');
  expect(manifest.background.scripts[0]).toBe('native-adapter.js');
  expect(adapter).toContain('sendNativeMessage');
  expect(handler).toContain('NSExtensionRequestHandling');
  expect(handler).toContain('flippy-native');
  expect(handler).not.toContain('URLSession');
});
