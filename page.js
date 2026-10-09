// MAIN world script: runs inside animelib.org page context.
// Makes API calls exactly like the site does and captures the auth token.
(function() {
  'use strict';
  if (window.__alPageReady) return;
  window.__alPageReady = true;

  const API_BASE = 'https://api.cdnlibs.org/api';
  const API_HOST = 'api.cdnlibs.org';
  let capturedAuth = null;

  function emitToken(token) {
    if (!token || !/^Bearer\s+/i.test(token)) return;
    capturedAuth = token;
  }

  // Capture Authorization header from the site's own fetch/XHR calls
  const origFetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes(API_HOST)) {
        let auth = '';
        const h = (init && init.headers) || (input && input.headers);
        if (h instanceof Headers) auth = h.get('Authorization') || '';
        else if (h && typeof h === 'object') auth = h['Authorization'] || h['authorization'] || '';
        if (auth) emitToken(auth);
      }
    } catch (e) {}
    return origFetch.apply(this, arguments);
  };

  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    try {
      if (String(name).toLowerCase() === 'authorization') emitToken(value);
    } catch (e) {}
    return origSetHeader.apply(this, arguments);
  };

  function findStoredToken() {
    for (const store of [localStorage, sessionStorage]) {
      try {
        for (let i = 0; i < store.length; i++) {
          const key = store.key(i);
          const val = store.getItem(key);
          if (!val) continue;
          if (val.startsWith('Bearer ') || val.startsWith('eyJ')) {
            return val.startsWith('Bearer ') ? val : 'Bearer ' + val;
          }
          // JSON blobs like {"token":{"access_token":"eyJ..."}}
          if (val.startsWith('{') && val.includes('eyJ')) {
            const m = val.match(/"(?:access_)?token"\s*:\s*"(eyJ[^"]+)"/);
            if (m) return 'Bearer ' + m[1];
          }
        }
      } catch (e) {}
    }
    return null;
  }

  function scan() {
    const t = findStoredToken();
    if (t) emitToken(t);
  }

  async function callApi(path) {
    const headers = { 'Accept': 'application/json', 'x-requested-with': 'XMLHttpRequest' };
    const auth = capturedAuth || findStoredToken();
    if (auth) headers['Authorization'] = auth;

    const bases = [API_BASE, API_BASE.replace(/\/api$/, '')];
    let lastErr = null;
    for (const base of bases) {
      const res = await origFetch.call(window, base + path, { headers, credentials: 'include' });
      if (res.ok) return res.json();
      const text = (await res.text()).substring(0, 200);
      lastErr = new Error('HTTP ' + res.status + ': ' + text);
      if (res.status !== 404) break;
    }
    throw lastErr;
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.type !== 'ANIMELIB_API_FETCH') return;
    try {
      const data = await callApi(msg.path);
      window.postMessage({ type: 'ANIMELIB_API_RESPONSE', requestId: msg.requestId, data }, '*');
    } catch (err) {
      window.postMessage({ type: 'ANIMELIB_API_RESPONSE', requestId: msg.requestId, error: err.message }, '*');
    }
  });

  scan();
  let n = 0;
  const iv = setInterval(() => { scan(); if (++n > 30) clearInterval(iv); }, 2000);
})();
