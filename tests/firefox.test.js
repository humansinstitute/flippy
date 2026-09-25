import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('platform/firefox/manifest.json', 'utf8'));
test('Firefox reuses the audited WebExtensions core with a fixed identity', () => {
  expect(manifest.manifest_version).toBe(2);
  expect(manifest.permissions).toContain('nativeMessaging');
  expect(manifest.permissions).toContain('https://*/*');
  expect(manifest.browser_specific_settings.gecko.id).toBe('flippy@otherstuff.com.au');
  expect(manifest.browser_specific_settings.gecko.data_collection_permissions.required).toEqual(['none']);
  expect(manifest.content_scripts[0].all_frames).toBe(false);
});
