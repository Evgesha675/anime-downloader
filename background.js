// Background service worker: Referer rule and download orchestration
const ext = globalThis.browser || globalThis.chrome;

// Chrome's own download requests ignore our header rules, so videos are fetched
// by the offscreen document (fetch + declarativeNetRequest Referer) and saved as blobs.
async function setReferrerRule(referer) {
  const origin = referer.replace(/\/$/, '');
  try {
    await ext.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1],
      addRules: [{
        id: 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'Referer', operation: 'set', value: origin + '/' },
            { header: 'Origin', operation: 'set', value: origin }
          ]
        },
        condition: {
          requestDomains: ['cdnlibs.org'],
          resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest', 'media', 'other', 'object', 'ping']
        }
      }]
    });
    return { success: true };
  } catch (e) {
    console.error('DNR setup failed', e);
    return { error: e.message };
  }
}

ext.runtime.onInstalled.addListener(() => setReferrerRule('https://animelib.org'));
ext.runtime.onStartup.addListener(() => setReferrerRule('https://animelib.org'));

// ─── Offscreen document ──────────────────────────────────────────────
async function ensureOffscreen() {
  if (!ext.offscreen || !ext.runtime.getContexts) return false;
  const ctx = await ext.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length) return true;
  try {
    await ext.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Download video with required headers and save it as a blob'
    });
  } catch (e) {
    if (!/single offscreen|already exists/i.test(e.message)) throw e;
  }
  return true;
}

// ─── Download completion tracking ────────────────────────────────────
const pendingDl = new Map();

ext.downloads.onChanged.addListener(delta => {
  if (!delta.state) return;
  const cur = delta.state.current;
  if ((cur === 'complete' || cur === 'interrupted') && pendingDl.has(delta.id)) {
    const resolve = pendingDl.get(delta.id);
    pendingDl.delete(delta.id);
    resolve({ state: cur, error: delta.error && delta.error.current });
  }
});

function waitDownload(id) {
  return new Promise(resolve => {
    pendingDl.set(id, resolve);
    ext.downloads.search({ id }).then(([it]) => {
      if (it && (it.state === 'complete' || it.state === 'interrupted') && pendingDl.has(id)) {
        pendingDl.delete(id);
        resolve({ state: it.state, error: it.error });
      }
    });
  });
}

async function saveBlob(url, filename) {
  const id = await ext.downloads.download({
    url, filename, saveAs: false, conflictAction: 'uniquify'
  });
  const r = await waitDownload(id);
  return r.state === 'complete' ? { state: 'complete' } : { error: r.error || 'загрузка прервана' };
}

// Firefox does not implement chrome.offscreen. Its background script has a DOM,
// so the same queue can run here and save temporary Blob URLs directly.
let directRunning = false;
let directCancelled = false;
let directController = null;

async function publishProgress(data) {
  await ext.storage.session.set({ dl: data });
  try { await ext.runtime.sendMessage({ type: 'DL_PROGRESS', ...data }); } catch (e) {}
}

async function runDirectQueue(jobs) {
  directRunning = true;
  directCancelled = false;
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < jobs.length && !directCancelled; i++) {
    const job = jobs[i];
    try {
      directController = new AbortController();
      await publishProgress({ state: 'downloading', i, total: jobs.length, label: job.label, received: 0, size: 0 });
      const res = await fetch(job.url, { credentials: 'omit', cache: 'no-store', signal: directController.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (/text\/html/i.test(res.headers.get('content-type') || '')) throw new Error('сервер вернул HTML вместо видео');

      const size = parseInt(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let received = 0;
      let lastUpdate = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (Date.now() - lastUpdate > 400) {
          lastUpdate = Date.now();
          await publishProgress({ state: 'downloading', i, total: jobs.length, label: job.label, received, size });
        }
      }

      await publishProgress({ state: 'saving', i, total: jobs.length, label: job.label });
      const blobUrl = URL.createObjectURL(new Blob(chunks, { type: 'video/mp4' }));
      try {
        const result = await saveBlob(blobUrl, job.filename);
        if (result.error) throw new Error(result.error);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      ok++;
      await publishProgress({ state: 'saved', i, total: jobs.length, label: job.label });
    } catch (e) {
      if (directCancelled) break;
      fail++;
      await publishProgress({ state: 'error', i, total: jobs.length, label: job.label, message: e.message });
    }
  }

  directRunning = false;
  directController = null;
  await publishProgress({ state: 'finished', ok, fail, total: jobs.length, cancelled: directCancelled });
}

// ─── Messages ────────────────────────────────────────────────────────
ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  handleMessage(msg).then(sendResponse).catch(err => sendResponse({ error: err.message }));
  return true;
});

async function handleMessage(msg) {
  switch (msg.type) {
    case 'SET_REFERER':
      return setReferrerRule(msg.referer);

    case 'START_QUEUE': {
      const rule = await setReferrerRule(msg.referer);
      if (rule.error) return { error: 'Не удалось задать Referer: ' + rule.error };
      const hasOffscreen = await ensureOffscreen();
      await ext.storage.session.set({ dl: { state: 'downloading', i: 0, total: msg.jobs.length, label: '', received: 0, size: 0 } });
      if (hasOffscreen !== false) return ext.runtime.sendMessage({ target: 'offscreen', type: 'RUN_QUEUE', jobs: msg.jobs });
      if (directRunning) return { error: 'Уже идёт загрузка' };
      runDirectQueue(msg.jobs);
      return { started: true };
    }

    case 'CANCEL_QUEUE':
      if (ext.offscreen) {
        try { await ext.runtime.sendMessage({ target: 'offscreen', type: 'CANCEL' }); } catch (e) {}
      } else {
        directCancelled = true;
        if (directController) directController.abort();
      }
      await ext.storage.session.set({ dl: { state: 'finished', ok: 0, fail: 0, total: 0, cancelled: true } });
      return { ok: true };

    case 'GET_DL': {
      const s = await ext.storage.session.get('dl');
      return { dl: s.dl || null };
    }

    case 'SAVE_BLOB':
      return saveBlob(msg.url, msg.filename);

    case 'DL_PROGRESS': {
      const { target, ...rest } = msg;
      await ext.storage.session.set({ dl: rest });
      if (msg.state === 'finished') {
        if (ext.offscreen) {
          try { await ext.offscreen.closeDocument(); } catch (e) {}
        }
      }
      return { ok: true };
    }

    default:
      return { error: 'Unknown message: ' + msg.type };
  }
}
