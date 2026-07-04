/* ============================================================
   قناديل ميوزك — Offline Music PWA
   Vanilla JS · IndexedDB · Media Session · Service Worker
   Storage design (low-end friendly):
     - store "songs"     : metadata only (fast list rendering)
     - store "blobs"     : audio blobs, loaded lazily one at a time
     - store "playlists" : {id, name, songIds[], createdAt}
     - store "kv"        : app state (resume position, modes)
   ============================================================ */
'use strict';

/* ---------------- IndexedDB layer ---------------- */
const DB_NAME = 'qanadeel_music';
const DB_VER = 1;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('songs')) d.createObjectStore('songs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('playlists')) d.createObjectStore('playlists', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

function idbReq(storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const r = fn(store);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const idbPut = (s, v) => idbReq(s, 'readwrite', (st) => st.put(v));
const idbGet = (s, k) => idbReq(s, 'readonly', (st) => st.get(k));
const idbAll = (s) => idbReq(s, 'readonly', (st) => st.getAll());
const idbDel = (s, k) => idbReq(s, 'readwrite', (st) => st.delete(k));
const kvSet = (k, v) => idbPut('kv', { k, v });
const kvGet = async (k) => { const r = await idbGet('kv', k); return r ? r.v : null; };

/* ---------------- App state ---------------- */
const S = {
  songs: new Map(),        // id -> meta
  playlists: [],           // array of playlist objects
  tab: 'library',
  openPlaylistId: null,    // playlist detail view
  search: '',
  // playback
  queue: [],               // array of song ids (current play order)
  qIndex: -1,
  ctxId: 'all',            // 'all' or playlist id
  ctxName: 'المكتبة',
  currentSongId: null,
  currentUrl: null,        // active object URL (revoked on change)
  shuffle: false,
  repeat: 'off',           // 'off' | 'all' | 'one'
  pendingResume: null,     // {position} applied on first user play
};

const audio = document.getElementById('audio');
const $ = (id) => document.getElementById(id);

/* ---------------- Utilities ---------------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ':' + String(s).padStart(2, '0');
}
function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? mb.toFixed(1) + ' م.ب' : Math.round(bytes / 1024) + ' ك.ب';
}
function cleanName(fileName) {
  return fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
}

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

function readDuration(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const a = new Audio();
    a.preload = 'metadata';
    const done = (d) => { URL.revokeObjectURL(url); a.src = ''; resolve(d); };
    a.onloadedmetadata = () => done(isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => done(0);
    a.src = url;
  });
}

/* ---------------- Modals ---------------- */
function promptModal(title, placeholder, value) {
  return new Promise((resolve) => {
    const ov = $('modalOverlay');
    ov.classList.add('center');
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = placeholder || '';
    input.value = value || '';
    input.maxLength = 60;
    $('modalBody').appendChild(input);
    ov.hidden = false;
    setTimeout(() => input.focus(), 50);

    const close = (result) => { ov.hidden = true; cleanup(); resolve(result); };
    const onOk = () => { const v = input.value.trim(); v ? close(v) : input.focus(); };
    const onCancel = () => close(null);
    const onKey = (e) => { if (e.key === 'Enter') onOk(); };
    function cleanup() {
      $('modalOk').removeEventListener('click', onOk);
      $('modalCancel').removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
    }
    $('modalOk').addEventListener('click', onOk);
    $('modalCancel').addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

function confirmModal(title, message) {
  return new Promise((resolve) => {
    const ov = $('modalOverlay');
    ov.classList.add('center');
    $('modalTitle').textContent = title;
    $('modalBody').innerHTML = '';
    const p = document.createElement('p');
    p.textContent = message;
    $('modalBody').appendChild(p);
    ov.hidden = false;
    const close = (r) => { ov.hidden = true; cleanup(); resolve(r); };
    const onOk = () => close(true);
    const onCancel = () => close(false);
    function cleanup() {
      $('modalOk').removeEventListener('click', onOk);
      $('modalCancel').removeEventListener('click', onCancel);
    }
    $('modalOk').addEventListener('click', onOk);
    $('modalCancel').addEventListener('click', onCancel);
  });
}

/* Bottom sheet with a list of actions: [{label, icon?, danger?, fn}] */
function actionSheet(title, actions) {
  const ov = $('sheetOverlay');
  $('sheetTitle').textContent = title;
  const box = $('sheetActions');
  box.innerHTML = '';
  actions.forEach((a) => {
    const b = document.createElement('button');
    b.className = 'sheet-btn' + (a.danger ? ' danger' : '');
    b.textContent = a.label;
    b.addEventListener('click', () => { ov.hidden = true; a.fn(); });
    box.appendChild(b);
  });
  ov.hidden = false;
  const cancel = () => { ov.hidden = true; };
  $('sheetCancel').onclick = cancel;
  ov.onclick = (e) => { if (e.target === ov) cancel(); };
}

/* Playlist picker: resolves playlist id or null */
function pickPlaylist(title, excludeId) {
  return new Promise((resolve) => {
    const ov = $('sheetOverlay');
    $('sheetTitle').textContent = title;
    const box = $('sheetActions');
    box.innerHTML = '';
    const lists = S.playlists.filter((p) => p.id !== excludeId);
    if (lists.length === 0) {
      const p = document.createElement('div');
      p.className = 'muted';
      p.style.padding = '14px 8px';
      p.textContent = 'لا توجد قوائم أخرى — أنشئ قائمة جديدة أولاً.';
      box.appendChild(p);
    }
    lists.forEach((pl) => {
      const b = document.createElement('button');
      b.className = 'sheet-btn';
      b.textContent = '🎵 ' + pl.name + ' (' + pl.songIds.length + ')';
      b.addEventListener('click', () => { ov.hidden = true; resolve(pl.id); });
      box.appendChild(b);
    });
    const nb = document.createElement('button');
    nb.className = 'sheet-btn';
    nb.textContent = '＋ قائمة جديدة…';
    nb.addEventListener('click', async () => {
      ov.hidden = true;
      const name = await promptModal('قائمة تشغيل جديدة', 'اسم القائمة');
      if (!name) return resolve(null);
      const pl = await createPlaylist(name);
      resolve(pl.id);
    });
    box.appendChild(nb);
    ov.hidden = false;
    const cancel = () => { ov.hidden = true; resolve(null); };
    $('sheetCancel').onclick = cancel;
    ov.onclick = (e) => { if (e.target === ov) cancel(); };
  });
}

/* Multi-select songs from the library: resolves array of song ids */
function pickSongs(title, alreadyIn) {
  return new Promise((resolve) => {
    const ov = $('modalOverlay');
    ov.classList.add('center');
    $('modalTitle').textContent = title;
    const body = $('modalBody');
    body.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'pick-list';
    const selected = new Set();
    const songs = [...S.songs.values()].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
    let shown = 0;
    songs.forEach((s) => {
      if (alreadyIn && alreadyIn.includes(s.id)) return;
      shown++;
      const b = document.createElement('button');
      b.className = 'pick-item';
      b.textContent = '◻ ' + s.name;
      b.addEventListener('click', () => {
        if (selected.has(s.id)) { selected.delete(s.id); b.textContent = '◻ ' + s.name; b.style.color = ''; }
        else { selected.add(s.id); b.textContent = '☑ ' + s.name; b.style.color = 'var(--gold)'; }
      });
      list.appendChild(b);
    });
    if (shown === 0) {
      const p = document.createElement('p');
      p.textContent = 'كل أغاني المكتبة موجودة في هذه القائمة، أو المكتبة فارغة.';
      list.appendChild(p);
    }
    body.appendChild(list);
    ov.hidden = false;
    const close = (r) => { ov.hidden = true; cleanup(); resolve(r); };
    const onOk = () => close([...selected]);
    const onCancel = () => close(null);
    function cleanup() {
      $('modalOk').removeEventListener('click', onOk);
      $('modalCancel').removeEventListener('click', onCancel);
    }
    $('modalOk').addEventListener('click', onOk);
    $('modalCancel').addEventListener('click', onCancel);
  });
}

/* ---------------- Data operations ---------------- */
async function loadAll() {
  const [songs, playlists] = await Promise.all([idbAll('songs'), idbAll('playlists')]);
  S.songs = new Map(songs.map((s) => [s.id, s]));
  S.playlists = playlists.sort((a, b) => a.createdAt - b.createdAt);
}

async function addFiles(fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|oga|flac|opus)$/i.test(f.name));
  if (files.length === 0) { toast('لم يتم اختيار ملفات صوتية'); return; }

  // Ask the browser to protect storage from eviction (important for music)
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  let done = 0;
  for (const file of files) {
    toast('جارٍ الإضافة… ' + (done + 1) + ' / ' + files.length);
    try {
      const duration = await readDuration(file);
      const meta = {
        id: uid(),
        name: cleanName(file.name),
        type: file.type || 'audio/mpeg',
        size: file.size,
        duration,
        addedAt: Date.now(),
      };
      // Store blob and metadata separately so lists never touch blobs
      await idbPut('blobs', { id: meta.id, blob: file });
      await idbPut('songs', meta);
      S.songs.set(meta.id, meta);
      done++;
    } catch (err) {
      console.error('add failed', file.name, err);
    }
  }
  render();
  toast(done === 1 ? 'تمت إضافة أغنية واحدة ✓' : 'تمت إضافة ' + done + ' أغانٍ ✓');
}

async function deleteSong(id) {
  const s = S.songs.get(id);
  if (!s) return;
  const ok = await confirmModal('حذف نهائي', 'سيتم حذف «' + s.name + '» من الجهاز ومن كل قوائم التشغيل. هل أنت متأكد؟');
  if (!ok) return;
  if (S.currentSongId === id) stopPlayback();
  await idbDel('songs', id);
  await idbDel('blobs', id);
  S.songs.delete(id);
  for (const pl of S.playlists) {
    if (pl.songIds.includes(id)) {
      pl.songIds = pl.songIds.filter((x) => x !== id);
      await idbPut('playlists', pl);
    }
  }
  // also remove from live queue
  const qi = S.queue.indexOf(id);
  if (qi > -1) { S.queue.splice(qi, 1); if (qi < S.qIndex) S.qIndex--; }
  render();
  toast('تم الحذف');
}

async function createPlaylist(name) {
  const pl = { id: uid(), name, songIds: [], createdAt: Date.now() };
  await idbPut('playlists', pl);
  S.playlists.push(pl);
  render();
  toast('أُنشئت قائمة «' + name + '»');
  return pl;
}

async function renamePlaylist(id) {
  const pl = S.playlists.find((p) => p.id === id);
  if (!pl) return;
  const name = await promptModal('إعادة تسمية القائمة', 'الاسم الجديد', pl.name);
  if (!name) return;
  pl.name = name;
  await idbPut('playlists', pl);
  if (S.ctxId === id) S.ctxName = name;
  render();
}

async function deletePlaylist(id) {
  const pl = S.playlists.find((p) => p.id === id);
  if (!pl) return;
  const ok = await confirmModal('حذف القائمة', 'حذف قائمة «' + pl.name + '»؟ (الأغاني نفسها تبقى في المكتبة)');
  if (!ok) return;
  await idbDel('playlists', id);
  S.playlists = S.playlists.filter((p) => p.id !== id);
  if (S.openPlaylistId === id) { S.openPlaylistId = null; S.tab = 'playlists'; }
  render();
  toast('حُذفت القائمة');
}

async function addSongsToPlaylist(plId, songIds) {
  const pl = S.playlists.find((p) => p.id === plId);
  if (!pl) return;
  let added = 0;
  for (const id of songIds) {
    if (!pl.songIds.includes(id)) { pl.songIds.push(id); added++; }
  }
  if (added) await idbPut('playlists', pl);
  render();
  toast(added ? 'أُضيفت ' + added + ' إلى «' + pl.name + '»' : 'الأغاني موجودة مسبقًا');
}

async function removeFromPlaylist(plId, songId) {
  const pl = S.playlists.find((p) => p.id === plId);
  if (!pl) return;
  pl.songIds = pl.songIds.filter((x) => x !== songId);
  await idbPut('playlists', pl);
  render();
  toast('أُزيلت من القائمة');
}

async function moveSongOrder(plId, songId, dir) {
  const pl = S.playlists.find((p) => p.id === plId);
  if (!pl) return;
  const i = pl.songIds.indexOf(songId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= pl.songIds.length) return;
  [pl.songIds[i], pl.songIds[j]] = [pl.songIds[j], pl.songIds[i]];
  await idbPut('playlists', pl);
  render();
}

/* ---------------- Export / Import (JSON backup) ---------------- */
function exportBackup() {
  const data = {
    app: 'qanadeel-music',
    version: 1,
    exportedAt: new Date().toISOString(),
    note: 'يحفظ هذا الملف بنية القوائم وأسماء الأغاني فقط. الملفات الصوتية نفسها تبقى في جهازك.',
    playlists: S.playlists.map((p) => ({
      name: p.name,
      songs: p.songIds.map((id) => (S.songs.get(id) || {}).name).filter(Boolean),
    })),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'qanadeel-music-backup.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  toast('تم تصدير النسخة الاحتياطية');
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.playlists)) throw new Error('bad format');
    const byName = new Map([...S.songs.values()].map((s) => [s.name, s.id]));
    let created = 0, matched = 0;
    for (const p of data.playlists) {
      const ids = (p.songs || []).map((n) => byName.get(n)).filter(Boolean);
      matched += ids.length;
      const pl = { id: uid(), name: p.name || 'قائمة مستوردة', songIds: ids, createdAt: Date.now() };
      await idbPut('playlists', pl);
      S.playlists.push(pl);
      created++;
    }
    render();
    toast('استُوردت ' + created + ' قوائم (' + matched + ' أغنية مطابقة)');
  } catch (e) {
    toast('ملف النسخة الاحتياطية غير صالح');
  }
}

/* ---------------- Player engine ---------------- */
function buildQueue(ctxId) {
  let ids;
  if (ctxId === 'all') {
    ids = [...S.songs.values()].sort((a, b) => a.addedAt - b.addedAt).map((s) => s.id);
    S.ctxName = 'المكتبة';
  } else {
    const pl = S.playlists.find((p) => p.id === ctxId);
    ids = pl ? [...pl.songIds] : [];
    S.ctxName = pl ? pl.name : '';
  }
  return ids;
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function playFromContext(ctxId, songId) {
  let queue = buildQueue(ctxId);
  if (queue.length === 0) { toast('لا توجد أغانٍ للتشغيل'); return; }
  if (S.shuffle) {
    queue = shuffleArray(queue);
    if (songId) {
      // put the chosen song first
      queue = [songId, ...queue.filter((x) => x !== songId)];
    }
  }
  S.ctxId = ctxId;
  S.queue = queue;
  S.qIndex = songId ? queue.indexOf(songId) : 0;
  if (S.qIndex < 0) S.qIndex = 0;
  await loadAndPlay(S.queue[S.qIndex]);
}

async function loadAndPlay(songId, startAt) {
  const meta = S.songs.get(songId);
  if (!meta) return;
  const rec = await idbGet('blobs', songId);
  if (!rec || !rec.blob) { toast('تعذّر تحميل الملف الصوتي'); return; }

  // Lazy loading: exactly one object URL alive at a time
  if (S.currentUrl) { URL.revokeObjectURL(S.currentUrl); S.currentUrl = null; }
  S.currentUrl = URL.createObjectURL(rec.blob);
  S.currentSongId = songId;
  S.pendingResume = null;

  audio.src = S.currentUrl;
  if (startAt && isFinite(startAt)) {
    audio.currentTime = 0;
    audio.addEventListener('loadedmetadata', function seekOnce() {
      audio.removeEventListener('loadedmetadata', seekOnce);
      try { audio.currentTime = Math.min(startAt, (audio.duration || startAt) - 0.5); } catch (e) {}
    });
  }
  try {
    await audio.play();
  } catch (e) {
    // Autoplay may be blocked before first user gesture — UI stays paused
  }
  updateMediaSession(meta);
  renderPlayerUI();
  renderNowPlayingHighlights();
  saveState();
}

function togglePlay() {
  if (!S.currentSongId) {
    // nothing loaded — start from the library
    playFromContext('all', null);
    return;
  }
  if (audio.src === '' || audio.src === location.href) {
    // resumed session: blob not loaded yet
    const at = S.pendingResume ? S.pendingResume.position : 0;
    loadAndPlay(S.currentSongId, at);
    return;
  }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

function nextTrack(auto) {
  if (S.queue.length === 0) return;
  if (auto && S.repeat === 'one') {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  let i = S.qIndex + 1;
  if (i >= S.queue.length) {
    if (S.repeat === 'all' || !auto) i = 0;
    else { audio.pause(); return; } // end of queue, repeat off
  }
  S.qIndex = i;
  loadAndPlay(S.queue[i]);
}

function prevTrack() {
  if (S.queue.length === 0) return;
  if (audio.currentTime > 4) { audio.currentTime = 0; return; }
  let i = S.qIndex - 1;
  if (i < 0) i = S.queue.length - 1;
  S.qIndex = i;
  loadAndPlay(S.queue[i]);
}

function stopPlayback() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  if (S.currentUrl) { URL.revokeObjectURL(S.currentUrl); S.currentUrl = null; }
  S.currentSongId = null;
  S.queue = [];
  S.qIndex = -1;
  renderPlayerUI();
  renderNowPlayingHighlights();
}

function toggleShuffle() {
  S.shuffle = !S.shuffle;
  if (S.queue.length > 1) {
    if (S.shuffle) {
      const cur = S.queue[S.qIndex];
      S.queue = [cur, ...shuffleArray(S.queue.filter((x) => x !== cur))];
      S.qIndex = 0;
    } else {
      const cur = S.queue[S.qIndex];
      S.queue = buildQueue(S.ctxId);
      S.qIndex = Math.max(0, S.queue.indexOf(cur));
    }
  }
  renderPlayerUI();
  saveState();
}

function cycleRepeat() {
  S.repeat = S.repeat === 'off' ? 'all' : S.repeat === 'all' ? 'one' : 'off';
  renderPlayerUI();
  saveState();
}

/* ---------------- Resume state ---------------- */
let saveTimer = 0;
function saveState() {
  kvSet('state', {
    songId: S.currentSongId,
    ctxId: S.ctxId,
    queue: S.queue,
    qIndex: S.qIndex,
    position: audio.currentTime || 0,
    shuffle: S.shuffle,
    repeat: S.repeat,
  }).catch(() => {});
}
function saveStateThrottled() {
  const now = Date.now();
  if (now - saveTimer > 4000) { saveTimer = now; saveState(); }
}

async function restoreState() {
  const st = await kvGet('state');
  if (!st) return;
  S.shuffle = !!st.shuffle;
  S.repeat = st.repeat || 'off';
  if (st.songId && S.songs.has(st.songId)) {
    S.currentSongId = st.songId;
    S.ctxId = st.ctxId || 'all';
    S.queue = (st.queue || []).filter((id) => S.songs.has(id));
    S.qIndex = Math.max(0, S.queue.indexOf(st.songId));
    S.pendingResume = { position: st.position || 0 };
    const pl = S.playlists.find((p) => p.id === S.ctxId);
    S.ctxName = S.ctxId === 'all' ? 'المكتبة' : (pl ? pl.name : '');
    // Show it in the mini player, paused; blob loads on first tap
    updateMediaSession(S.songs.get(st.songId));
  }
}

/* ---------------- Media Session (lock screen / Bluetooth) ---------------- */
function updateMediaSession(meta) {
  if (!('mediaSession' in navigator) || !meta) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: meta.name,
    artist: 'قناديل ميوزك',
    album: S.ctxName || 'المكتبة',
    artwork: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  });
  try {
    navigator.mediaSession.setActionHandler('play', () => togglePlay());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', () => prevTrack());
    navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack(false));
    navigator.mediaSession.setActionHandler('seekto', (d) => {
      if (d.seekTime != null && isFinite(d.seekTime)) audio.currentTime = d.seekTime;
    });
  } catch (e) { /* some handlers unsupported on older browsers */ }
}

