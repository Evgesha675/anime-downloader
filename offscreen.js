// Offscreen worker: downloads videos with fetch() (so the Referer rule applies),
// builds a Blob and hands it to the background script for saving to disk.

let running = false;
let cancelled = false;
let controller = null;
const ext = globalThis.browser || globalThis.chrome;

function send(data) {
  ext.runtime.sendMessage({ target: 'background', type: 'DL_PROGRESS', ...data }).catch(() => {});
}

ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.type === 'RUN_QUEUE') {
    if (running) { sendResponse({ error: 'Уже идёт загрузка' }); return; }
    runQueue(msg.jobs || []);
    sendResponse({ started: true });
    return;
  }
  if (msg.type === 'CANCEL') {
    cancelled = true;
    if (controller) controller.abort();
    sendResponse({ ok: true });
  }
});

async function runQueue(jobs) {
  running = true;
  cancelled = false;
  let ok = 0, fail = 0;
  const total = jobs.length;

  for (let i = 0; i < total && !cancelled; i++) {
    const job = jobs[i];
    try {
      controller = new AbortController();
      send({ state: 'downloading', i, total, label: job.label, received: 0, size: 0 });

      const res = await fetch(job.url, { credentials: 'omit', cache: 'no-store', signal: controller.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (/text\/html/i.test(res.headers.get('content-type') || '')) {
        throw new Error('сервер вернул HTML вместо видео');
      }

      const size = parseInt(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      let chunks = [];
      let received = 0;
      let last = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        const now = Date.now();
        if (now - last > 400) {
          last = now;
          send({ state: 'downloading', i, total, label: job.label, received, size });
        }
      }

      send({ state: 'saving', i, total, label: job.label });
      const blob = new Blob(chunks, { type: 'video/mp4' });
      chunks = null;
      const blobUrl = URL.createObjectURL(blob);

      const r = await ext.runtime.sendMessage({
        target: 'background', type: 'SAVE_BLOB', url: blobUrl, filename: job.filename
      });
      URL.revokeObjectURL(blobUrl);
      if (!r || r.error) throw new Error((r && r.error) || 'не удалось сохранить файл');

      ok++;
      send({ state: 'saved', i, total, label: job.label });
    } catch (e) {
      if (cancelled) break;
      fail++;
      send({ state: 'error', i, total, label: job.label, message: e.message });
    }
  }

  running = false;
  controller = null;
  send({ state: 'finished', ok, fail, total, cancelled });
}
