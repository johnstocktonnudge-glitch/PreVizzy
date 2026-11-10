'use strict';
/* PreVizzy playback engine - all code visible and editable.

   Why this exists: a <video> element has to "start up" every time it begins a clip
   (find the frame, spin up the decoder, show the first picture). That is the freeze you
   see at a cut. A proper editor does not do that - it decodes the next clip's first
   frames AHEAD of time and simply switches to them at the cut.

   This file does the same:
     1. demuxMP4()   reads the clip's MP4 file and finds every video/audio sample
     2. ClipStream   decodes a clip's frames ahead of time (WebCodecs VideoDecoder)
     3. decodeAudio  decodes a clip's sound into an AudioBuffer once, up front
     4. runTimelineWC plays the timeline: frames are drawn on a canvas on a steady clock,
                      sound is scheduled on the WebAudio clock, so cuts have no start-up gap.
   If anything here is not supported on a phone, app.js falls back to the <video> method. */

const WC_OK = typeof VideoDecoder === 'function' && typeof EncodedVideoChunk === 'function'
  && typeof AudioDecoder === 'function' && typeof EncodedAudioChunk === 'function' && typeof AudioBuffer === 'function';

/* ---------- 1. reading the MP4 ---------- */
function readBoxes(dv, s, e) {
  const out = [];
  let i = s;
  while (i + 8 <= e) {
    let size = dv.getUint32(i);
    const type = String.fromCharCode(dv.getUint8(i + 4), dv.getUint8(i + 5), dv.getUint8(i + 6), dv.getUint8(i + 7));
    let hs = 8;
    if (size === 1) { size = Number(dv.getBigUint64(i + 8)); hs = 16; }
    else if (size === 0) size = e - i;
    if (size < hs) break;
    if (i + size > e) size = e - i;
    out.push({ type, start: i, size, body: i + hs, end: i + size });
    i += size;
  }
  return out;
}