function updatePositionState() {
  if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && isFinite(audio.duration)) {
    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate,
        position: Math.min(audio.currentTime, audio.duration),
      });
    } catch (e) {}
  }
}

/* ---------------- Rendering ---------------- */
function matchesSearch(name) {
  return !S.search || name.toLowerCase().includes(S.search);
}

function songArtHTML(isPlaying) {
  if (isPlaying) return '<div class="eq"><span></span><span></span><span></span></div>';
  return '<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z"/></svg>';
}

function makeSongRow(meta, opts) {
  const li = document.createElement('li');
  const playing = meta.id === S.currentSongId;
  li.className = 'song-row' + (playing ? ' playing' : '');
  li.dataset.songId = meta.id;

  const art = document.createElement('div');
  art.className = 'song-art';
  art.innerHTML = songArtHTML(playing);

  const main = document.createElement('div');
  main.className = 'song-main';
  const nm = document.createElement('div');
  nm.className = 'song-name';
  nm.textContent = meta.name;
  const info = document.createElement('div');
  info.className = 'song-info';
  info.textContent = fmtTime(meta.duration) + (meta.size ? ' · ' + fmtSize(meta.size) : '');
  main.appendChild(nm); main.appendChild(info);

  const menu = document.createElement('button');
  menu.className = 'icon-btn';
  menu.setAttribute('aria-label', 'خيارات');
  menu.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5a2 2 0 110 4 2 2 0 010-4zm0 5a2 2 0 110 4 2 2 0 010-4zm0 5a2 2 0 110 4 2 2 0 010-4z"/></svg>';
  menu.addEventListener('click', (e) => { e.stopPropagation(); openSongMenu(meta, opts); });

  li.appendChild(art); li.appendChild(main); li.appendChild(menu);
  li.addEventListener('click', () => playFromContext(opts.ctxId, meta.id));
  return li;
}

