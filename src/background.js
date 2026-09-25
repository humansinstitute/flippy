const NATIVE_HOST = 'au.com.otherstuff.flippy';
const PURPOSES = new Set(['service', 'tower', 'autopilot', 'git', 'drive']);
const documents = new Map();
const grants = new Map();
const pendingApprovals = new Map();
const nativePending = new Map();
let nativePort = null;
let nativeSequence = 0;

function errorMessage(error, code = 'flippy_error') {
  return { message: error instanceof Error ? error.message : String(error), code };
}

function parseEndpoint(value) {
  if (typeof value !== 'string' || /[\\\u0000-\u0020\u007f]/.test(value)) throw new Error('Invalid endpoint');
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.port) throw new Error('Use an exact FIPS HTTP origin with a port');
  const match = /^(npub1[023456789acdefghjklmnpqrstuvwxyz]+)\.fips$/i.exec(url.hostname);
  if (!match) throw new Error('Endpoint must contain one npub FIPS peer');
  return { endpoint: url.origin, peerNpub: match[1].toLowerCase(), port: Number(url.port) };
}

function ensureNativePort() {
  if (nativePort) return nativePort;
  nativePort = globalThis.flippyConnectNative ? globalThis.flippyConnectNative(NATIVE_HOST) : chrome.runtime.connectNative(NATIVE_HOST);
  nativePort.onMessage.addListener(message => {
    const pending = nativePending.get(message?.id);
    if (!pending) return;
    nativePending.delete(message.id);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
    else pending.resolve(message.result);
  });
  nativePort.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message || 'Native host disconnected';
    nativePort = null;
    for (const pending of nativePending.values()) pending.reject(new Error(reason));
    nativePending.clear();
    for (const document of documents.values()) document.port.postMessage({ type: 'revoke', reason });
    documents.clear(); grants.clear();
  });
  return nativePort;
}

function nativeCall(document, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = `${document.id}:${++nativeSequence}`;
    nativePending.set(id, { resolve, reject, documentId: document.id });
    try { ensureNativePort().postMessage({ id, method, context: { documentId: document.id, origin: document.origin }, params }); }
    catch (error) { nativePending.delete(id); reject(error); }
  });
}

function requestApproval(document, request) {
  const approvalId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const approval = { resolve, reject, documentId: document.id, request, windowId: null };
    pendingApprovals.set(approvalId, approval);
    const url = chrome.runtime.getURL(`approval.html?id=${encodeURIComponent(approvalId)}`);
    chrome.windows.create({ url, type: 'popup', width: 460, height: 560 }).then(window => {
      approval.windowId = window.id;
    }).catch(error => {
      pendingApprovals.delete(approvalId); reject(error);
    });
  });
}

async function dispatch(document, method, params) {
  if (method === 'grant.connect') {
    if (document.grants.size >= 8) throw new Error('Grant limit reached');
    const parsed = parseEndpoint(params?.endpoint);
    if (params?.peerNpub && params.peerNpub.toLowerCase() !== parsed.peerNpub) throw new Error('Pinned peer does not match endpoint');
    const purpose = params?.purpose || 'service';
    if (!PURPOSES.has(purpose)) throw new Error('Unsupported transport purpose');
    await requestApproval(document, { ...parsed, purpose });
    const result = await nativeCall(document, 'grant.connect', { ...parsed, purpose });
    document.grants.add(result.grantId);
    grants.set(result.grantId, document.id);
    return result;
  }
  if (method === 'grant.disconnect') {
    if (!document.grants.has(params?.grantId)) throw new Error('Unknown grant');
    const result = await nativeCall(document, method, params);
    document.grants.delete(params.grantId); grants.delete(params.grantId); return result;
  }
  if (method === 'document.disconnect') {
    const result = await nativeCall(document, method);
    for (const grantId of document.grants) grants.delete(grantId);
    document.grants.clear(); return result;
  }
  const grantId = params?.grantId;
  if (grantId && grants.get(grantId) !== document.id) throw new Error('Grant belongs to another document');
  return nativeCall(document, method, params);
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'flippy-document') return;
  const sender = port.sender;
  if (sender?.tab?.id == null || sender.frameId !== 0 || !sender.url?.startsWith('https://')) { port.disconnect(); return; }
  const id = sender.documentId || `${sender.tab.id}:${crypto.randomUUID()}`;
  const document = { id, tabId: sender.tab.id, origin: new URL(sender.url).origin, port, grants: new Set() };
  documents.set(id, document);
  port.onMessage.addListener(async message => {
    if (!message || typeof message.id !== 'string' || typeof message.method !== 'string') return;
    try { port.postMessage({ id: message.id, result: await dispatch(document, message.method, message.params || {}) }); }
    catch (error) { port.postMessage({ id: message.id, error: errorMessage(error) }); }
  });
  port.onDisconnect.addListener(() => {
    documents.delete(id);
    for (const [approvalId, approval] of pendingApprovals) if (approval.documentId === id) { approval.reject(new Error('Document closed')); pendingApprovals.delete(approvalId); }
    if (nativePort) nativeCall(document, 'document.disconnect').catch(() => {});
    for (const grantId of document.grants) grants.delete(grantId);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'approval.get') {
    const approval = pendingApprovals.get(message.id);
    sendResponse(approval ? { origin: documents.get(approval.documentId)?.origin, ...approval.request } : null);
    return;
  }
  if (message?.type === 'approval.decide') {
    const approval = pendingApprovals.get(message.id);
    pendingApprovals.delete(message.id);
    if (!approval) { sendResponse({ ok: false }); return; }
    if (message.approved) approval.resolve(); else approval.reject(Object.assign(new Error('Connection denied'), { code: 'consent_denied' }));
    sendResponse({ ok: true });
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  for (const document of documents.values()) if (document.tabId === tabId) document.port.disconnect();
});

chrome.windows.onRemoved.addListener(windowId => {
  for (const [approvalId, approval] of pendingApprovals) {
    if (approval.windowId !== windowId) continue;
    pendingApprovals.delete(approvalId);
    approval.reject(Object.assign(new Error('Connection denied'), { code: 'consent_denied' }));
  }
});
