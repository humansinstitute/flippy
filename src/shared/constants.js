export const PROVIDER_VERSION = 2;
export const NATIVE_HOST = 'au.com.otherstuff.flippy';
export const MAX_GRANTS = 8;
export const MAX_REQUESTS = 32;
export const MAX_CHUNK_BYTES = 64 * 1024;
export const MAX_WS_FRAME_BYTES = 1024 * 1024;
export const MAX_WS_QUEUE_BYTES = 4 * 1024 * 1024;
export const PURPOSES = Object.freeze(['service', 'tower', 'autopilot', 'git', 'drive']);

export function parseEndpoint(value) {
  if (typeof value !== 'string' || /[\\\u0000-\u0020\u007f]/.test(value)) throw new Error('Invalid endpoint');
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.port) {
    throw new Error('Use an exact FIPS HTTP origin with a port');
  }
  const match = /^((?:npub1)[023456789acdefghjklmnpqrstuvwxyz]+)\.fips$/i.exec(url.hostname);
  if (!match) throw new Error('Endpoint must contain one npub FIPS peer');
  return Object.freeze({ endpoint: url.origin, peerNpub: match[1].toLowerCase(), port: Number(url.port) });
}

export function validateConnect(options) {
  const parsed = parseEndpoint(options?.endpoint);
  if (options.peerNpub && options.peerNpub.toLowerCase() !== parsed.peerNpub) throw new Error('Pinned peer does not match endpoint');
  const purpose = options?.purpose || 'service';
  if (!PURPOSES.includes(purpose)) throw new Error('Unsupported transport purpose');
  return Object.freeze({ ...parsed, purpose });
}

export function assertGrantUrl(grant, value, websocket = false) {
  const url = new URL(value);
  const expected = new URL(grant.endpoint);
  const protocol = websocket ? 'ws:' : 'http:';
  if (url.protocol !== protocol || url.hostname !== expected.hostname || url.port !== expected.port || url.username || url.password || url.hash) {
    throw new DOMException('Request must target its approved FIPS service', 'SecurityError');
  }
  return url.href;
}