function openSongMenu(meta, opts) {
  const actions = [];
  actions.push({ label: '▶ تشغيل', fn: () => playFromContext(opts.ctxId, meta.id) });
  actions.push({
    label: '＋ إضافة إلى قائمة تشغيل…',
    fn: async () => {
      const plId = await pickPlaylist('إضافة «' + meta.name + '» إلى:', null);
      if (plId) addSongsToPlaylist(plId, [meta.id]);
    },
  });
  if (opts.inPlaylist) {
    actions.push({
      label: '⇄ نقل إلى قائمة أخرى…',
      fn: async () => {
        const plId = await pickPlaylist('نقل «' + meta.name + '» إلى:', opts.inPlaylist);
        if (plId) {
          await addSongsToPlaylist(plId, [meta.id]);
          await removeFromPlaylist(opts.inPlaylist, meta.id);
        }
      },
    });
    actions.push({ label: '↑ تحريك لأعلى', fn: () => moveSongOrder(opts.inPlaylist, meta.id, -1) });
    actions.push({ label: '↓ تحريك لأسفل', fn: () => moveSongOrder(opts.inPlaylist, meta.id, +1) });
    actions.push({ label: '✕ إزالة من هذه القائمة', fn: () => removeFromPlaylist(opts.inPlaylist, meta.id) });
  }
  actions.push({ label: '🗑 حذف من الجهاز نهائيًا', danger: true, fn: () => deleteSong(meta.id) });
  actionSheet(meta.name, actions);
}

