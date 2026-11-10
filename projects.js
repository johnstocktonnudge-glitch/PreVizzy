/* PreVizzy projects: save the timeline, a gallery of projects, share saved videos.
   Clips live only in memory until you press Save project. Close the app without saving and they are gone.
   Saved projects are kept in the phone's app storage (IndexedDB) until you delete them. */

/* ---------- storage ---------- */
function pjDb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('previzzy', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('projects', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function pjTx(mode, fn) {
  const db = await pjDb();
  return new Promise((res, rej) => {
    const t = db.transaction('projects', mode);
    const r = fn(t.objectStore('projects'));
    t.oncomplete = () => { db.close(); res(r && r.result); };
    t.onerror = () => { db.close(); rej(t.error); };
    t.onabort = () => { db.close(); rej(t.error); };
  });
}
const pjAll = () => pjTx('readonly', s => s.getAll());
const pjGet = id => pjTx('readonly', s => s.get(id));
const pjPut = p => pjTx('readwrite', s => s.put(p));
const pjDel = id => pjTx('readwrite', s => s.delete(id));

/* ---------- what is open, and has it changed since it was saved ---------- */
let curPid = null, curName = '', savedSig = '';
const sigOf = () => JSON.stringify(clips.map(c => [c.id, +c.inT.toFixed(3), +c.outT.toFixed(3), c.zoom, +(c.px || 0).toFixed(3), +(c.py || 0).toFixed(3), c.join || 'b']));
const pjDirty = () => clips.length > 0 && sigOf() !== savedSig;
function pjDetach() { curPid = null; curName = ''; savedSig = ''; }
function pjFlag() { return clips.length ? (pjDirty() ? '  • unsaved' : (curPid ? '  • saved' : '')) : ''; }
setInterval(() => {
  const txt = clips.length + '/' + MAX_CLIPS + pjFlag();
  if (!recording && $('count').textContent !== txt) $('count').textContent = txt;     // only touch the page when it changed
  const off = !clips.length || recording || exporting;
  if ($('savepj').disabled !== off) $('savepj').disabled = off;
}, 800);
window.addEventListener('beforeunload', e => { if (pjDirty()) { e.preventDefault(); e.returnValue = ''; } });

/* ---------- small helpers ---------- */
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const pjBox = $('pj'), pjBody = $('pj-body');
const pjClose = () => { pjBox.hidden = true; pjBody.innerHTML = ''; };
function pjShow(html, handlers) {
  pjBody.innerHTML = html;
  pjBox.hidden = false;
  pjBody.onclick = e => {
    const b = e.target.closest('[data-act]');
    if (b && handlers[b.dataset.act]) handlers[b.dataset.act](b.dataset);
  };
}
const mb = n => (n / 1048576).toFixed(1) + ' MB';
const dateText = t => new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const sizeOf = p => p.clips.reduce((a, c) => a + (c.blob ? c.blob.size : 0), 0) + (p.videos || []).reduce((a, v) => a + v.blob.size, 0);

/* ---------- save ---------- */
async function saveProject(pid, name) {
  try {
    const old = pid ? await pjGet(pid) : null;
    const rec = {
      id: pid || Date.now().toString(36),
      name, created: old ? old.created : Date.now(), updated: Date.now(),
      seq: clipSeq, videos: old ? old.videos || [] : [],
      clips: clips.map(c => ({ id: c.id, blob: c.blob, dur: c.dur, inT: c.inT, outT: c.outT, w: c.w, h: c.h, zoom: c.zoom, px: c.px || 0, py: c.py || 0, join: c.join || 'b' }))
    };
    await pjPut(rec);
    curPid = rec.id; curName = name; savedSig = sigOf();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    say('Saved: ' + name, 2500);
    return true;
  } catch (e) {
    console.warn('save project', e);
    say('Could not save: ' + (e && (e.message || e.name) || 'storage problem'), 5000);
    return false;
  }
}

// ask for a name once (or pick an existing project to save into), then save
async function askSave(done) {
  const list = (await pjAll().catch(() => [])).sort((x, y) => y.updated - x.updated);
  const rows = list.map(p => '<button class="pjrow" data-act="into" data-id="' + p.id + '">' + esc(p.name) + '<small>' + p.clips.length + ' clips • ' + dateText(p.updated) + '</small></button>').join('');
  pjShow('<h2>Save project</h2><p>Type a name once. After that, pick it from the list.</p>'
    + '<input id="pj-name" type="text" maxlength="40" placeholder="Project name" value="' + esc(curName) + '">'
    + '<div class="row-btns"><button data-act="new">Save</button><button data-act="cancel">Cancel</button></div>'
    + (rows ? '<h3>Or save into an existing project (replaces its clips)</h3>' + rows : ''), {
    new: async () => {
      const name = ($('pj-name').value || '').trim() || 'Untitled';
      if (await saveProject(null, name)) { pjClose(); if (done) done(); }
    },
    into: async d => {
      const p = list.find(x => x.id === d.id);
      if (!p || !confirm('Replace the clips in "' + p.name + '" with this timeline?')) return;
      if (await saveProject(p.id, p.name)) { pjClose(); if (done) done(); }
    },
    cancel: pjClose
  });
  setTimeout(() => { const i = $('pj-name'); if (i) i.focus(); }, 50);
}

// Save project button: saves straight away if the project already has a name
async function saveClick() {
  if (!clips.length) return;
  $('menu').hidden = true;
  if (curPid) { await saveProject(curPid, curName); renderAll(); } else askSave();
}

// if the timeline has unsaved changes, ask Save / Discard / Cancel before going on
function guardDirty(cont) {
  if (!pjDirty()) { cont(); return; }
  pjShow('<h2>Unsaved clips</h2><p>The clips on the timeline have not been saved.</p>'
    + '<div class="row-btns"><button data-act="save">Save</button><button data-act="discard" class="danger">Discard</button><button data-act="cancel">Cancel</button></div>', {
    save: async () => {
      if (curPid) { if (await saveProject(curPid, curName)) { pjClose(); cont(); } }
      else askSave(cont);
    },
    discard: () => { pjClose(); cont(); },
    cancel: pjClose
  });
}

/* ---------- open ---------- */
async function loadProject(id) {
  const p = await pjGet(id);
  if (!p) { say('Project not found.', 3000); return; }
  resetTimeline();
  clipSeq = p.seq || Math.max(0, ...p.clips.map(c => c.id || 0));
  clips = p.clips.map(c => ({ ...c, url: URL.createObjectURL(c.blob), ready: false, demux: null, abuf: null }));
  curPid = p.id; curName = p.name;
  head = 0;
  pjClose();
  $('menu').hidden = true;
  renderAll();
  say('Opening ' + p.name + '...', 2500);
  await Promise.all(clips.map(c => startPrep(c)));
  savedSig = sigOf();
  goTo(0);
  renderAll();
}

/* ---------- share / save a video ---------- */
async function shareBlob(blob, name) {
  const file = new File([blob], name, { type: blob.type || 'video/mp4' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  saveBlobToDevice(blob, name);
  say('Sharing is not available here, so it was saved to your downloads instead.', 4000);
}
function saveBlobToDevice(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

/* ---------- gallery ---------- */
async function showGallery() {
  $('menu').hidden = true;
  let list = [];
  try { list = (await pjAll()).sort((x, y) => y.updated - x.updated); } catch (e) { say('Could not read saved projects.', 3000); return; }
  let used = '';
  try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); used = 'App storage used: ' + mb(e.usage || 0); } } catch (_) {}
  const rows = list.map(p => '<button class="pjrow" data-act="proj" data-id="' + p.id + '">' + esc(p.name)
    + '<small>' + p.clips.length + ' clips • ' + (p.videos || []).length + ' videos • ' + mb(sizeOf(p)) + ' • ' + dateText(p.updated) + '</small></button>').join('');
  pjShow('<h2>Projects</h2><p>' + (list.length ? esc(used) : 'Nothing saved yet. Press Save project to keep a timeline.') + '</p>' + rows
    + '<div class="row-btns">' + (list.length ? '<button data-act="delall" class="danger">Delete all projects</button>' : '') + '<button data-act="close">Close</button></div>', {
    proj: d => showProject(d.id),
    delall: async () => {
      if (!confirm('Delete ALL ' + list.length + ' saved projects and their videos? This cannot be undone.')) return;
      for (const p of list) await pjDel(p.id);
      if (curPid) { curPid = null; savedSig = ''; }
      showGallery();
    },
    close: pjClose
  });
}

async function showProject(id) {
  const p = await pjGet(id);
  if (!p) { showGallery(); return; }
  const vids = (p.videos || []).map((v, i) => '<div class="pjrow" style="min-height:0"><div>' + esc(v.name) + '<small>' + mb(v.blob.size) + ' • ' + dateText(v.date) + '</small></div>'
    + '<div class="row-btns"><button data-act="vshare" data-i="' + i + '">Share</button><button data-act="vsave" data-i="' + i + '">Save</button><button data-act="vdel" data-i="' + i + '" class="danger">Delete</button></div></div>').join('');
  pjShow('<h2>' + esc(p.name) + '</h2><p>' + p.clips.length + ' clips • ' + mb(sizeOf(p)) + ' • ' + dateText(p.updated) + '</p>'
    + '<div class="row-btns"><button data-act="open">Open timeline</button><button data-act="del" class="danger">Delete project</button></div>'
    + '<h3>Saved videos</h3>' + (vids || '<p>None yet. After you Export a video, tap "Keep in project".</p>')
    + '<div class="row-btns"><button data-act="back">Back</button></div>', {
    open: () => guardDirty(() => loadProject(id)),
    del: async () => {
      if (!confirm('Delete project "' + p.name + '" and its videos? This cannot be undone.')) return;
      await pjDel(id);
      if (curPid === id) { curPid = null; savedSig = ''; }
      showGallery();
    },
    vshare: d => shareBlob(p.videos[+d.i].blob, p.videos[+d.i].name),
    vsave: d => saveBlobToDevice(p.videos[+d.i].blob, p.videos[+d.i].name),
    vdel: async d => { p.videos.splice(+d.i, 1); await pjPut(p); showProject(id); },
    back: showGallery
  });
}

/* ---------- buttons ---------- */
$('savepj').onclick = saveClick;
$('pj-open').onclick = showGallery;
$('pj-saveas').onclick = () => { $('menu').hidden = true; if (clips.length) askSave(); else say('Nothing to save yet.', 2000); };
$('pj-new').onclick = () => {
  $('menu').hidden = true;
  guardDirty(() => { if (clips.length) resetTimeline(); else pjDetach(); say('New project', 1500); });
};

/* exported video: share it, or keep it inside the project */
new MutationObserver(() => {
  const ready = !$('ov-save').hidden;
  $('ov-share').hidden = !ready || !(navigator.canShare);
  $('ov-keep').hidden = !ready;
  $('ov-keep').textContent = 'Keep in project';
}).observe($('ov-save'), { attributes: true, attributeFilter: ['hidden'] });
$('ov-share').onclick = () => { if (exportBlob) shareBlob(exportBlob, exportName); };
$('ov-keep').onclick = async () => {
  if (!exportBlob) return;
  const keep = async () => {
    try {
      const p = await pjGet(curPid);
      p.videos = p.videos || [];
      p.videos.push({ name: exportName, blob: exportBlob, date: Date.now() });
      p.updated = Date.now();
      await pjPut(p);
      $('ov-keep').hidden = true;
      say('Video kept in "' + curName + '"', 3000);
    } catch (e) { say('Could not keep the video: ' + (e && e.message || ''), 4000); }
  };
  if (curPid) keep();
  else askSave(keep);
};
