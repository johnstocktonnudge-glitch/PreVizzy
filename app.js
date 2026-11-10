'use strict';
/* PreVizzy - quick and dirty previz. All code is here, visible and editable. */

const APP_VER = 'Ver8';          // bump with CACHE in sw.js every release
const MAX_CLIPS = 10;            // up to 10 clips only
const VIDEO_BITRATE = 2500000;   // low bit rate (2.5 Mbps) for recording and saving
const AUDIO_BITRATE = 96000;
const MIN_CLIP = 0.3;            // shortest a trimmed clip can be (seconds)
const MAX_ZOOM = 4;
const PREVIEW_SIDE = 1280;       // longest side of the on-screen preview
const EXPORT_SIDE = 1920;        // 1080p: longest side of the saved video
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'engine.js', 'manifest.webmanifest'];

const $ = id => document.getElementById(id);
const app = $('app'), live = $('live'), view = $('view'), vctx = view.getContext('2d');
const stage = $('stage'), tl = $('tl'), tlClips = $('tl-clips'), playhead = $('playhead');
const recBtn = $('rec'), flipBtn = $('flip'), playBtn = $('playbtn'), saveBtn = $('save'), clearBtn = $('clear');
const pool = [$('pA'), $('pB')];

const ICON_PLAY = '<svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

let clips = [];            // {url, blob, dur, inT, outT, w, h, zoom, px, py}
let head = 0;              // playhead position on the timeline (seconds)
let selected = -1;         // clip being edited (-1 = none)
let tab = 'trim';
let mode = 'live';         // 'live' camera or 'review' of the timeline
let shown = null;          // {v, i}: which player/clip is on screen
let stream = null, facing = 'environment';
let recorder = null, chunks = [], recStart = 0, recTimer = null;
let recording = false, playing = false, exporting = false, playToken = 0;
let exportCancel = false, exportBlob = null, exportName = '';
let latencyEst = 0.2;      // how early to start the next player; learned while playing
let lastLat = 0.1;         // how long the last player took to start

/* ---------- small helpers ---------- */
function say(text, ms) {
  $('msg').textContent = text || '';
  if (text && ms) setTimeout(() => { if ($('msg').textContent === text) $('msg').textContent = ''; }, ms);
}
const fmt = s => (Math.round(s * 10) / 10).toFixed(1) + 's';
const clock = s => { s = Math.max(0, s); return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
const once = (el, ev) => new Promise(r => el.addEventListener(ev, r, { once: true }));
const lenOf = c => c.outT - c.inT;
const minLen = c => Math.min(MIN_CLIP, c.dur / 2);
const JOINS = { b: 6 / 30, f2: 2, f4: 4 };     // blend (6 frames) / 2 second fade / 4 second fade
const joinOf = c => (c && c.join) || 'b';
const wcPossible = () => WC_OK && clips.every(c => !c.ready || c.demux);
// how much clip i overlaps clip i+1 (seconds). Kept inside what the clips can give.
function ovArr() {
  const n = clips.length, out = new Array(n).fill(0);
  if (!wcPossible()) return out;
  let prev = 0;
  for (let i = 0; i < n - 1; i++) {
    const d = JOINS[joinOf(clips[i])];
    const reserve = i + 1 < n - 1 ? Math.min(JOINS[joinOf(clips[i + 1])], 0.4 * lenOf(clips[i + 1])) : 0;
    let o = Math.min(d, lenOf(clips[i]) - prev - 0.02, lenOf(clips[i + 1]) - reserve - 0.02);
    if (d < 1) o = Math.min(o, 0.45 * Math.min(lenOf(clips[i]), lenOf(clips[i + 1])));
    out[i] = Math.max(0, o);
    prev = out[i];
  }
  return out;
}
const startsOf = () => { const ov = ovArr(); let a = 0; return clips.map((c, i) => { const s = a; a += lenOf(c) - ov[i]; return s; }); };
const totalLen = () => { if (!clips.length) return 0; const s = startsOf(); return s[s.length - 1] + lenOf(clips[clips.length - 1]); };
// width a clip takes on the timeline strip
const effLens = () => { const s = startsOf(); return clips.map((c, i) => i < clips.length - 1 ? s[i + 1] - s[i] : lenOf(c)); };

// which clip, and where inside it, is timeline time T
function locate(T) {
  if (!clips.length) return null;
  const s = startsOf();
  let k = 0;
  for (let j = 0; j < clips.length; j++) if (s[j] <= T + 1e-9) k = j;
  const c = clips[k];
  return { i: k, t: c.inT + Math.max(0, Math.min(T - s[k], lenOf(c))) };
}

function pickMime() {
  if (!window.MediaRecorder) return '';
  const list = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'
  ];
  return list.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

/* ---------- camera ---------- */
function stopCamera() {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null;
}

let camTries = 0;
let track = null, zcap = null, zoomNow = 1, backCams = [], lensId = null;
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
async function openStream(video, audio) {
  return navigator.mediaDevices.getUserMedia({ video, audio });
}
async function startCamera() {
  stopCamera();
  track = null; zcap = null;
  say('Starting camera...');
  const base = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }, zoom: true };
  const saved = facing === 'environment' ? lsGet('pv_cam') : null;
  const tries = [];
  if (saved) tries.push({ ...base, deviceId: { exact: saved } });
  tries.push({ ...base, facingMode: { ideal: facing } });
  tries.push({ width: { ideal: 1920 }, height: { ideal: 1080 }, facingMode: { ideal: facing } });
  let noMic = false;
  for (const v of tries) {
    try { stream = await openStream(v, true); break; } catch (e) {
      if (e && e.name === 'NotAllowedError') { stream = null; break; }
      try { stream = await openStream(v, false); noMic = true; break; } catch (e2) { stream = null; }
    }
  }
  if (!stream) say('Camera problem: could not start it  (tap the picture to retry)');
  else if (noMic) say('No microphone: clips will be silent.', 5000);
  if (stream) {
    live.srcObject = stream;
    live.play().catch(() => {});
    if ($('msg').textContent.startsWith('Starting')) say('');
    track = stream.getVideoTracks()[0];
    try { const cp = track.getCapabilities ? track.getCapabilities() : {}; zcap = cp.zoom && cp.zoom.max > cp.zoom.min ? cp.zoom : null; } catch (e) {}
    try { zoomNow = (track.getSettings().zoom) || (zcap ? zcap.min : 1); lensId = track.getSettings().deviceId || null; } catch (e) {}
    findLenses();
    const mine = stream;   // black picture check: if no frames arrive, try once more
    setTimeout(() => {
      if (stream === mine && !recording && live.videoWidth === 0 && camTries < 2) { camTries++; startCamera(); }
      else if (stream === mine && live.videoWidth > 0) camTries = 0;
    }, 2500);
  }
  renderAll();
}

