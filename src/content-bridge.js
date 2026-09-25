(() => {
  if (window !== window.top || !/^https:$/.test(location.protocol)) return;
  const channelId = crypto.randomUUID();
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('page-provider.js');
  script.dataset.flippyChannel = channelId;

  const channel = new MessageChannel();
  const runtimePort = chrome.runtime.connect({ name: 'flippy-document' });
  const inflight = new Set();
  channel.port1.onmessage = ({ data }) => {
    if (!data || typeof data.id !== 'string' || typeof data.method !== 'string') return;
    inflight.add(data.id); runtimePort.postMessage(data);
  };
  runtimePort.onMessage.addListener(message => {
    if (message?.id) inflight.delete(message.id);
    channel.port1.postMessage(message);
  });
  runtimePort.onDisconnect.addListener(() => {
    channel.port1.postMessage({ type: 'revoke', reason: 'Flippy extension or native host disconnected' });
    channel.port1.close();
  });
  channel.port1.start();
  script.addEventListener('load', () => {
    window.postMessage({ type: 'flippy:init', channelId }, location.origin, [channel.port2]);
  }, { once: true });
  script.addEventListener('error', () => runtimePort.disconnect(), { once: true });
  const inject = () => {
    const root = document.documentElement || document.head;
    if (!root) return false;
    root.append(script); return true;
  };
  if (!inject()) new MutationObserver((_, observer) => { if (inject()) observer.disconnect(); }).observe(document, { childList: true });
  addEventListener('pagehide', () => runtimePort.disconnect(), { once: true });
})();