function demuxMP4(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  const kids = b => readBoxes(dv, b.body, b.end);
  const sub = (b, t) => kids(b).find(x => x.type === t);
  const hex2 = n => n.toString(16).padStart(2, '0');
  const pad2 = n => String(n).padStart(2, '0');

  const top = readBoxes(dv, 0, buf.byteLength);
  const moov = top.find(b => b.type === 'moov');
  if (!moov) throw new Error('no moov box');

  const tracks = {};
  for (const trak of kids(moov).filter(b => b.type === 'trak')) {
    const tkhd = sub(trak, 'tkhd');
    const id = dv.getUint32(tkhd.body + (dv.getUint8(tkhd.body) === 1 ? 20 : 12));
    const mdia = sub(trak, 'mdia');
    const mdhd = sub(mdia, 'mdhd');
    const timescale = dv.getUint32(mdhd.body + (dv.getUint8(mdhd.body) === 1 ? 20 : 12));
    const hdlr = sub(mdia, 'hdlr');
    const kind = String.fromCharCode(...u8.subarray(hdlr.body + 8, hdlr.body + 12));
    const stsd = sub(sub(sub(mdia, 'minf'), 'stbl'), 'stsd');
    const entry = readBoxes(dv, stsd.body + 8, stsd.end)[0];
    const t = { id, kind, timescale, samples: [], nextDts: 0, runPos: 0, nalLen: 4 };

    if (kind === 'vide') {
      const ch = readBoxes(dv, entry.body + 78, entry.end);
      t.w = dv.getUint16(entry.body + 24); t.h = dv.getUint16(entry.body + 26);
      if (entry.type === 'avc1' || entry.type === 'avc3') {
        const c = ch.find(b => b.type === 'avcC');
        const p = u8.subarray(c.body, c.end);
        t.codec = 'avc1.' + hex2(p[1]) + hex2(p[2]) + hex2(p[3]);
        t.description = p.slice();
        t.nalLen = (p[4] & 3) + 1;
        t.avc = true;
      } else if (entry.type === 'vp09') {
        const c = ch.find(b => b.type === 'vpcC');
        const lvl = dv.getUint8(c.body + 5) || 41;          // level 0 means "not stated": use a safe 4.1
        t.codec = 'vp09.' + pad2(dv.getUint8(c.body + 4)) + '.' + pad2(lvl) + '.' + pad2(dv.getUint8(c.body + 6) >> 4 || 8);
      } else throw new Error('video codec ' + entry.type);
    } else if (kind === 'soun') {
      const ver = dv.getUint16(entry.body + 8);
      if (ver === 2) throw new Error('audio entry v2');
      const ch = readBoxes(dv, entry.body + (ver === 1 ? 44 : 28), entry.end);
      t.channels = dv.getUint16(entry.body + 16);
      t.rate = dv.getUint32(entry.body + 24) >>> 16;
      if (entry.type === 'mp4a') {
        const esds = ch.find(b => b.type === 'esds');
        let asc = null;
        const walk = (pos, end) => {
          while (pos < end) {
            const tag = u8[pos++];
            let len = 0, b;
            do { b = u8[pos++]; len = (len << 7) | (b & 0x7f); } while (b & 0x80);
            const next = pos + len;
            if (tag === 0x03) walk(pos + 3, next);
            else if (tag === 0x04) walk(pos + 13, next);
            else if (tag === 0x05) asc = u8.slice(pos, next);
            pos = next;
          }
        };
        walk(esds.body + 4, esds.end);
        if (!asc) throw new Error('no AudioSpecificConfig');
        t.codec = 'mp4a.40.' + (asc[0] >> 3);
        t.description = asc;
      } else if (entry.type === 'Opus') {
        t.codec = 'opus'; t.rate = 48000;
      } else throw new Error('audio codec ' + entry.type);
    } else continue;
    tracks[id] = t;
  }

  // defaults for fragments
  const trex = {};
  const mvex = sub(moov, 'mvex');
  if (mvex) kids(mvex).filter(b => b.type === 'trex').forEach(b => {
    trex[dv.getUint32(b.body + 4)] = { dur: dv.getUint32(b.body + 12), size: dv.getUint32(b.body + 16), flags: dv.getUint32(b.body + 20) };
  });

  // fragments (what MediaRecorder writes)
  for (const moof of top.filter(b => b.type === 'moof')) {
    for (const traf of kids(moof).filter(b => b.type === 'traf')) {
      const tfhd = sub(traf, 'tfhd');
      const fl = dv.getUint32(tfhd.body) & 0xffffff;
      const id = dv.getUint32(tfhd.body + 4);
      const tr = tracks[id];
      if (!tr) continue;
      const d = trex[id] || { dur: 0, size: 0, flags: 0 };
      let p = tfhd.body + 8, base = moof.start, dDur = d.dur, dSize = d.size, dFlags = d.flags;
      if (fl & 0x1) { base = Number(dv.getBigUint64(p)); p += 8; }
      if (fl & 0x2) p += 4;
      if (fl & 0x8) { dDur = dv.getUint32(p); p += 4; }
      if (fl & 0x10) { dSize = dv.getUint32(p); p += 4; }
      if (fl & 0x20) { dFlags = dv.getUint32(p); p += 4; }
      const tfdt = sub(traf, 'tfdt');
      if (tfdt) tr.nextDts = dv.getUint8(tfdt.body) === 1 ? Number(dv.getBigUint64(tfdt.body + 4)) : dv.getUint32(tfdt.body + 4);
      for (const trun of kids(traf).filter(b => b.type === 'trun')) {
        const f = dv.getUint32(trun.body) & 0xffffff;
        const n = dv.getUint32(trun.body + 4);
        let q = trun.body + 8, pos = tr.runPos || (moof.end + 8), firstFlags = null;
        if (f & 0x1) { pos = base + dv.getInt32(q); q += 4; }
        if (f & 0x4) { firstFlags = dv.getUint32(q); q += 4; }
        for (let k = 0; k < n; k++) {
          let dur = dDur, size = dSize, flags = dFlags, cts = 0;
          if (f & 0x100) { dur = dv.getUint32(q); q += 4; }
          if (f & 0x200) { size = dv.getUint32(q); q += 4; }
          if (f & 0x400) { flags = dv.getUint32(q); q += 4; } else if (k === 0 && firstFlags !== null) flags = firstFlags;
          if (f & 0x800) { cts = dv.getInt32(q); q += 4; }
          tr.samples.push({ off: pos, size, dts: tr.nextDts, cts, dur, flags });
          pos += size; tr.nextDts += dur;
        }
        tr.runPos = pos;
      }
    }
  }

  const vt = Object.values(tracks).find(t => t.kind === 'vide');
  const at = Object.values(tracks).find(t => t.kind === 'soun');
  if (!vt || !vt.samples.length) throw new Error('no video samples');

  // times in seconds, starting from the earliest sample in the file
  let origin = Infinity;
  for (const t of [vt, at]) if (t && t.samples.length) for (const s of t.samples) origin = Math.min(origin, (s.dts + s.cts) / t.timescale);
  const finish = (t, isVideo) => t.samples.map(s => {
    let key = !(s.flags & 0x10000);
    if (isVideo && t.avc) {                       // H.264: look for an IDR picture to be sure
      key = false;
      let p = s.off;
      for (let n = 0; n < 6 && p + t.nalLen < s.off + s.size; n++) {
        let len = 0;
        for (let b = 0; b < t.nalLen; b++) len = (len << 8) | u8[p + b];
        if ((u8[p + t.nalLen] & 0x1f) === 5) { key = true; break; }
        p += t.nalLen + len;
      }
    }
    return { off: s.off, size: s.size, t: (s.dts + s.cts) / t.timescale - origin, dur: s.dur / t.timescale, key };
  });
  const video = { codec: vt.codec, description: vt.description, w: vt.w, h: vt.h, samples: finish(vt, true) };
  const last = video.samples[video.samples.length - 1];
  const duration = Math.max(...video.samples.map(s => s.t + s.dur), last.t + 1 / 30);
  const audio = at && at.samples.length ? { codec: at.codec, description: at.description, rate: at.rate, channels: at.channels, samples: finish(at, false) } : null;
  return { video, audio, duration, u8 };
}

