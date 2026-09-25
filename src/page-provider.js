(() => {
  if (window !== window.top || window.fipsTransport) return;
  const script = document.currentScript;
  const channelId = script?.dataset.flippyChannel;
  script?.remove();
  if (!channelId) return;

  let port;
  let sequence = 0;
  let revoked = false;
  const pending = new Map();
  const grants = new Map();
  const sockets = new Set();
  const streams = new Set();
  const capabilities = Object.freeze({ multiEndpoint: true, connect: true, fetch: true, WebSocket: true, workers: false, streaming: true });
  const bytesToBase64 = bytes => {
    let text = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(text);
  };
  const base64ToBytes = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));

  const revoke = reason => {
    if (revoked) return;
    revoked = true;
    for (const item of pending.values()) item.reject(new Error(reason || 'Flippy transport revoked'));
    pending.clear();
    for (const close of [...streams]) close();
    for (const socket of [...sockets]) socket._finish(1006, '', false);
    grants.clear();
  };

  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    if (revoked || !port) return reject(new Error('Flippy transport unavailable'));
    const id = String(++sequence);
    pending.set(id, { resolve, reject });
    port.postMessage({ id, method, params });
  });

  const onPortMessage = ({ data }) => {
    if (data?.type === 'revoke') return revoke(data.reason);
    const request = pending.get(data?.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(Object.assign(new Error(data.error.message || 'Flippy request failed'), { code: data.error.code }));
    else request.resolve(data.result);
  };

  const assertUrl = (grant, value, websocket = false) => {
    const url = new URL(value);
    const endpoint = new URL(grant.endpoint);
    if (url.protocol !== (websocket ? 'ws:' : 'http:') || url.hostname !== endpoint.hostname || url.port !== endpoint.port || url.username || url.password || url.hash) {
      throw new DOMException('Request must target its approved FIPS service', 'SecurityError');
    }
    return url.href;
  };

  const nativeFetch = async (grant, input, init = {}) => {
    const request = new Request(input, init);
    const url = assertUrl(grant, request.url);
    if (request.signal.aborted) throw request.signal.reason || new DOMException('Aborted', 'AbortError');
    let requestId;
    const abort = () => requestId && rpc('request.cancel', { requestId }).catch(() => {});
    request.signal.addEventListener('abort', abort, { once: true });
    try {
      requestId = await rpc('request.open', { grantId: grant.grantId, url, method: request.method, headers: Object.fromEntries(request.headers) });
      if (request.body) {
        const reader = request.body.getReader();
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            for (let offset = 0; offset < chunk.value.length; offset += 65536) {
              await rpc('request.write', { requestId, chunk: bytesToBase64(chunk.value.subarray(offset, offset + 65536)) });
            }
          }
        } finally { await reader.cancel().catch(() => {}); }
      }
      const metadata = await rpc('request.finish', { requestId });
      let controller;
      const close = () => {
        streams.delete(close);
        rpc('request.cancel', { requestId }).catch(() => {});
        controller?.error(new Error('Flippy transport revoked'));
      };
      streams.add(close);
      const empty = request.method === 'HEAD' || [204, 205, 304].includes(metadata.status);
      const body = empty ? null : new ReadableStream({
        start(value) { controller = value; },
        async pull(value) {
          try {
            let next;
            do { next = await rpc('request.pull', { requestId }); } while (next.idle);
            if (next.done) { streams.delete(close); value.close(); }
            else value.enqueue(base64ToBytes(next.chunk));
          } catch (error) { streams.delete(close); value.error(error); }
        },
        cancel() { streams.delete(close); return rpc('request.cancel', { requestId }).catch(() => {}); },
      }, { highWaterMark: 0 });
      return new Response(body, metadata);
    } catch (error) {
      if (requestId) await rpc('request.cancel', { requestId }).catch(() => {});
      if (request.signal.aborted) throw request.signal.reason || new DOMException('Aborted', 'AbortError');
      throw error;
    } finally { request.signal.removeEventListener('abort', abort); }
  };

  class FlippyWebSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3;
    readyState = 0; bufferedAmount = 0; protocol = ''; extensions = ''; binaryType = 'blob';
    onopen = null; onmessage = null; onerror = null; onclose = null; _requestId = null; _queue = Promise.resolve();
    constructor(grant, url, protocols = []) {
      super();
      this.url = assertUrl(grant, url, true);
      if ((typeof protocols === 'string' && protocols) || (Array.isArray(protocols) && protocols.length)) throw new DOMException('Subprotocols unsupported', 'NotSupportedError');
      sockets.add(this);
      rpc('socket.open', { grantId: grant.grantId, url: this.url }).then(async requestId => {
        this._requestId = requestId;
        if (this.readyState !== 0 || revoked) return rpc('socket.close', { requestId }).catch(() => {});
        this.readyState = 1; this._emit(new Event('open'));
        while (this.readyState === 1) {
          const next = await rpc('socket.next', { requestId });
          if (next.idle) continue;
          if (next.done) return this._finish(next.code || 1000, next.reason || '', next.code !== 1006);
          const bytes = next.text ? null : base64ToBytes(next.data);
          this._emit(new MessageEvent('message', { data: next.text ? next.data : this.binaryType === 'arraybuffer' ? bytes.buffer : new Blob([bytes]), origin: this.url }));
        }
      }).catch(() => { this._emit(new Event('error')); this._finish(1006, '', false); });
    }
    _emit(event) { this.dispatchEvent(event); try { this[`on${event.type}`]?.call(this, event); } catch (error) { queueMicrotask(() => { throw error; }); } }
    _finish(code, reason, wasClean) { if (this.readyState === 3) return; this.readyState = 3; sockets.delete(this); this._emit(new CloseEvent('close', { code, reason, wasClean })); }
    send(data) {
      if (this.readyState !== 1) throw new DOMException('Socket is not open', 'InvalidStateError');
      const text = typeof data === 'string';
      const snapshot = text ? data : data instanceof Blob ? data : new Uint8Array(data instanceof ArrayBuffer ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)).slice();
      const size = text ? new TextEncoder().encode(snapshot).length : snapshot.size ?? snapshot.byteLength;
      if (size > 1048576 || this.bufferedAmount + size > 4194304) throw new DOMException('Socket queue limit', 'QuotaExceededError');
      this.bufferedAmount += size;
      this._queue = this._queue.then(async () => {
        const value = text ? snapshot : bytesToBase64(snapshot instanceof Blob ? new Uint8Array(await snapshot.arrayBuffer()) : snapshot);
        await rpc('socket.send', { requestId: this._requestId, text, data: value });
      }).catch(() => { this._emit(new Event('error')); this._finish(1006, '', false); }).finally(() => { this.bufferedAmount -= size; });
    }
    close(code = 1000, reason = '') {
      if (code !== 1000 && (code < 3000 || code > 4999)) throw new DOMException('Invalid close code', 'InvalidAccessError');
      if (new TextEncoder().encode(reason).length > 123) throw new DOMException('Close reason too long', 'SyntaxError');
      if (this.readyState >= 2) return;
      this.readyState = 2;
      this._queue.finally(() => rpc('socket.close', { requestId: this._requestId, code, reason })).finally(() => this._finish(code, reason, true));
    }
  }

  const transport = Object.freeze({
    version: 2, available: true, capabilities,
    async connect(options) {
      const result = await rpc('grant.connect', options);
      const handle = {
        version: 2, grantId: result.grantId, endpoint: result.endpoint, peerNpub: result.peerNpub, purpose: result.purpose,
        fetch: (input, init) => nativeFetch(handle, input, init),
        WebSocket: class extends FlippyWebSocket { constructor(url, protocols = []) { super(handle, url, protocols); } },
        disconnect: () => transport.disconnect(handle),
      };
      Object.freeze(handle); grants.set(handle.grantId, handle); return handle;
    },
    async disconnect(handleOrId) {
      const grantId = typeof handleOrId === 'string' ? handleOrId : handleOrId?.grantId;
      if (grantId) { grants.delete(grantId); return rpc('grant.disconnect', { grantId }); }
      grants.clear(); return rpc('document.disconnect');
    },
    fetch(input, init) {
      const url = new URL(input instanceof Request ? input.url : input);
      const matches = [...grants.values()].filter(grant => url.href.startsWith(`${grant.endpoint}/`));
      if (matches.length !== 1) return Promise.reject(new Error('A unique approved FIPS grant is required'));
      return nativeFetch(matches[0], input, init);
    },
  });

  addEventListener('message', event => {
    if (event.source !== window || event.data?.type !== 'flippy:init' || event.data.channelId !== channelId || !event.ports[0] || port) return;
    port = event.ports[0]; port.onmessage = onPortMessage; port.start();
    Object.defineProperty(window, 'fipsTransport', { configurable: true, value: transport });
    dispatchEvent(new Event('flippy-fips-transport-ready'));
  });
})();
