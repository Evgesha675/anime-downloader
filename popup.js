// AnimeLib Downloader - Popup
const $ = s => document.querySelector(s);

const modeAuto = $('#mode-auto');
const modeSearch = $('#mode-search');

const autoCard = $('#auto-anime-card');
const autoLoading = $('#auto-loading');
const autoContent = $('#auto-content');
const autoDub = $('#auto-dub');
const autoQuality = $('#auto-quality');
const autoEpsTotal = $('#auto-eps-total');
const autoEpsFrom = $('#auto-eps-from');
const autoEpsTo = $('#auto-eps-to');
const autoDlRange = $('#auto-dl-range');
const autoDlAll = $('#auto-dl-all');
const autoStatus = $('#auto-status');
const autoLive = $('#auto-live');
const autoCancel = $('#auto-cancel');
const autoProgress = $('#auto-progress');
const autoBar = $('#auto-bar');
const autoPct = $('#auto-pct');

const searchInput = $('#search-input');
const searchBtn = $('#search-btn');
const searchStatus = $('#search-status');
const searchResults = $('#search-results');

let state = resetState();
let tabId = null;

function resetState() {
  return { anime: null, episodes: [], details: [], dubs: [], dub: '', quality: 0, busy: false };
}

const ext = globalThis.browser || globalThis.chrome;
const bg = msg => ext.runtime.sendMessage(msg);

// ─── Tab / page communication ──────────────────────────────────────────
async function findAnimelibTab() {
  const isAL = u => /^https:\/\/([^/]+\.)?animelib\.org\//.test(u || '');
  const [active] = await ext.tabs.query({ active: true, currentWindow: true });
  if (active && isAL(active.url)) return active;
  const all = await ext.tabs.query({ url: ['*://animelib.org/*', '*://*.animelib.org/*'] });
  return all[0] || null;
}

async function ensureInjected(id) {
  try {
    const pong = await ext.tabs.sendMessage(id, { type: 'PING' });
    if (pong && pong.ok && pong.page) return;
  } catch (e) { /* not injected yet */ }
  await ext.scripting.executeScript({ target: { tabId: id }, files: ['content.js'] });
  await ext.scripting.executeScript({ target: { tabId: id }, files: ['page.js'], world: 'MAIN' });
  await sleep(150);
}

async function api(path) {
  if (tabId == null) throw new Error('Откройте вкладку animelib.org');
  await ensureInjected(tabId);
  const res = await ext.tabs.sendMessage(tabId, { type: 'API_FETCH', url: path });
  if (!res) throw new Error('Нет ответа от страницы. Обновите вкладку (F5)');
  if (res.error) throw new Error(res.error);
  return res.data;
}