/* ---------- 2. decoding a clip's pictures ahead of time ---------- */
class ClipStream {
  constructor(clip, startT, limit) {
    this.c = clip; this.d = clip.demux; this.S = this.d.video.samples;
    this.startT = startT; this.limit = limit || 8;
    this.endT = clip.outT + 0.3;
    this.queue = []; this.cur = null; this.pre = null;
    this.closed = false; this.failed = false; this.flushed = false;
    let k = 0;
    for (let j = 0; j < this.S.length; j++) { if (this.S[j].t > startT + 1e-4) break; if (this.S[j].key) k = j; }
    this.next = k;
    this.dec = new VideoDecoder({
      output: f => this.onFrame(f),
      error: e => { this.failed = true; console.warn('decoder', e); }
    });
    this.dec.configure(this.cfg());
    this.pump();
  }
  cfg() {
    const v = this.d.video;
    const c = { codec: v.codec, optimizeForLatency: true };
    if (v.description) c.description = v.description;
    return c;
  }
  onFrame(f) {
    if (this.closed) { f.close(); return; }
    const t = f.timestamp / 1e6;
    if (t < this.startT - 1e-4) { if (this.pre) this.pre.close(); this.pre = f; return; }   // before the start: keep only the last one
    if (this.pre) { this.queue.push(this.pre); this.pre = null; }
    this.queue.push(f);
  }
  pump() {
    if (this.closed || this.failed || this.dec.state !== 'configured') return;
    while (this.next < this.S.length && this.queue.length + this.dec.decodeQueueSize < this.limit) {
      const s = this.S[this.next];
      if (s.t > this.endT) break;
      this.dec.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: Math.round(s.t * 1e6), duration: Math.round(s.dur * 1e6), data: this.d.u8.subarray(s.off, s.off + s.size) }));
      this.next++;
    }
    if (!this.flushed && (this.next >= this.S.length || this.S[this.next].t > this.endT)) {
      this.flushed = true;
      // when everything has come out, a held 'last frame before the start' is the picture to show
      this.dec.flush().then(() => { if (!this.closed && this.pre) { this.queue.push(this.pre); this.pre = null; } }).catch(() => {});
    }
  }
  hasFrame() { return !!(this.cur || this.queue.length); }
  // the newest frame that is due at clip time t
  take(t) {
    const q = this.queue;
    while (q.length && q[0].timestamp / 1e6 <= t + 1e-4) { if (this.cur) this.cur.close(); this.cur = q.shift(); }
    this.pump();
    return this.cur || q[0] || null;
  }
  close() {
    this.closed = true;
    if (this.cur) this.cur.close();
    if (this.pre) this.pre.close();
    this.queue.forEach(f => f.close());
    this.queue = []; this.cur = null; this.pre = null;
    try { if (this.dec.state !== 'closed') this.dec.close(); } catch (_) {}
  }
}