function renderLibrary() {
  const ul = $('libraryList');
  ul.innerHTML = '';
  const songs = [...S.songs.values()]
    .filter((s) => matchesSearch(s.name))
    .sort((a, b) => b.addedAt - a.addedAt);
  const frag = document.createDocumentFragment();
  songs.forEach((s) => frag.appendChild(makeSongRow(s, { ctxId: 'all', inPlaylist: null })));
  ul.appendChild(frag);
  $('libraryEmpty').hidden = S.songs.size !== 0;

  const totalSize = [...S.songs.values()].reduce((t, s) => t + (s.size || 0), 0);
  $('libStats').textContent = S.songs.size === 0
    ? 'لا توجد أغانٍ بعد'
    : S.songs.size + ' أغنية · ' + fmtSize(totalSize);
}

function renderPlaylists() {
  const ul = $('playlistList');
  ul.innerHTML = '';
  const frag = document.createDocumentFragment();
  S.playlists.filter((p) => matchesSearch(p.name)).forEach((pl) => {
    const li = document.createElement('li');
    li.className = 'pl-row';
    const art = document.createElement('div');
    art.className = 'pl-art';
    art.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 6h12v2H4V6zm0 4h12v2H4v-2zm0 4h8v2H4v-2zm14-1.5V6h4v2h-2v8.5a3 3 0 11-2-2.83z"/></svg>';
    const main = document.createElement('div');
    main.className = 'pl-main';
    main.innerHTML = '<div class="pl-name"></div><div class="pl-count"></div>';
    main.querySelector('.pl-name').textContent = pl.name;
    main.querySelector('.pl-count').textContent = pl.songIds.length + ' أغنية';
    const menu = document.createElement('button');
    menu.className = 'icon-btn';
    menu.setAttribute('aria-label', 'خيارات القائمة');
    menu.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5a2 2 0 110 4 2 2 0 010-4zm0 5a2 2 0 110 4 2 2 0 010-4zm0 5a2 2 0 110 4 2 2 0 010-4z"/></svg>';
    menu.addEventListener('click', (e) => {
      e.stopPropagation();
      actionSheet(pl.name, [
        { label: '▶ تشغيل القائمة', fn: () => playFromContext(pl.id, null) },
        { label: '✏ إعادة تسمية', fn: () => renamePlaylist(pl.id) },
        { label: '🗑 حذف القائمة', danger: true, fn: () => deletePlaylist(pl.id) },
      ]);
    });
    li.appendChild(art); li.appendChild(main); li.appendChild(menu);
    li.addEventListener('click', () => { S.openPlaylistId = pl.id; render(); });
    frag.appendChild(li);
  });
  ul.appendChild(frag);
  $('playlistsEmpty').hidden = S.playlists.length !== 0;
}