/* ---------- lens + zoom ---------- */
async function findLenses() {
  try {
    const all = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    backCams = all.filter(d => !/front|user/i.test(d.label)).map(d => d.deviceId);
  } catch (e) { backCams = []; }
  renderAll();
}
function updateZoomUI() {
  const z = $('zchip');
  z.hidden = mode !== 'live' || !stream || !zcap;
  z.textContent = zoomNow.toFixed(1) + '\u00d7';
}
let zPending = null, zBusy = false;
function setZoom(v) {
  if (!track || !zcap) return;
  v = Math.max(zcap.min, Math.min(zcap.max, v));
  zoomNow = v; zPending = v; updateZoomUI();
  if (zBusy) return;
  zBusy = true;
  requestAnimationFrame(async function go() {
    const z = zPending; zPending = null;
    try { await track.applyConstraints({ advanced: [{ zoom: z }] }); } catch (e) {}
    if (zPending !== null) requestAnimationFrame(go); else zBusy = false;
  });
}
$('zchip').onclick = e => { e.stopPropagation(); setZoom(zcap ? zcap.min : 1); };
$('lens').onclick = () => {
  if (backCams.length < 2) return;
  const i = backCams.indexOf(lensId);
  lsSet('pv_cam', backCams[(i + 1) % backCams.length]);
  facing = 'environment';
  startCamera();
};
// pinch on the live picture
const pts = new Map(); let pinch = null;
stage.addEventListener('pointerdown', e => {
  if (mode !== 'live' || !zcap) return;
  pts.set(e.pointerId, [e.clientX, e.clientY]);
  if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), z: zoomNow }; }
});
stage.addEventListener('pointermove', e => {
  if (!pts.has(e.pointerId)) return;
  pts.set(e.pointerId, [e.clientX, e.clientY]);
  if (pinch && pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch.d > 10) setZoom(pinch.z * d / pinch.d); }
});
const pinchEnd = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
stage.addEventListener('pointerup', pinchEnd);
stage.addEventListener('pointercancel', pinchEnd);

/* ---------- live camera / review of the timeline ---------- */
function showLive() {
  stopPlay();
  mode = 'live';
  view.hidden = true;
  live.hidden = false;
  renderAll();
}

function showReview() {
  mode = 'review';
  live.hidden = true;
  view.hidden = false;
  renderAll();
}

/* ---------- recording ---------- */
function startRec() {
  if (!stream || clips.length >= MAX_CLIPS || exporting) return;
  closeEdit();
  showLive();
  const mime = pickMime();
  const opts = { videoBitsPerSecond: VIDEO_BITRATE, audioBitsPerSecond: AUDIO_BITRATE, videoKeyFrameIntervalDuration: 500 };
  if (mime) opts.mimeType = mime;
  try {
    recorder = new MediaRecorder(stream, opts);
  } catch (e) {
    say('This browser cannot record video.');
    return;
  }
  chunks = [];
  recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.onstop = onRecStopped;
  recStart = performance.now();
  recorder.start(1000);
  recording = true;
  $('rec-badge').hidden = false;
  recTimer = setInterval(() => {
    const s = Math.floor((performance.now() - recStart) / 1000);
    $('rec-time').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }, 250);
  renderAll();
}

function stopRec() {
  if (recorder && recorder.state !== 'inactive') recorder.stop();
}

async function onRecStopped() {
  clearInterval(recTimer);
  $('rec-badge').hidden = true;
  $('rec-time').textContent = '0:00';
  const measured = (performance.now() - recStart) / 1000;
  const type = (recorder && recorder.mimeType) || pickMime() || 'video/webm';
  const blob = new Blob(chunks, { type });
  chunks = [];
  recording = false;
  if (!blob.size) { say('Nothing recorded.', 3000); renderAll(); return; }
  const url = URL.createObjectURL(blob);
  const info = await probe(url, measured);
  // goes straight to the end of the timeline
  const clip = { url, blob, dur: info.dur, inT: 0, outT: info.dur, w: info.w, h: info.h, zoom: 1, px: 0, py: 0, ready: false, demux: null, abuf: null };
  clips.push(clip);
  head = totalLen();
  renderAll();
  // read the clip's frames and sound ready for the playback engine (a moment, in the background)
  clip.prep = prepareClip(clip).then(() => {
    clip.ready = true;
    if (clip.demux) {
      const wasFull = clip.outT >= clip.dur - 0.001;
      clip.dur = clip.demux.duration;
      clip.outT = wasFull ? clip.dur : Math.min(clip.outT, clip.dur);
      clip.inT = Math.min(clip.inT, clip.outT - minLen(clip));
    }
    renderAll();
  });
}