/* one still picture at clip time t (for scrubbing, trimming and editing) */
let scrubDec = null, scrubOut = [];
async function wcFrameAt(clip, t) {
  const d = clip.demux, S = d.video.samples;
  let k = 0, end = 0;
  for (let j = 0; j < S.length; j++) { if (S[j].t > t + 1e-4) break; end = j; if (S[j].key) k = j; }
  if (end < k) end = k;
  if (!scrubDec || scrubDec.state === 'closed') {
    scrubDec = new VideoDecoder({ output: f => scrubOut.push(f), error: e => console.warn('scrub decoder', e) });
  }
  scrubOut.forEach(f => f.close()); scrubOut = [];
  scrubDec.reset();
  const cfg = { codec: d.video.codec, optimizeForLatency: true };
  if (d.video.description) cfg.description = d.video.description;
  scrubDec.configure(cfg);
  for (let j = k; j <= end; j++) {
    const s = S[j];
    scrubDec.decode(new EncodedVideoChunk({ type: j === k ? 'key' : (s.key ? 'key' : 'delta'), timestamp: Math.round(s.t * 1e6), data: d.u8.subarray(s.off, s.off + s.size) }));
  }
  await scrubDec.flush();
  const got = scrubOut; scrubOut = [];
  let best = null;
  for (const f of got) {
    if (f.timestamp / 1e6 <= t + 1e-4 && (!best || f.timestamp > best.timestamp)) { if (best) best.close(); best = f; }
    else if (!best && f.timestamp / 1e6 > t) { best = f; }
    else f.close();
  }
  return best;
}

function closeScrubDecoder() {
  try { if (scrubDec && scrubDec.state !== 'closed') scrubDec.close(); } catch (_) {}
  scrubDec = null;
}

/* ---------- 3. a clip's sound, decoded once ---------- */
async function decodeAudio(d) {
  const a = d.audio;
  if (!a) return null;
  const parts = [];
  let err = null;
  const dec = new AudioDecoder({
    output: x => {
      const n = x.numberOfFrames, ch = x.numberOfChannels, arrs = [];
      for (let k = 0; k < ch; k++) { const f = new Float32Array(n); x.copyTo(f, { planeIndex: k, format: 'f32-planar' }); arrs.push(f); }
      parts.push({ t: x.timestamp / 1e6, arrs, n, rate: x.sampleRate });
      x.close();
    },
    error: e => { err = e; }
  });
  const cfg = { codec: a.codec, sampleRate: a.rate, numberOfChannels: a.channels };
  if (a.description) cfg.description = a.description;
  dec.configure(cfg);
  for (const s of a.samples) dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(Math.max(0, s.t) * 1e6), duration: Math.round(s.dur * 1e6), data: d.u8.subarray(s.off, s.off + s.size) }));
  await dec.flush();
  dec.close();
  if (err) throw err;
  if (!parts.length) return null;
  const rate = parts[0].rate, ch = parts[0].arrs.length;
  const len = Math.ceil(Math.max(...parts.map(p => p.t + p.n / rate)) * rate);
  const ab = new AudioBuffer({ numberOfChannels: ch, length: len, sampleRate: rate });
  const chans = []; for (let k = 0; k < ch; k++) chans.push(ab.getChannelData(k));
  for (const p of parts) {
    const at = Math.max(0, Math.round(p.t * rate));
    const m = Math.max(0, Math.min(p.n, len - at));
    for (let k = 0; k < ch; k++) chans[k].set(p.arrs[k].subarray(0, m), at);
  }
  return ab;
}

// get a clip ready for the engine: read the file, check the phone can decode it, decode its sound
async function prepareClip(c) {
  c.demux = null; c.abuf = null;
  if (!WC_OK) return;
  try {
    const buf = await c.blob.arrayBuffer();
    const d = demuxMP4(buf);
    const sup = await VideoDecoder.isConfigSupported({ codec: d.video.codec, ...(d.video.description ? { description: d.video.description } : {}) });
    if (!sup.supported) throw new Error('video codec not supported: ' + d.video.codec);
    if (d.audio) {
      const as = await AudioDecoder.isConfigSupported({ codec: d.audio.codec, sampleRate: d.audio.rate, numberOfChannels: d.audio.channels, ...(d.audio.description ? { description: d.audio.description } : {}) });
      if (!as.supported) throw new Error('audio codec not supported: ' + d.audio.codec);
      c.abuf = await decodeAudio(d);
    }
    c.demux = d;
    c.w = d.video.w || c.w; c.h = d.video.h || c.h;
  } catch (e) {
    console.warn('PreVizzy engine: using the video-player method for this clip.', e);
    c.demux = null; c.abuf = null; c.why = String((e && e.message) || e);
  }
}