function renderDetail() {
  const pl = S.playlists.find((p) => p.id === S.openPlaylistId);
  if (!pl) { S.openPlaylistId = null; return; }
  $('detailName').textContent = pl.name;
  $('detailCount').textContent = pl.songIds.length + ' أغنية';
  const ul = $('detailList');
  ul.innerHTML = '';
  const frag = document.createDocumentFragment();
  pl.songIds.forEach((id) => {
    const meta = S.songs.get(id);
    if (meta && matchesSearch(meta.name)) {
      frag.appendChild(makeSongRow(meta, { ctxId: pl.id, inPlaylist: pl.id }));
    }
  });
  ul.appendChild(frag);
  $('detailEmpty').hidden = pl.songIds.length !== 0;
}

function render() {
  const showDetail = S.openPlaylistId !== null;
  $('view-library').hidden = showDetail || S.tab !== 'library';
  $('view-playlists').hidden = showDetail || S.tab !== 'playlists';
  $('view-detail').hidden = !showDetail;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === S.tab));
  if (showDetail) renderDetail();
  else if (S.tab === 'library') renderLibrary();
  else renderPlaylists();
  renderPlayerUI();
}

function renderNowPlayingHighlights() {
  document.querySelectorAll('.song-row').forEach((row) => {
    const playing = row.dataset.songId === S.currentSongId;
    row.classList.toggle('playing', playing);
    row.querySelector('.song-art').innerHTML = songArtHTML(playing);
  });
}