// Read the true length and picture size of a new clip (falls back to the stopwatch time)
function probe(url, fallback) {
  return new Promise(res => {
    const v = document.createElement('video');
    v.preload = 'metadata'; v.muted = true; v.playsInline = true;
    let done = false;
    const finish = d => { if (done) return; done = true; const out = { dur: d, w: v.videoWidth || 1920, h: v.videoHeight || 1080 }; v.removeAttribute('src'); v.load(); res(out); };
    setTimeout(() => finish(fallback), 2000);
    v.onloadedmetadata = () => {
      if (isFinite(v.duration) && v.duration > 0) return finish(v.duration);
      v.onseeked = () => finish(isFinite(v.duration) && v.duration > 0 ? v.duration : fallback);
      v.currentTime = 1e101;            // WebM trick: forces the browser to work out the length
    };
    v.onerror = () => finish(fallback);
    v.src = url;
  });
}

/* ---------- loading and seeking a clip into a <video> ---------- */
function setSrc(v, c) {
  if (v.dataset.url !== c.url) { v.dataset.url = c.url; v.src = c.url; }
}

function seekTo(v, t) {
  return new Promise(r => {
    if (Math.abs(v.currentTime - t) < 0.01) return r();
    const done = () => { v.removeEventListener('seeked', done); r(); };
    v.addEventListener('seeked', done);
    v.currentTime = t;
    setTimeout(done, 1500);
  });
}

async function loadInto(v, c, t) {
  setSrc(v, c);
  if (v.readyState < 1) await Promise.race([once(v, 'loadedmetadata'), once(v, 'error')]);
  if (!isFinite(v.duration)) { v.currentTime = 1e101; await Promise.race([once(v, 'seeked'), new Promise(r => setTimeout(r, 1500))]); }
  await seekTo(v, t);
}

/* ---------- drawing a frame (zoom + reframe are applied here, for preview AND saving) ---------- */
function srcSize(s) {
  return s.videoWidth ? [s.videoWidth, s.videoHeight] : [s.displayWidth || s.codedWidth || 0, s.displayHeight || s.codedHeight || 0];
}

function drawFrame(ctx, W, H, v, c, alpha, over) {
  const [vw, vh] = srcSize(v);
  if (!vw || !vh) return;
  const z = c.zoom || 1;
  const sw = vw / z, sh = vh / z;                       // the part of the picture we keep
  const sx = (vw - sw) * (0.5 + 0.5 * (c.px || 0));
  const sy = (vh - sh) * (0.5 + 0.5 * (c.py || 0));
  const s = Math.min(W / sw, H / sh);
  const dw = sw * s, dh = sh * s;
  if (!over) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
  ctx.globalAlpha = alpha === undefined ? 1 : alpha;
  ctx.drawImage(v, sx, sy, sw, sh, (W - dw) / 2, (H - dh) / 2, dw, dh);
  ctx.globalAlpha = 1;
}

function sizeFor(side) {
  const w = (clips[0] && clips[0].w) || 1920, h = (clips[0] && clips[0].h) || 1080;
  const k = Math.min(1, side / Math.max(w, h));
  return [Math.round(w * k / 2) * 2, Math.round(h * k / 2) * 2];
}

function drawView(v, c, alpha, over) {
  const [W, H] = sizeFor(PREVIEW_SIDE);
  if (view.width !== W || view.height !== H) { view.width = W; view.height = H; }
  drawFrame(vctx, W, H, v, c, alpha, over);
}

function redraw() {
  if (shown && clips[shown.i]) drawView(shown.src, clips[shown.i]);
}

/* ---------- show one frame (used when scrubbing and editing) ---------- */
function setShown(sh) {
  if (shown && shown.own && shown.src && shown.src.close) { try { shown.src.close(); } catch (_) {} }
  shown = sh;
}
function useWC() { return WC_OK && clips.length > 0 && clips.every(c => c.ready && c.demux); }
function refreshStill() { const loc = locate(head); if (loc) queueShow(loc.i, loc.t); }

let showBusy = false, showWant = null;
function queueShow(i, t) {
  showWant = { i, t };
  if (showBusy) return;
  showBusy = true;
  (async () => {
    try {
      while (showWant) {
        const w = showWant; showWant = null;
        const c = clips[w.i];
        if (!c) continue;
        if (useWC()) {                                  // decoded frame (fast, exact)
          const f = await wcFrameAt(c, w.t);
          if (!f) continue;
          setShown({ src: f, i: w.i, own: true });
          drawView(f, c);
        } else {                                        // video-player method
          await loadInto(pool[0], c, w.t);
          await new Promise(r => requestAnimationFrame(r));
          setShown({ src: pool[0], i: w.i });
          drawView(pool[0], c);
        }
      }
    } catch (e) { console.warn('show frame', e); }
    finally { showBusy = false; }
  })();
}

function goTo(T) {                       // move the playhead and show that frame
  const total = totalLen();
  head = Math.max(0, Math.min(T, total));
  const loc = locate(head);
  if (!loc) return;
  showReview();
  queueShow(loc.i, loc.t);
  updatePlayhead();
}