/* ---------- 4. the audio clock ---------- */
let acx = null;
function getAC() {
  if (!acx || acx.state === 'closed') {
    const AC = window.AudioContext || window.webkitAudioContext;
    acx = new AC({ latencyHint: 'interactive' });
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) {}   // sound even with the silent switch on
  }
  if (acx.state === 'suspended') acx.resume().catch(() => {});
  return acx;
}

/* ---------- 5. playing the timeline ----------
   o = { startIdx, startT, ctx, W, H, out (audio node), stopped(), progress(i, tInClip), onClip(i) }
   Needs: clips, startsOf, lenOf, drawFrame (from app.js) */
async function runTimelineWC(o) {
  const ac = getAC();
  const starts = startsOf(), n = clips.length, total = totalLen();
  const T0 = starts[o.startIdx] + (o.startT - clips[o.startIdx].inT);
  const streams = [];
  const open = (i, limit, t) => {
    if (!streams[i]) streams[i] = new ClipStream(clips[i], t === undefined ? clips[i].inT : t, limit);
    return streams[i];
  };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const closeAll = () => streams.forEach(s => s && s.close());

  closeScrubDecoder();                           // phones only allow a few decoders at once
  let i = o.startIdx;
  const s0 = open(i, 10, o.startT);
  const tw = performance.now();
  while (!s0.hasFrame() && !s0.failed && performance.now() - tw < 3000 && !o.stopped()) await sleep(15);
  if (o.stopped() || s0.failed) { closeAll(); return; }

  if (ac.state !== 'running') { try { await Promise.race([ac.resume(), sleep(600)]); } catch (_) {} }
  const useAC = ac.state === 'running';
  const perf0 = performance.now();
  const A0 = (useAC ? ac.currentTime : 0) + 0.12;          // the moment timeline time T0 begins
  const nowT = () => useAC ? ac.currentTime - (ac.outputLatency || 0) : (performance.now() - perf0) / 1000;
  const aStart = useAC ? A0 : 0.12;

  // sound: every clip's audio is scheduled up front on the audio clock, so joins are sample-accurate
  const sources = [];
  if (useAC) {
    for (let k = o.startIdx; k < n; k++) {
      const c = clips[k];
      if (!c.abuf) continue;
      const first = k === o.startIdx;
      const off = first ? o.startT : c.inT;
      const dur = first ? c.outT - o.startT : lenOf(c);
      const src = ac.createBufferSource();
      src.buffer = c.abuf;
      src.connect(o.out);
      src.start(Math.max(ac.currentTime, A0 + (starts[k] + (first ? o.startT - c.inT : 0) - T0)), Math.max(0, off), Math.max(0.01, dur));
      sources.push(src);
    }
  }

  return new Promise(resolve => {
    let ended = false;
    const finish = () => {
      if (ended) return; ended = true;
      sources.forEach(s => { try { s.stop(); } catch (_) {} });
      closeAll();
      resolve();
    };
    const tick = () => {
      if (o.stopped()) return finish();
      let T = T0 + (nowT() - aStart);
      if (T < T0) T = T0;
      // move on to the next clip when its time comes
      while (i + 1 < n && T >= starts[i + 1]) {
        if (streams[i]) { streams[i].close(); streams[i] = null; }
        i++;
        open(i, 10).limit = 10;
        if (o.onClip) o.onClip(i);
      }
      // get the clip after this one decoding well before the cut
      if (i + 1 < n && T >= starts[i + 1] - 2.0) open(i + 1, 6);
      const c = clips[i], s = open(i, 10);
      const fr = s.take(c.inT + Math.max(0, T - starts[i]));
      if (fr) o.draw(fr, c);
      o.progress(i, Math.max(0, T - starts[i]));
      if (T >= total - 0.001) return finish();
      requestAnimationFrame(tick);
    };
    tick();
  });
}