function slugFromUrl(url) {
  try {
    const m = new URL(url).pathname.match(/\/anime\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch (e) { return null; }
}

// ─── Init ──────────────────────────────────────────────────────────────
async function init() {
  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  autoDub.addEventListener('change', onDubChange);
  autoQuality.addEventListener('change', onQualityChange);
  autoEpsFrom.addEventListener('change', validateRange);
  autoEpsTo.addEventListener('change', validateRange);
  autoDlRange.addEventListener('click', downloadRange);
  autoDlAll.addEventListener('click', downloadAll);
  autoCancel.addEventListener('click', async () => {
    await bg({ type: 'CANCEL_QUEUE' });
    autoLive.textContent = '';
    setBusy(false);
  });

  const { dl } = await bg({ type: 'GET_DL' });
  const resumeDl = dl && dl.state && dl.state !== 'finished' ? dl : null;

  const tab = await findAnimelibTab();
  if (!tab) {
    showSearch('Откройте animelib.org в соседней вкладке — оттуда расширение берёт данные.');
    return;
  }
  tabId = tab.id;

  const slug = slugFromUrl(tab.url);
  if (slug) {
    await loadAnime(slug);
    if (resumeDl) {
      addStatus('Загрузка уже идёт в фоне...');
      handleProgress(resumeDl);
    }
  } else {
    showSearch('');
  }
}

function showSearch(hint) {
  modeAuto.style.display = 'none';
  modeSearch.style.display = 'block';
  searchStatus.textContent = hint || '';
}

function showAuto() {
  modeSearch.style.display = 'none';
  modeAuto.style.display = 'block';
}

// ─── Load anime (from page URL or search) ──────────────────────────────
async function loadAnime(slug) {
  showAuto();
  autoLoading.style.display = 'block';
  autoLoading.innerHTML = '<div class="spinner"></div><p>Загружаю информацию...</p>';
  autoContent.style.display = 'none';
  autoStatus.innerHTML = '';
  autoProgress.style.display = 'none';
  autoCard.innerHTML = '';
  state.details = [];
  state.dubs = [];
  state.dub = '';
  state.quality = 0;

  try {
    const animeRes = await api(`/anime/${slug}`);
    const d = animeRes.data;
    const epsRes = await api(`/episodes?anime_id=${encodeURIComponent(slug)}`);

    state.anime = {
      slug,
      title: d.rus_name || d.name || d.eng_name,
      title_en: d.eng_name || '',
      cover: (d.cover && d.cover.default) || '',
      year: d.release_date || '',
      type: (d.anime_type && d.anime_type.label) || '',
      count: (d.items_count && d.items_count.total) || 0
    };
    state.episodes = (epsRes.data || []).map(ep => ({
      id: ep.id,
      number: parseFloat(ep.number) || 0,
      name: ep.name || '',
      season: ep.season || 1
    })).sort((a, b) => a.number - b.number);

    renderCard(state.anime);

    if (!state.episodes.length) {
      autoLoading.innerHTML = '<p>Серии не найдены</p>';
      return;
    }

    autoEpsTotal.textContent = state.episodes.length;
    autoEpsFrom.value = 1;
    autoEpsTo.value = state.episodes.length;

    await loadDetails();
    populateDubs();

    autoLoading.style.display = 'none';
    autoContent.style.display = 'block';
    autoDlRange.disabled = true;
    autoDlAll.disabled = true;

    if (!state.dubs.length) {
      addStatus('Нет доступных озвучек. Войдите в аккаунт AnimeLib и обновите страницу.', 'error');
    }
  } catch (err) {
    autoLoading.style.display = 'block';
    autoLoading.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

async function loadDetails() {
  const total = state.episodes.length;
  const batch = 4;
  for (let i = 0; i < total; i += batch) {
    const p = autoLoading.querySelector('p');
    if (p) p.textContent = `Загружаю серии... (${Math.min(i + batch, total)}/${total})`;
    const chunk = state.episodes.slice(i, i + batch);
    const res = await Promise.all(chunk.map(async ep => {
      try {
        const r = await api(`/episodes/${ep.id}`);
        const ed = r.data;
        return {
          id: ed.id,
          players: (ed.players || []).map(pl => ({
            player: pl.player,
            team: (pl.team && pl.team.name) || 'Неизвестно',
            qualities: ((pl.video && pl.video.quality) || []).map(q => ({ quality: q.quality, href: q.href }))
          }))
        };
      } catch (e) { return null; }
    }));
    state.details.push(...res.filter(Boolean));
  }
  const dubs = new Set();
  state.details.forEach(ep => ep.players.forEach(p => { if (p.qualities.length) dubs.add(p.team); }));
  state.dubs = [...dubs].sort();
}

function populateDubs() {
  autoDub.innerHTML = '<option value="">Выберите озвучку</option>';
  state.dubs.forEach(d => {
    const o = document.createElement('option');
    o.value = d; o.textContent = d;
    autoDub.appendChild(o);
  });
  autoQuality.innerHTML = '<option value="">Сначала выберите озвучку</option>';
}

function onDubChange() {
  state.dub = autoDub.value;
  state.quality = 0;
  autoQuality.innerHTML = '<option value="">Выберите качество</option>';
  autoDlRange.disabled = true;
  autoDlAll.disabled = true;
  if (!state.dub) return;

  const qs = new Set();
  state.details.forEach(ep => ep.players.forEach(p => {
    if (p.team === state.dub) p.qualities.forEach(q => qs.add(q.quality));
  }));
  [...qs].sort((a, b) => b - a).forEach(q => {
    const o = document.createElement('option');
    o.value = q; o.textContent = q + 'p';
    autoQuality.appendChild(o);
  });
  if (qs.size === 1) {
    autoQuality.value = [...qs][0];
    onQualityChange();
  }
}

function onQualityChange() {
  state.quality = parseInt(autoQuality.value) || 0;
  refreshButtons();
}

function refreshButtons() {
  const ok = state.dub && state.quality > 0 && !state.busy;
  autoDlRange.disabled = !ok;
  autoDlAll.disabled = !ok;
}

function setBusy(b) {
  state.busy = b;
  autoCancel.style.display = b ? 'block' : 'none';
  refreshButtons();
}

function setBar(pct) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  autoProgress.style.display = 'block';
  autoBar.style.width = p + '%';
  autoPct.textContent = p + '%';
}

const mb = b => (b / 1048576).toFixed(0) + ' МБ';

function handleProgress(m) {
  switch (m.state) {
    case 'downloading':
      setBusy(true);
      autoLive.textContent = `${m.label || 'Серия'} (${m.i + 1}/${m.total}): ${mb(m.received || 0)}${m.size ? ' / ' + mb(m.size) : ''}`;
      setBar(((m.i + (m.size ? m.received / m.size : 0)) / m.total) * 100);
      break;
    case 'saving':
      setBusy(true);
      autoLive.textContent = `Сохранение: ${m.label}...`;
      break;
    case 'saved':
      addStatus(`${m.label} — сохранено`, 'success');
      setBar(((m.i + 1) / m.total) * 100);
      break;
    case 'error':
      addStatus(`${m.label}: ${m.message}`, 'error');
      break;
    case 'finished':
      autoLive.textContent = '';
      if (m.cancelled) addStatus('Загрузка отменена');
      else addStatus(`Готово: ${m.ok}/${m.total}${m.fail ? `, ошибок: ${m.fail}` : ''}. Файлы в папке Загрузки/AnimeLib`, m.fail ? '' : 'success');
      setBusy(false);
      break;
  }
}

ext.runtime.onMessage.addListener(msg => {
  if (msg && msg.type === 'DL_PROGRESS') handleProgress(msg);
});

function validateRange() {
  const total = state.episodes.length;
  let from = parseInt(autoEpsFrom.value) || 1;
  let to = parseInt(autoEpsTo.value) || total;
  from = Math.max(1, from);
  to = Math.min(total, to);
  if (from > to) [from, to] = [to, from];
  autoEpsFrom.value = from;
  autoEpsTo.value = to;
}

// ─── Download ──────────────────────────────────────────────────────────
const REFERERS = ['https://animelib.org', 'https://v3.animelib.org'];
const DEFAULT_BASES = [
  'https://video1.cdnlibs.org/.%D0%B0s/',
  'https://video2.cdnlibs.org/.%D0%B0s/',
  'https://video3.cdnlibs.org/.%D0%B0s/',
  'https://video1.cdnlibs.org/',
  'https://video2.cdnlibs.org/',
  'https://video3.cdnlibs.org/'
];
let working = null; // { base, referer }

function joinUrl(base, href) {
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('//')) return 'https:' + href;
  return base.replace(/\/+$/, '') + '/' + href.replace(/^\/+/, '');
}

async function getBases() {
  const bases = [];
  try {
    const r = await api('/constants?fields[]=videoServers');
    const servers = (r.data && r.data.videoServers) || [];
    servers.forEach(s => { if (s && s.url) bases.push(s.url); });
  } catch (e) { /* use defaults */ }
  return [...new Set([...bases, ...DEFAULT_BASES])];
}

async function probe(url) {
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-1' }, credentials: 'omit', cache: 'no-store' });
    const ct = r.headers.get('content-type') || '';
    try { await r.body.cancel(); } catch (e) {}
    const ok = (r.status === 200 || r.status === 206) && !/text\/html/i.test(ct);
    return { ok, status: r.status, ct };
  } catch (e) {
    return { ok: false, status: 0, ct: e.message };
  }
}

// Find a (base, referer) pair that actually serves the video
async function findWorking(sampleHref) {
  if (working) {
    await bg({ type: 'SET_REFERER', referer: working.referer });
    const p = await probe(joinUrl(working.base, sampleHref));
    if (p.ok) return { ok: true, log: [] };
  }
  const bases = await getBases();
  const log = [];
  for (const referer of REFERERS) {
    await bg({ type: 'SET_REFERER', referer });
    await sleep(100);
    for (const base of bases) {
      const url = joinUrl(base, sampleHref);
      const p = await probe(url);
      log.push(`${p.status} ${referer.replace('https://', '')} ← ${url}`);
      if (p.ok) {
        working = { base, referer };
        return { ok: true, log };
      }
    }
  }
  return { ok: false, log };
}

function buildUrl(href) {
  return joinUrl(working ? working.base : DEFAULT_BASES[0], href);
}

// from/to are 1-based positions in the sorted episode list
function buildConfigs(from, to) {
  const out = [];
  for (let i = from - 1; i < to; i++) {
    const meta = state.episodes[i];
    const det = meta && state.details.find(e => e.id === meta.id);
    if (!det) continue;
    const pl = det.players.find(p => p.team === state.dub && p.qualities.some(q => q.quality === state.quality));
    if (!pl) continue;
    const q = pl.qualities.find(q => q.quality === state.quality);
    out.push({ number: meta.number, season: meta.season, href: q.href });
  }
  return out;
}

async function downloadRange() {
  validateRange();
  await run(buildConfigs(parseInt(autoEpsFrom.value), parseInt(autoEpsTo.value)));
}

async function downloadAll() {
  await run(buildConfigs(1, state.episodes.length));
}

async function run(configs) {
  autoStatus.innerHTML = '';
  autoLive.textContent = '';
  if (!configs.length) { addStatus('Нет серий с выбранными параметрами', 'error'); return; }

  setBusy(true);
  setBar(0);

  addStatus('Проверка доступа к видео...');
  const found = await findWorking(configs[0].href);
  if (!found.ok) {
    addStatus('Сервер не отдаёт видео. Пример href: ' + configs[0].href, 'error');
    found.log.slice(0, 8).forEach(l => addStatus(l, 'error'));
    setBusy(false);
    return;
  }
  addStatus('Сервер доступен: ' + working.base, 'success');

  const folder = `AnimeLib/${sanitize(state.anime.title)}/${sanitize(state.dub)}`;
  const jobs = configs.map(c => ({
    url: buildUrl(c.href),
    label: `Серия ${c.number}`,
    filename: `${folder}/${sanitize(state.anime.title)} - ${String(c.number).padStart(2, '0')} [${state.quality}p].mp4`
  }));

  const r = await bg({ type: 'START_QUEUE', jobs, referer: working.referer });
  if (!r || r.error) {
    addStatus((r && r.error) || 'Не удалось запустить загрузку', 'error');
    setBusy(false);
    return;
  }
  addStatus(`Скачивание ${jobs.length} серий по очереди. Окно можно закрыть — загрузка продолжится.`);
}

function addStatus(text, cls) {
  const d = document.createElement('div');
  d.className = cls || '';
  d.textContent = text;
  autoStatus.appendChild(d);
  autoStatus.scrollTop = autoStatus.scrollHeight;
}

// ─── Search ────────────────────────────────────────────────────────────
async function doSearch() {
  const q = searchInput.value.trim();
  if (!q) return;
  if (tabId == null) {
    const tab = await findAnimelibTab();
    if (!tab) { searchStatus.textContent = 'Откройте animelib.org в соседней вкладке'; return; }
    tabId = tab.id;
  }
  searchBtn.disabled = true;
  searchStatus.textContent = 'Поиск...';
  searchResults.innerHTML = '';

  try {
    const params = new URLSearchParams({ q });
    params.append('site_id[]', '1');
    params.append('site_id[]', '3');
    const res = await api(`/anime?${params}`);
    const items = (res.data || []).map(i => ({
      slug: i.slug_url,
      title: i.rus_name || i.name || i.eng_name,
      year: i.release_date || '',
      cover: (i.cover && (i.cover.default || i.cover.md)) || '',
      type: (i.anime_type && i.anime_type.label) || '',
      rating: (i.rating && i.rating.average_formatted) || ''
    }));
    if (!items.length) {
      searchResults.innerHTML = '<div class="no-results">Ничего не найдено</div>';
      searchStatus.textContent = '';
    } else {
      searchStatus.textContent = `Найдено: ${items.length}`;
      renderResults(items);
    }
  } catch (err) {
    searchStatus.textContent = err.message;
  } finally {
    searchBtn.disabled = false;
  }
}

function renderResults(items) {
  searchResults.innerHTML = items.map(a => `
    <div class="result-card" data-slug="${esc(a.slug)}">
      <img src="${esc(a.cover)}" alt="">
      <div class="res-info">
        <div class="res-title">${esc(a.title)}</div>
        <div class="res-meta">
          ${a.year ? `<span>${esc(a.year)}</span>` : ''}
          ${a.type ? `<span>${esc(a.type)}</span>` : ''}
          ${a.rating ? `<span>Рейтинг ${esc(a.rating)}</span>` : ''}
        </div>
      </div>
    </div>`).join('');
  searchResults.querySelectorAll('.result-card').forEach(c =>
    c.addEventListener('click', () => loadAnime(c.dataset.slug)));
  searchResults.querySelectorAll('img').forEach(img =>
    img.addEventListener('error', () => { img.style.display = 'none'; }, { once: true }));
}

// ─── Helpers ───────────────────────────────────────────────────────────
function renderCard(d) {
  autoCard.innerHTML = `
    <img src="${esc(d.cover)}" alt="">
    <div class="info">
      <div class="title">${esc(d.title)}</div>
      ${d.title_en ? `<div class="title-en">${esc(d.title_en)}</div>` : ''}
      <div class="meta">
        ${d.year ? `<span>${esc(d.year)}</span>` : ''}
        ${d.type ? `<span>${esc(d.type)}</span>` : ''}
        ${d.count ? `<span>${d.count} эп.</span>` : ''}
      </div>
    </div>`;
  const img = autoCard.querySelector('img');
  if (img) img.addEventListener('error', () => { img.style.display = 'none'; }, { once: true });
}

function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function sanitize(s) { return (s || 'unknown').replace(/[<>:"/\\|?*]/g, '_').trim(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

init();
