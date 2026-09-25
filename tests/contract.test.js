import { describe, expect, test } from 'bun:test';
import { assertGrantUrl, parseEndpoint, validateConnect } from '../src/shared/constants.js';

const NPUB = 'npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsdjr5p';

describe('window.fipsTransport v2 contract boundary', () => {
  test('accepts one exact identity-bearing origin', () => {
    expect(parseEndpoint(`http://${NPUB}.fips:8787`)).toEqual({ endpoint: `http://${NPUB}.fips:8787`, peerNpub: NPUB, port: 8787 });
  });
  test.each([
    `https://${NPUB}.fips:8787`, `http://${NPUB}.fips`, `http://${NPUB}.fips:8787/path`,
    `http://${NPUB}.fips:8787?x=1`, 'http://example.com:8787', `http://user@${NPUB}.fips:8787`,
  ])('rejects noncanonical endpoint %s', endpoint => expect(() => parseEndpoint(endpoint)).toThrow());
  test('pins supplied peer and purpose', () => {
    expect(validateConnect({ endpoint: `http://${NPUB}.fips:8787`, peerNpub: NPUB, purpose: 'tower' }).purpose).toBe('tower');
    expect(() => validateConnect({ endpoint: `http://${NPUB}.fips:8787`, peerNpub: 'npub1wrong' })).toThrow('Pinned peer');
    expect(() => validateConnect({ endpoint: `http://${NPUB}.fips:8787`, purpose: 'admin' })).toThrow('purpose');
  });
  test('does not allow a grant to be retargeted', () => {
    const grant = { endpoint: `http://${NPUB}.fips:8787` };
    expect(assertGrantUrl(grant, `${grant.endpoint}/api`)).toBe(`${grant.endpoint}/api`);
    expect(() => assertGrantUrl(grant, 'http://example.com:8787/api')).toThrow();
    expect(() => assertGrantUrl(grant, `http://${NPUB}.fips:9999/api`)).toThrow();
    expect(assertGrantUrl(grant, `ws://${NPUB}.fips:8787/relay`, true)).toBe(`ws://${NPUB}.fips:8787/relay`);
  });
});