/* ---------- the timeline strip ---------- */
function renderTimeline() {
  tlClips.innerHTML = '';
  const old = tl.querySelector('.empty'); if (old) old.remove();
  if (!clips.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'Press record. Your clips appear here.';
    tl.appendChild(e);
    rects = [];
    return;
  }
  const playIdx = -1;
  const eff = effLens();
  clips.forEach((c, i) => {
    const b = document.createElement('div');
    b.className = 'clip' + (i === selected ? ' sel' : '') + (i === playIdx ? ' now' : '') + (i === movingIdx ? ' moving' : '');
    b.style.flexGrow = Math.max(0.05, eff[i]);
    const jn = i < clips.length - 1 && joinOf(c) !== 'b' ? '<span class="jn">' + (joinOf(c) === 'f2' ? '2s' : '4s') + '</span>' : '';
    b.innerHTML = '<b>' + (i + 1) + '</b>' + fmt(lenOf(c)) + jn;
    tlClips.appendChild(b);
  });
  cacheRects();
}

let movingIdx = -1;
let rects = [];            // where each clip block sits (measured once, not every frame)
function cacheRects() {
  const tr = tl.getBoundingClientRect();
  rects = [...tlClips.children].map(b => { const r = b.getBoundingClientRect(); return { left: r.left - tr.left, width: r.width }; });
}

function markNow(idx) {
  [...tlClips.children].forEach((b, i) => b.classList.toggle('now', i === idx));
}

function updatePlayhead() {
  const txt = clock(head) + ' / ' + clock(totalLen());
  if ($('time').textContent !== txt) $('time').textContent = txt;
  if (!rects.length || rects.length !== clips.length) { playhead.style.display = 'none'; return; }
  playhead.style.display = '';
  const loc = locate(head), starts = startsOf(), r = rects[loc.i];
  const el = effLens()[loc.i];
  const frac = el > 0 ? Math.max(0, Math.min(1, (head - starts[loc.i]) / el)) : 0;
  playhead.style.transform = 'translateX(' + (r.left + frac * r.width) + 'px)';
}

// which clip is under x, and how far along it
function hit(x) {
  const blocks = [...tlClips.children];
  let best = null, bd = 1e9;
  blocks.forEach((b, i) => {
    const r = b.getBoundingClientRect();
    const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    if (d < bd) { bd = d; best = { i, frac: Math.max(0, Math.min(1, (x - r.left) / r.width)) }; }
  });
  return best;
}
const xToT = x => { const h = hit(x); if (!h) return 0; return startsOf()[h.i] + h.frac * effLens()[h.i]; };

// finger on the timeline: drag = scrub, tap = open that clip for editing
let tp = null;
function swapClips(x, y) {
  [clips[x], clips[y]] = [clips[y], clips[x]];
  if (selected === x) selected = y; else if (selected === y) selected = x;
  movingIdx = y;
  head = startsOf()[y];
  renderTimeline();
  updatePlayhead();
  renderEdit();
  showReview();
  refreshStill();
}
tl.addEventListener('pointerdown', e => {
  if (!clips.length || recording || exporting) return;
  tl.setPointerCapture(e.pointerId);
  tp = { x: e.clientX, moved: false, mv: false, ax: e.clientX, idx: -1 };
  const mine = tp;
  mine.timer = setTimeout(() => {                       // press and hold: this clip can now be moved
    if (tp !== mine || mine.moved) return;
    const h = hit(mine.x);
    if (!h) return;
    stopPlay();
    mine.mv = true; mine.idx = h.i; movingIdx = h.i;
    if (navigator.vibrate) navigator.vibrate(30);
    renderTimeline();
    say('Swipe the clip left or right to move it', 1800);
  }, 800);
});
tl.addEventListener('pointermove', e => {
  if (!tp) return;
  if (tp.mv) {
    const dx = e.clientX - tp.ax;
    if (Math.abs(dx) > 45) {
      const j = tp.idx + (dx > 0 ? 1 : -1);
      if (j >= 0 && j < clips.length) { swapClips(tp.idx, j); tp.idx = j; }
      tp.ax = e.clientX;
    }
    return;
  }
  if (!tp.moved && Math.abs(e.clientX - tp.x) > 8) { tp.moved = true; clearTimeout(tp.timer); stopPlay(); }
  if (tp.moved) goTo(xToT(e.clientX));
});
const tlEnd = e => {
  if (!tp) return;
  clearTimeout(tp.timer);
  const wasTap = !tp.moved && !tp.mv;
  const wasMove = tp.mv;
  tp = null;
  if (wasMove) { movingIdx = -1; renderTimeline(); return; }
  if (wasTap && e.type === 'pointerup') {
    const h = hit(e.clientX);
    if (h) { stopPlay(); goTo(xToT(e.clientX)); openEdit(h.i); }
  }
};
tl.addEventListener('pointerup', tlEnd);
tl.addEventListener('pointercancel', tlEnd);
window.addEventListener('resize', () => { cacheRects(); updatePlayhead(); renderTrimBar(); });

/* ---------- editing a clip: Trim, Zoom, Reframe ---------- */
function openEdit(i) {
  selected = i;
  $('edit').hidden = false;
  setTab(tab);
  renderAll();
}

function closeEdit() {
  selected = -1;
  $('edit').hidden = true;
  renderAll();
}

