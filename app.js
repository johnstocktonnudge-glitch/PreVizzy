'use strict';
/* PreVizzy - quick and dirty previz. All code is here, visible and editable. */

const APP_VER = 'Ver1';          // bump with CACHE in sw.js every release
const MAX_CLIPS = 10;            // up to 10 clips only
const VIDEO_BITRATE = 2500000;   // low bit rate (2.5 Mbps) for recording and saving
const AUDIO_BITRATE = 96000;
const MIN_CLIP = 0.3;            // shortest a trimmed clip can be (seconds)
const MAX_SIDE = 1920;           // 1080p: longest side of the saved video
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest'];

const $ = id => document.getElementById(id);
const live = $('live'), play = $('play'), tl = $('timeline');
const recBtn = $('rec'), flipBtn = $('flip'), playBtn = $('playall');
const saveBtn = $('save'), clearBtn = $('clear'), backLive = $('backlive');
const trimBox = $('trim'), trimIn = $('trim-in'), trimOut = $('trim-out'), trimInfo = $('trim-info');

let clips = [];            // {url, blob, dur, inT, outT}
let selected = -1;         // selected clip index
let playingIdx = -1;       // clip being played in "Play all"
let stream = null, facing = 'environment';
let recorder = null, chunks = [], recStart = 0, recTimer = null;
let recording = false, playing = false, exporting = false, playToken = 0;
let exportCancel = false, exportBlob = null, exportName = '';

/* ---------- small helpers ---------- */
function say(text, ms) {
  $('msg').textContent = text || '';
  if (text && ms) setTimeout(() => { if ($('msg').textContent === text) $('msg').textContent = ''; }, ms);
}
const fmt = s => (Math.round(s * 10) / 10).toFixed(1) + 's';
const once = (el, ev) => new Promise(r => el.addEventListener(ev, r, { once: true }));

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

async function startCamera() {
  stopCamera();
  const video = { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: true });
  } catch (e) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      say('No microphone: clips will be silent.', 5000);
    } catch (e2) {
      say('Camera blocked. Allow camera access for this app.');
      stream = null;
    }
  }
  if (stream) {
    live.srcObject = stream;
    live.play().catch(() => {});
    say('');
  }
  renderAll();
}

function showLive() {
  stopPlay();
  play.pause();
  play.hidden = true;
  live.hidden = false;
  backLive.hidden = true;
}

function showPlayer() {
  live.hidden = true;
  play.hidden = false;
  backLive.hidden = false;
}

/* ---------- recording ---------- */
function startRec() {
  if (!stream || clips.length >= MAX_CLIPS || exporting) return;
  showLive();
  const mime = pickMime();
  const opts = { videoBitsPerSecond: VIDEO_BITRATE, audioBitsPerSecond: AUDIO_BITRATE };
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
  const dur = await probeDuration(url, measured);
  clips.push({ url, blob, dur, inT: 0, outT: dur });   // goes straight to the end of the timeline
  selected = clips.length - 1;
  renderAll();
  tl.scrollLeft = tl.scrollWidth;
}

