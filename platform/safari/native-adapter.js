// Safari Web Extensions expose one-shot native messages to the containing app.
// Adapt that API to the Port surface used by the shared broker without changing
// the transport protocol or keeping authority in JavaScript.
globalThis.flippyConnectNative = host => {
  const messageListeners = new Set();
  const disconnectListeners = new Set();
  let closed = false;
  const disconnect = error => {
    if (closed) return;
    closed = true;
    for (const listener of disconnectListeners) listener(error);
  };
  return {
    onMessage: { addListener(listener) { messageListeners.add(listener); } },
    onDisconnect: { addListener(listener) { disconnectListeners.add(listener); } },
    postMessage(message) {
      if (closed) throw new Error('Safari native transport disconnected');
      chrome.runtime.sendNativeMessage(host, message, response => {
        const error = chrome.runtime.lastError;
        if (error) return disconnect(error);
        for (const listener of messageListeners) listener(response);
      });
    },
    disconnect,
  };
};