function setTab(name) {
  tab = name;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  ['trim', 'zoom', 'reframe', 'join'].forEach(n => { $('pane-' + n).hidden = n !== name; });
  $('tinfo').hidden = name !== 'trim';
  renderEdit();
}
document.querySelectorAll('.tab').forEach(b => { b.onclick = () => setTab(b.dataset.tab); });
$('edit-done').onclick = closeEdit;

function renderEdit() {
  const c = clips[selected];
  if (!c) return;
  $('edit-title').textContent = 'Clip ' + (selected + 1);
  renderTrimBar();
  $('zoom').value = c.zoom;
  $('zoomv').textContent = c.zoom.toFixed(1) + 'x';
  const last = selected >= clips.length - 1;
  document.querySelectorAll('.jbtn').forEach(b => { b.classList.toggle('on', !last && joinOf(c) === b.dataset.join); b.disabled = last; });
  $('jhint').textContent = last ? 'Last clip: nothing after it.' : 'Clip ' + (selected + 1) + ' into ' + (selected + 2) + ':';
  $('rhint').textContent = c.zoom > 1 ? 'Drag the picture to move it.' : 'Zoom in first (Zoom tab), then drag the picture.';
}

function renderTrimBar() {
  const c = clips[selected];
  if (!c || $('edit').hidden) return;
  const w = $('tbar').clientWidth || 1;
  const a = c.inT / c.dur * w, b = c.outT / c.dur * w;
  $('tsel').style.left = a + 'px'; $('tsel').style.width = Math.max(0, b - a) + 'px';
  $('th-in').style.left = a + 'px'; $('th-out').style.left = b + 'px';
  $('tinfo').textContent = fmt(c.inT) + ' - ' + fmt(c.outT) + ' (' + fmt(lenOf(c)) + ')';
}

// how much length clip i needs for the fades on its two sides (0 when it only has plain blends)
function fadeNeed(i, trial) {
  const n = clips.length, j = k => (trial && trial.k === k) ? trial.kind : joinOf(clips[k]);
  const L = i > 0 ? j(i - 1) : null, R = i < n - 1 ? j(i) : null;
  if ((!L || L === 'b') && (!R || R === 'b')) return 0;
  return (L ? JOINS[L] : 0) + (R ? JOINS[R] : 0);
}
document.querySelectorAll('.jbtn').forEach(b => {
  b.onclick = () => {
    const i = selected, kind = b.dataset.join;
    if (i < 0 || i >= clips.length - 1) return;
    const t = { k: i, kind };
    if (fadeNeed(i, t) > lenOf(clips[i]) + 1e-6 || fadeNeed(i + 1, t) > lenOf(clips[i + 1]) + 1e-6) { say('Clip not long enough', 2200); return; }
    clips[i].join = kind;
    stopPlay();
    renderEdit(); renderTimeline(); updatePlayhead(); refreshStill();
  };
});

// Trim: drag a yellow handle (nearest one moves)
let tdrag = null;
const tbar = $('tbar');
function moveTrim(e) {
  const c = clips[selected]; if (!c) return;
  const r = tbar.getBoundingClientRect();
  const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * c.dur;
  const need = Math.max(minLen(c), fadeNeed(selected));
  if (tdrag === 'in') { const lim = c.outT - need; if (t > lim && need > minLen(c)) say('Clip not long enough', 1500); c.inT = Math.max(0, Math.min(t, lim)); }
  else { const lim = c.inT + need; if (t < lim && need > minLen(c)) say('Clip not long enough', 1500); c.outT = Math.min(c.dur, Math.max(t, lim)); }
  stopPlay();
  showReview();
  queueShow(selected, tdrag === 'in' ? c.inT : Math.max(c.inT, c.outT - 0.05));
  head = startsOf()[selected] + (tdrag === 'in' ? 0 : Math.max(0, lenOf(c) - 0.05));
  renderTrimBar();
  renderTimeline();
  updatePlayhead();
}
tbar.addEventListener('pointerdown', e => {
  const c = clips[selected]; if (!c) return;
  const r = tbar.getBoundingClientRect();
  const xin = r.left + c.inT / c.dur * r.width, xout = r.left + c.outT / c.dur * r.width;
  tdrag = Math.abs(e.clientX - xin) <= Math.abs(e.clientX - xout) ? 'in' : 'out';
  tbar.setPointerCapture(e.pointerId);
  moveTrim(e);
});
tbar.addEventListener('pointermove', e => { if (tdrag) moveTrim(e); });
tbar.addEventListener('pointerup', () => { tdrag = null; });
tbar.addEventListener('pointercancel', () => { tdrag = null; });

// Zoom: slider
$('zoom').oninput = () => {
  const c = clips[selected]; if (!c) return;
  c.zoom = Math.min(MAX_ZOOM, Math.max(1, +$('zoom').value));
  if (c.zoom === 1) { c.px = 0; c.py = 0; }
  $('zoomv').textContent = c.zoom.toFixed(1) + 'x';
  showClipFrameForEdit();
};
$('zreset').onclick = () => { const c = clips[selected]; if (!c) return; c.zoom = 1; c.px = 0; c.py = 0; renderEdit(); showClipFrameForEdit(); };
$('rreset').onclick = () => { const c = clips[selected]; if (!c) return; c.px = 0; c.py = 0; showClipFrameForEdit(); };

// make sure the edited clip's picture is on screen, then redraw it
function showClipFrameForEdit() {
  const c = clips[selected]; if (!c) return;
  stopPlay();
  showReview();
  if (shown && shown.i === selected) { redraw(); return; }
  const loc = locate(head);
  queueShow(selected, loc && loc.i === selected ? loc.t : c.inT);
}

