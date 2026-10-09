// Isolated-world bridge: popup <-> page.js (MAIN world) via window.postMessage
(function() {
  'use strict';
  const ext = globalThis.browser || globalThis.chrome;
  if (window.__alBridge) return;
  window.__alBridge = true;

  let reqId = 0;
  const pending = {};

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'ANIMELIB_API_RESPONSE' && pending[msg.requestId]) {
      pending[msg.requestId]({ data: msg.data, error: msg.error });
      delete pending[msg.requestId];
    }
  });

  ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ ok: true, page: !!window.__alPageReady });
      return;
    }
    if (msg.type === 'API_FETCH') {
      const requestId = ++reqId;
      const timer = setTimeout(() => {
        if (pending[requestId]) {
          delete pending[requestId];
          sendResponse({ error: 'Нет ответа от страницы. Обновите вкладку animelib.org (F5)' });
        }
      }, 15000);
      pending[requestId] = (result) => { clearTimeout(timer); sendResponse(result); };
      window.postMessage({ type: 'ANIMELIB_API_FETCH', requestId, path: msg.url }, '*');
      return true;
    }
  });
})();
