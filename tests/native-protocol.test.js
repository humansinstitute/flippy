import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

const source = await readFile('native-host/src/main.rs', 'utf8');
test('native host independently enforces identity, ownership, and direct dialing', () => {
  expect(source).toContain('fn mesh_address');
  expect(source).toContain('TcpStream::connect(address)');
  expect(source).toContain('Unknown or foreign grant');
  expect(source).toContain('Redirects forbidden');
  expect(source).not.toContain('reqwest');
});