function renderPlayerUI() {
  const meta = S.currentSongId ? S.songs.get(S.currentSongId) : null;
  const mini = $('miniPlayer');
  mini.hidden = !meta;
  const isPlaying = !audio.paused && !audio.ended && audio.src;
  document.body.classList.toggle('playing-anim', !!isPlaying);
  document.body.classList.toggle('paused', !isPlaying);

  const toggleIcons = (btn) => {
    btn.querySelector('.ic-play').hidden = !!isPlaying;
    btn.querySelector('.ic-pause').hidden = !isPlaying;
  };
  toggleIcons($('miniPlay'));
  toggleIcons($('btnPlay'));

  if (meta) {
    $('miniTitle').textContent = meta.name;
    $('miniSub').textContent = S.ctxName || 'المكتبة';
    $('fpTitle').textContent = meta.name;
    $('fpSub').textContent = fmtTime(meta.duration);
    $('fpContext').textContent = 'يُشغَّل من: ' + (S.ctxName || 'المكتبة');
  }
  $('btnShuffle').classList.toggle('on', S.shuffle);
  $('btnRepeat').classList.toggle('on', S.repeat !== 'off');
  $('repeatOne').hidden = S.repeat !== 'one';
}

/* ---------------- Progress / seek ---------------- */
let seeking = false;
function updateProgress() {
  const d = audio.duration;
  const c = audio.currentTime;
  const ratio = isFinite(d) && d > 0 ? c / d : 0;
  $('miniProgress').style.width = (ratio * 100) + '%';
  if (!seeking) {
    const bar = $('seekBar');
    bar.value = Math.round(ratio * 1000);
    bar.style.setProperty('--fill', (ratio * 100) + '%');
  }
  $('curTime').textContent = fmtTime(c);
  $('totTime').textContent = fmtTime(isFinite(d) ? d : (S.songs.get(S.currentSongId) || {}).duration || 0);
}