// Read the true duration of a new clip (falls back to the stopwatch time)
function probeDuration(url, fallback) {
  return new Promise(res => {
    const v = document.createElement('video');
    v.preload = 'metadata'; v.muted = true; v.playsInline = true;
    let done = false;
    const finish = d => { if (done) return; done = true; v.removeAttribute('src'); v.load(); res(d); };
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

/* ---------- timeline ---------- */
function renderTimeline() {
  tl.innerHTML = '';
  if (!clips.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'Press record. Clips appear here.';
    tl.appendChild(e);
    return;
  }
  clips.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'clip' + (i === selected ? ' sel' : '') + (i === playingIdx ? ' now' : '');
    b.style.width = Math.max(64, (c.outT - c.inT) * 18) + 'px';
    b.innerHTML = '<b>' + (i + 1) + '</b>' + fmt(c.outT - c.inT);
    b.disabled = recording || exporting;
    b.onclick = () => selectClip(i);
    tl.appendChild(b);
  });
}

async function selectClip(i) {
  stopPlay();
  selected = i;
  renderAll();
  const c = clips[i];
  showPlayer();
  play.muted = false;
  await loadInto(play, c, c.inT);
}

function renderTrim() {
  const c = clips[selected];
  trimBox.hidden = !c || recording;
  if (!c) return;
  trimIn.max = trimOut.max = c.dur;
  trimIn.value = c.inT;
  trimOut.value = c.outT;
  trimInfo.textContent = 'Clip ' + (selected + 1) + ': ' + fmt(c.inT) + ' to ' + fmt(c.outT) + '  (' + fmt(c.outT - c.inT) + ')';
}

function minLen(c) { return Math.min(MIN_CLIP, c.dur / 2); }

trimIn.oninput = () => {
  const c = clips[selected]; if (!c) return;
  c.inT = Math.max(0, Math.min(+trimIn.value, c.outT - minLen(c)));
  afterTrim(c, c.inT);
};
trimOut.oninput = () => {
  const c = clips[selected]; if (!c) return;
  c.outT = Math.min(c.dur, Math.max(+trimOut.value, c.inT + minLen(c)));
  afterTrim(c, Math.max(c.inT, c.outT - 0.1));
};
function afterTrim(c, showAt) {
  stopPlay();
  showPlayer();
  setSrc(play, c);
  if (play.readyState >= 1) play.currentTime = showAt;
  renderTrim();
  renderTimeline();
}

/* ---------- play the whole timeline ---------- */
function stopPlay() {
  playToken++;
  if (playing) { playing = false; playingIdx = -1; play.pause(); }
  playBtn.textContent = 'Play all';
  renderTimeline();
}

async function playAll() {
  if (playing) { stopPlay(); return; }
  if (!clips.length || recording || exporting) return;
  playing = true;
  const token = ++playToken;
  playBtn.textContent = 'Stop';
  showPlayer();
  play.muted = false;
  setSrc(play, clips[0]);
  play.play().catch(() => {});          // started inside the tap so the phone allows sound
  for (let i = 0; i < clips.length && token === playToken; i++) {
    playingIdx = i;
    renderTimeline();
    await playClip(clips[i], token);
  }
  if (token === playToken) { playing = false; playingIdx = -1; playBtn.textContent = 'Play all'; renderTimeline(); }
}

async function playClip(c, token) {
  await loadInto(play, c, c.inT);
  if (token !== playToken) return;
  await play.play().catch(() => {});
  return new Promise(resolve => {
    let lastT = play.currentTime, lastChange = performance.now();
    const tick = () => {
      if (token !== playToken) return resolve();
      const t = play.currentTime;
      if (t !== lastT) { lastT = t; lastChange = performance.now(); }
      if (t >= c.outT - 0.03 || play.ended) { play.pause(); return resolve(); }
      if (performance.now() - lastChange > 4000) { say('Playback blocked. Tap Play all again.', 4000); play.pause(); playToken++; return resolve(); }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

/* ---------- save: play the timeline once into a low bit rate MP4 ---------- */
async function saveVideo() {
  if (!clips.length || recording || exporting) return;
  stopPlay();
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) { say('This browser cannot save video.', 5000); return; }
  exporting = true; exportCancel = false; exportBlob = null;
  renderAll();
  $('overlay').hidden = false;
  $('ov-title').textContent = 'Saving video';
  $('ov-text').textContent = 'Keep this screen open. It saves in real time.';
  $('ov-save').hidden = true;
  $('ov-close').textContent = 'Cancel';
  $('bar-fill').style.width = '0%';

  // audio context is made inside the tap so the phone allows it
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  ac.resume();
  const dest = ac.createMediaStreamDestination();
  const mkVid = () => {
    const v = document.createElement('video');
    v.playsInline = true; v.preload = 'auto';
    ac.createMediaElementSource(v).connect(dest);   // sound goes to the recording only, not the speaker
    return v;
  };
  const els = [mkVid(), mkVid()];

  try {
    await loadInto(els[0], clips[0], clips[0].inT);
    let W = els[0].videoWidth || 1920, H = els[0].videoHeight || 1080;
    const k = Math.min(1, MAX_SIDE / Math.max(W, H));
    W = Math.round(W * k / 2) * 2; H = Math.round(H * k / 2) * 2;
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

    const draw = v => {
      const vw = v.videoWidth, vh = v.videoHeight; if (!vw || !vh) return;
      const s = Math.min(W / vw, H / vh);
      const w = vw * s, h = vh * s;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      ctx.drawImage(v, (W - w) / 2, (H - h) / 2, w, h);
    };

    const total = clips.reduce((a, c) => a + (c.outT - c.inT), 0);
    let doneT = 0;
    for (let i = 0; i < clips.length && !exportCancel; i++) {
      const c = clips[i], v = els[i % 2], next = clips[i + 1];
      await loadInto(v, c, c.inT);
      // get the next clip ready while this one plays, so the join has no pause
      const preload = next ? loadInto(els[(i + 1) % 2], next, next.inT) : Promise.resolve();
      await v.play().catch(() => {});
      await new Promise(resolve => {
        let lastT = v.currentTime, lastChange = performance.now();
        const tick = () => {
          if (exportCancel) return resolve();
          const t = v.currentTime;
          if (t !== lastT) { lastT = t; lastChange = performance.now(); }
          draw(v);
          const p = (doneT + Math.max(0, t - c.inT)) / total;
          $('bar-fill').style.width = Math.min(100, p * 100) + '%';
          if (t >= c.outT - 0.03 || v.ended) { v.pause(); return resolve(); }
          if (performance.now() - lastChange > 4000) { v.pause(); return resolve(); }
          requestAnimationFrame(tick);
        };
        tick();
      });
      doneT += c.outT - c.inT;
      await preload;
    }
    await new Promise(r => setTimeout(r, 250));   // let the last frame land
    rec.stop();
    await stopped;
    els.forEach(v => { v.pause(); v.removeAttribute('src'); v.load(); });
    ac.close();
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
    try { ac.close(); } catch (_) {}
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
  if (!clips.length) return;
  if (!confirm('Clear all ' + clips.length + ' clips?')) return;
  stopPlay();
  clips.forEach(c => URL.revokeObjectURL(c.url));
  clips = []; selected = -1;
  play.removeAttribute('src'); delete play.dataset.url;
  showLive();
  renderAll();
}

/* ---------- screen state ---------- */
function renderAll() {
  $('count').textContent = 'Clips ' + clips.length + '/' + MAX_CLIPS;
  const full = clips.length >= MAX_CLIPS;
  recBtn.classList.toggle('on', recording);
  recBtn.disabled = !stream || exporting || (full && !recording);
  flipBtn.disabled = recording || exporting;
  playBtn.disabled = !clips.length || recording || exporting;
  saveBtn.disabled = !clips.length || recording || exporting;
  clearBtn.disabled = !clips.length || recording || exporting;
  if (full && !recording) say('10 clips. Clear all to start again.');
  else if ($('msg').textContent.startsWith('10 clips')) say('');
  renderTimeline();
  renderTrim();
}

/* ---------- buttons ---------- */
recBtn.onclick = () => (recording ? stopRec() : startRec());
flipBtn.onclick = () => { facing = facing === 'environment' ? 'user' : 'environment'; startCamera(); };
playBtn.onclick = playAll;
saveBtn.onclick = saveVideo;
clearBtn.onclick = clearAll;
backLive.onclick = showLive;

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

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !recording && !exporting) {
    const t = stream && stream.getVideoTracks()[0];
    if (!t || t.readyState === 'ended') startCamera();
  }
});

if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) say('This browser cannot use the camera.');
else startCamera();
renderAll();