// Reframe: drag the picture (works once zoomed in)
let pan = null;
stage.addEventListener('pointerdown', e => {
  if (selected < 0 || tab === 'trim' || mode !== 'review' || !shown) return;
  const c = clips[selected];
  if (!c || c.zoom <= 1) return;
  pan = { x: e.clientX, y: e.clientY, px: c.px, py: c.py };
  stage.setPointerCapture(e.pointerId);
});
stage.addEventListener('pointermove', e => {
  if (!pan) return;
  const c = clips[selected];
  const [vw, vh] = srcSize(shown.src);
  const sw = vw / c.zoom, sh = vh / c.zoom;
  const cw = stage.clientWidth, ch = stage.clientHeight;
  const dispW = Math.min(cw, ch * vw / vh), dispH = dispW * vh / vw;
  const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
  // finger right = picture right = crop window moves left
  c.px = Math.max(-1, Math.min(1, pan.px - (dx * sw / dispW) / ((vw - sw) / 2)));
  c.py = Math.max(-1, Math.min(1, pan.py - (dy * sh / dispH) / ((vh - sh) / 2)));
  redraw();
});
const panEnd = () => { pan = null; };
stage.addEventListener('pointerup', panEnd);
stage.addEventListener('pointercancel', panEnd);

/* ---------- the sequencer: plays clips back to back with clean cuts ----------
   Two players are used. While one plays, the next is already loaded and sitting on
   its first frame. A little before the cut it is started, so it is up and running
   when the cut arrives; at the cut the picture simply switches to it.
   o = { els, audio, startIdx, startT, stopped(), draw(v,i,c), progress(i,t), onClip(i) } */