/* ---------------- Wire up events ---------------- */
function init() {
  // Tabs
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => { S.tab = t.dataset.tab; S.openPlaylistId = null; render(); });
  });

  // Search
  $('btnSearch').addEventListener('click', () => {
    const row = $('searchRow');
    row.hidden = !row.hidden;
    if (!row.hidden) $('searchInput').focus();
    else { $('searchInput').value = ''; S.search = ''; render(); }
  });
  $('searchInput').addEventListener('input', (e) => {
    S.search = e.target.value.trim().toLowerCase();
    render();
  });

  // Upload
  $('btnUpload').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

  // Playlists
  $('btnNewPlaylist').addEventListener('click', async () => {
    const name = await promptModal('قائمة تشغيل جديدة', 'مثال: تلاوات · أناشيد · هدوء');
    if (name) createPlaylist(name);
  });
  $('btnBack').addEventListener('click', () => { S.openPlaylistId = null; S.tab = 'playlists'; render(); });
  $('btnDetailMenu').addEventListener('click', () => {
    const pl = S.playlists.find((p) => p.id === S.openPlaylistId);
    if (!pl) return;
    actionSheet(pl.name, [
      { label: '✏ إعادة تسمية', fn: () => renamePlaylist(pl.id) },
      { label: '🗑 حذف القائمة', danger: true, fn: () => deletePlaylist(pl.id) },
    ]);
  });
  $('btnPlayAll').addEventListener('click', () => playFromContext(S.openPlaylistId, null));
  $('btnShuffleAll').addEventListener('click', () => {
    if (!S.shuffle) S.shuffle = true;
    playFromContext(S.openPlaylistId, null);
  });
  $('btnAddToPl').addEventListener('click', async () => {
    const pl = S.playlists.find((p) => p.id === S.openPlaylistId);
    if (!pl) return;
    const ids = await pickSongs('اختر أغانٍ لإضافتها', pl.songIds);
    if (ids && ids.length) addSongsToPlaylist(pl.id, ids);
  });

  // Export / import
  $('btnExport').addEventListener('click', exportBackup);
  $('btnImport').addEventListener('click', () => $('importInput').click());
  $('importInput').addEventListener('change', (e) => {
    if (e.target.files[0]) importBackup(e.target.files[0]);
    e.target.value = '';
  });

  // Mini player
  $('miniPlay').addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });
  $('miniNext').addEventListener('click', (e) => { e.stopPropagation(); nextTrack(false); });
  $('miniOpen').addEventListener('click', () => { $('fullPlayer').hidden = false; updateProgress(); });

  // Full player
  $('fpClose').addEventListener('click', () => { $('fullPlayer').hidden = true; });
  $('btnPlay').addEventListener('click', togglePlay);
  $('btnNext').addEventListener('click', () => nextTrack(false));
  $('btnPrev').addEventListener('click', prevTrack);
  $('btnShuffle').addEventListener('click', toggleShuffle);
  $('btnRepeat').addEventListener('click', cycleRepeat);

  const seekBar = $('seekBar');
  seekBar.addEventListener('input', () => {
    seeking = true;
    const d = audio.duration;
    if (isFinite(d)) $('curTime').textContent = fmtTime((seekBar.value / 1000) * d);
    seekBar.style.setProperty('--fill', (seekBar.value / 10) + '%');
  });
  seekBar.addEventListener('change', () => {
    const d = audio.duration;
    if (isFinite(d)) audio.currentTime = (seekBar.value / 1000) * d;
    seeking = false;
  });

  // Audio events
  audio.addEventListener('timeupdate', () => { updateProgress(); updatePositionState(); saveStateThrottled(); });
  audio.addEventListener('play', renderPlayerUI);
  audio.addEventListener('pause', () => { renderPlayerUI(); saveState(); });
  audio.addEventListener('ended', () => nextTrack(true));
  audio.addEventListener('error', () => {
    if (S.currentSongId && audio.src) toast('تعذّر تشغيل هذا الملف');
  });

  // Save position when leaving the app
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveState(); });
  window.addEventListener('pagehide', saveState);

  // Modal overlay tap-to-close
  $('modalOverlay').addEventListener('click', (e) => {
    if (e.target === $('modalOverlay')) $('modalCancel').click();
  });

  // Service worker (app shell offline)
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('service-worker.js').catch((err) => {
      console.warn('SW registration failed:', err);
    });
  }
}

/* ---------------- Boot ---------------- */
(async function boot() {
  try {
    await openDB();
    await loadAll();
    await restoreState();
  } catch (e) {
    console.error('DB init failed', e);
    toast('تعذّر فتح التخزين المحلي');
  }
  init();
  render();
})();