async function runTimeline(o) {
  const { els, audio, stopped, draw } = o;
  let cur = o.startIdx, v = els[cur % 2];
  await loadInto(v, clips[cur], o.startT);
  if (stopped()) return;
  audio.on(v); audio.off(els[(cur + 1) % 2]);
  await v.play().catch(() => {});
  return new Promise(resolve => {
    let nv = null, ready = false, started = false, tStart = 0, pos0 = 0, measured = false;
    let lastT = v.currentTime, lastChange = performance.now();
    const prep = () => {
      const n = clips[cur + 1];
      if (!n || nv) return;
      nv = els[(cur + 1) % 2];
      pos0 = Math.max(0, n.inT - Math.max(0, latencyEst - lastLat));   // park it so it lands on its first frame at the cut
      ready = false; started = false; measured = false;
      loadInto(nv, n, pos0).then(() => { ready = true; });
    };
    const tick = () => {
      if (stopped()) { els.forEach(e => e.pause()); return resolve(); }
      const c = clips[cur], next = clips[cur + 1];
      const t = v.currentTime, now = performance.now();
      if (t !== lastT) { lastT = t; lastChange = now; }
      draw(v, cur, c);
      o.progress(cur, Math.max(0, t - c.inT));
      const remain = c.outT - t;
      const over = v.ended || now - lastChange > 4000;
      if (next) {
        if (t - c.inT > 0.3 || remain < 1.2) prep();                   // (not at the cut itself: loading is heavy)
        if (!started && ready && remain <= latencyEst) {                // start the next player early
          started = true; tStart = now; audio.off(nv); nv.play().catch(() => {});
        }
        if (started && !measured && nv.currentTime > pos0 + 0.004) {   // learn how long starting takes
          measured = true;
          lastLat = (now - tStart) / 1000;
          latencyEst = Math.max(0.06, Math.min(0.8, lastLat * 1.1 + 0.03));
        }
        if (remain <= 0.012 || over) {                                 // the cut
          if (!ready && !over && remain > -0.5) { requestAnimationFrame(tick); return; }
          if (!started) nv.play().catch(() => {});
          audio.on(nv); audio.off(v); v.pause();
          cur++; v = nv; nv = null; lastT = v.currentTime; lastChange = now;
          if (o.onClip) o.onClip(cur);
        }
      } else if (remain <= 0.03 || over) { v.pause(); return resolve(); }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

/* ---------- play / pause ---------- */
function stopPlay() {
  playToken++;
  const was = playing;
  if (playing) { playing = false; pool.forEach(p => p.pause()); }
  renderAll();
  if (was && useWC()) refreshStill();
}

async function togglePlay() {
  if (playing) { stopPlay(); return; }
  if (!clips.length || recording || exporting) return;
  if (WC_OK) getAC();                                   // sound is allowed because this runs inside the tap
  if (clips.some(c => !c.ready)) await Promise.all(clips.map(c => c.prep));
  if (head >= totalLen() - 0.05) head = 0;
  const loc = locate(head);
  if (useWC()) {
    playing = true;
    const token = ++playToken;
    showReview();
    renderAll();
    const starts = startsOf();
    await runTimelineWC({
      startIdx: loc.i, startT: loc.t, out: getAC().destination,
      stopped: () => token !== playToken,
      draw: (fr, c, al, over) => drawView(fr, c, al, over),
      progress: (i, t) => { head = starts[i] + t; updatePlayhead(); },
      onClip: i => markNow(i)
    });
    if (token === playToken) { playing = false; head = Math.min(head, totalLen()); renderAll(); refreshStill(); }
    return;
  }
  playing = true;
  const token = ++playToken;
  showReview();
  // start both players inside the tap so the phone allows sound on each
  const a = pool[loc.i % 2], b = pool[(loc.i + 1) % 2];
  setSrc(a, clips[loc.i]); a.muted = false; a.play().catch(() => {});
  if (clips[loc.i + 1]) { setSrc(b, clips[loc.i + 1]); b.muted = true; b.play().catch(() => {}); b.pause(); }
  const starts = startsOf();
  renderAll();
  await runTimeline({
    els: pool,
    audio: { on: v => { v.muted = false; }, off: v => { v.muted = true; } },
    startIdx: loc.i, startT: loc.t,
    stopped: () => token !== playToken,
    draw: (v, i, c) => { setShown({ src: v, i }); drawView(v, c); },
    progress: (i, t) => { head = starts[i] + t; updatePlayhead(); },
    onClip: i => markNow(i)
  });
  if (token === playToken) { playing = false; head = Math.min(head, totalLen()); renderAll(); }
}

/* ---------- save: play the timeline once into a low bit rate MP4 ---------- */
async function saveVideo() {
  if (!clips.length || recording || exporting) return;
  stopPlay();
  closeEdit();
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) { say('This browser cannot save video.', 5000); return; }
  exporting = true; exportCancel = false; exportBlob = null;
  renderAll();
  $('overlay').hidden = false;
  $('ov-title').textContent = 'Saving video';
  $('ov-text').textContent = 'Keep this screen open. It saves in real time.';
  $('ov-save').hidden = true;
  $('ov-close').textContent = 'Cancel';
  $('bar-fill').style.width = '0%';

  // audio goes into the recording only (not the speaker). Made inside the tap so the phone allows it.
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = WC_OK ? getAC() : new AC();
  ac.resume();
  const dest = ac.createMediaStreamDestination();
  if (clips.some(c => !c.ready)) await Promise.all(clips.map(c => c.prep));
  const wc = useWC();                       // frame engine, or the video-player method as a fallback
  const gains = new Map();
  const els = wc ? [] : [0, 1].map(() => {
    const v = document.createElement('video');
    v.playsInline = true; v.preload = 'auto';
    $('pool').appendChild(v);
    const g = ac.createGain();
    ac.createMediaElementSource(v).connect(g);
    g.connect(dest);
    gains.set(v, g);
    return v;
  });
  if (!wc) {
    setSrc(els[0], clips[0]); els[0].play().catch(() => {});
    if (clips[1]) { setSrc(els[1], clips[1]); els[1].play().catch(() => {}); els[1].pause(); }
  }

  try {
    const [W, H] = sizeFor(EXPORT_SIDE);
    const canvas = $('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);

    const vs = canvas.captureStream(30);
    const out = new MediaStream([...vs.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mime = pickMime();
    const opts = { videoBitsPerSecond: VIDEO_BITRATE, audioBitsPerSecond: AUDIO_BITRATE };
    if (mime) opts.mimeType = mime;
    const rec = new MediaRecorder(out, opts);
    const parts = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) parts.push(e.data); };
    const stopped = new Promise(r => { rec.onstop = r; });
    rec.start(1000);

    const total = totalLen(), starts = startsOf();
    const progress = (i, t) => { $('bar-fill').style.width = Math.min(100, (starts[i] + t) / total * 100) + '%'; };
    if (wc) {
      await runTimelineWC({
        startIdx: 0, startT: clips[0].inT, out: dest,
        stopped: () => exportCancel,
        draw: (fr, c, al, over) => drawFrame(ctx, W, H, fr, c, al, over),
        progress
      });
    } else {
      await runTimeline({
        els,
        audio: { on: v => { gains.get(v).gain.value = 1; }, off: v => { gains.get(v).gain.value = 0; } },
        startIdx: 0, startT: clips[0].inT,
        stopped: () => exportCancel,
        draw: (v, i, c) => drawFrame(ctx, W, H, v, c),
        progress
      });
    }
    await new Promise(r => setTimeout(r, 250));   // let the last frame land
    rec.stop();
    await stopped;
    els.forEach(v => { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); });
    if (!WC_OK) ac.close();
    refreshStill();
    if (exportCancel) { finishExport(); return; }

    const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
    exportBlob = new Blob(parts, { type });
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    const d = new Date(), p2 = n => String(n).padStart(2, '0');
    exportName = 'PreVizzy_' + d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate()) + '_' + p2(d.getHours()) + p2(d.getMinutes()) + p2(d.getSeconds()) + '.' + ext;
    $('bar-fill').style.width = '100%';
    $('ov-title').textContent = 'Video ready';
    $('ov-text').textContent = exportName + '  -  ' + (exportBlob.size / 1048576).toFixed(1) + ' MB'
      + (ext === 'webm' ? '  (this browser cannot make MP4, so it is WebM)' : '');
    $('ov-save').hidden = false;
    $('ov-close').textContent = 'Close';
  } catch (e) {
    console.error(e);
    $('ov-title').textContent = 'Could not save';
    $('ov-text').textContent = 'Something went wrong: ' + (e && e.message ? e.message : e);
    $('ov-close').textContent = 'Close';
    els.forEach(v => v.remove());
    if (!WC_OK) { try { ac.close(); } catch (_) {} }
  }
}

function finishExport() {
  exporting = false;
  $('overlay').hidden = true;
  exportBlob = null;
  renderAll();
}

$('ov-close').onclick = () => {
  if ($('ov-title').textContent === 'Saving video') exportCancel = true;   // cancel while saving
  else finishExport();
};

// Save to device. On iPhone/iPad this opens the share sheet (Save Video / Save to Files);
// everywhere else it is a normal download.
$('ov-save').onclick = async () => {
  if (!exportBlob) return;
  const file = new File([exportBlob], exportName, { type: exportBlob.type });
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(exportBlob);
  a.download = exportName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
};

/* ---------- clear ---------- */
function clearAll() {
  if (!clips.length) { say('Nothing to clear.', 2000); $('menu').hidden = true; return; }
  if (!confirm('Delete all ' + clips.length + ' clips from the app and free their space?')) return;
  stopPlay();
  closeEdit();
  clips.forEach(c => URL.revokeObjectURL(c.url));
  clips = []; head = 0; setShown(null);
  pool.forEach(p => { p.removeAttribute('src'); delete p.dataset.url; });
  $('menu').hidden = true;
  showLive();
}

/* ---------- screen state ---------- */
function renderAll() {
  $('count').textContent = clips.length + '/' + MAX_CLIPS;
  const full = clips.length >= MAX_CLIPS;
  app.classList.toggle('recording', recording);
  app.classList.toggle('editing', selected >= 0);
  recBtn.classList.toggle('on', recording);
  recBtn.disabled = !stream || exporting || (full && !recording);
  flipBtn.disabled = recording || exporting || mode === 'review';
  flipBtn.style.visibility = mode === 'review' ? 'hidden' : '';
  const lensOk = mode === 'live' && facing === 'environment' && backCams.length > 1;
  $('lens').hidden = !lensOk;
  if (lensOk) { const i = backCams.indexOf(lensId); $('lens').textContent = 'Lens ' + ((i < 0 ? 0 : i) + 1) + '/' + backCams.length; $('lens').disabled = recording || exporting; }
  updateZoomUI();
  playBtn.disabled = !clips.length || recording || exporting;
  const want = playing ? 'pause' : 'play';
  if (playBtn.dataset.icon !== want) { playBtn.dataset.icon = want; playBtn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY; }
  $('center-play').hidden = !(mode === 'review' && !playing && !recording && !exporting && selected < 0 && clips.length > 0);
  saveBtn.disabled = !clips.length || recording || exporting;
  clearBtn.disabled = !clips.length || recording || exporting;
  $('golive').hidden = mode !== 'review' || recording;
  if (full && !recording) say('10 clips. Clear all (menu) to start again.');
  else if ($('msg').textContent.startsWith('10 clips')) say('');
  $('engine-info').textContent = !WC_OK ? 'Engine: video player (this phone lacks frame decoding)'
    : !clips.length ? 'Engine: frame decoder (ready)'
    : clips.some(c => !c.ready) ? 'Engine: preparing clip...'
    : useWC() ? 'Engine: frame decoder (seamless cuts)'
    : 'Engine: video player. ' + ((clips.find(c => c.why) || {}).why || '');
  renderTimeline();
  markNow(playing ? (locate(head) || {}).i : -1);
  updatePlayhead();
  if (selected >= 0) renderEdit();
}

/* ---------- buttons ---------- */
recBtn.onclick = () => (recording ? stopRec() : startRec());
flipBtn.onclick = () => { facing = facing === 'environment' ? 'user' : 'environment'; startCamera(); };
playBtn.onclick = togglePlay;
$('center-play').innerHTML = ICON_PLAY;
$('center-play').onclick = e => { e.stopPropagation(); togglePlay(); };
saveBtn.onclick = saveVideo;
clearBtn.onclick = clearAll;
const monoBtn = $('mono');
function applyMono(on) { app.classList.toggle('mono', on); monoBtn.classList.toggle('on', on); }
applyMono(lsGet('pv_mono') === '1');
monoBtn.onclick = () => { const on = !app.classList.contains('mono'); lsSet('pv_mono', on ? '1' : '0'); applyMono(on); };
$('golive').onclick = () => { closeEdit(); showLive(); };
$('more').onclick = () => { $('menu').hidden = !$('menu').hidden; };
stage.addEventListener('click', e => {
  if (e.target.closest('button')) return;
  $('menu').hidden = true;
  if (playing) { stopPlay(); return; }
  if (!stream && !recording && !exporting && mode === 'live') startCamera();
});

/* ---------- updates ---------- */
$('ver').textContent = 'PreVizzy ' + APP_VER;
$('update').onclick = async () => {
  const m = $('update-msg');
  m.textContent = 'Checking...';
  try {
    const r = await fetch('app.js?nocache=' + Date.now(), { cache: 'no-store' });
    const found = (await r.text()).match(/APP_VER\s*=\s*'([^']+)'/);
    if (found && found[1] !== APP_VER) {
      if (clips.length && !confirm(found[1] + ' is ready. Updating clears your clips. Update now?')) { m.textContent = found[1] + ' is ready'; return; }
      m.textContent = 'Updating to ' + found[1] + '...';
      if (navigator.serviceWorker) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(g => g.unregister()));
      }
      if (window.caches) { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); }
      await Promise.all(FILES.map(f => fetch(f, { cache: 'reload' }).catch(() => {})));
      location.reload();
    } else {
      m.textContent = 'Up to date (' + APP_VER + ')';
    }
  } catch (e) {
    m.textContent = 'Cannot check (offline?)';
  }
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// let go of the camera when the app closes or reloads, so the next start is clean
window.addEventListener('pagehide', stopCamera);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !recording && !exporting && mode === 'live') {
    const t = stream && stream.getVideoTracks()[0];
    if (!t || t.readyState === 'ended') startCamera();
  }
});

if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) say('This browser cannot use the camera.');
else startCamera();
renderAll();
