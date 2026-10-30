/**
 * Reel Rescue core: rebuilds the missing index (moov) of an MP4/MOV whose recording was cut off.
 * Streams the file with Blob.slice, never loads it whole. No Node-only APIs.
 */
import type { Progress, Report, RescueOptions, RescueResult, Segment } from './types.js';
import { parseH264Sps, parseHevcSps, buildAvcC, buildHvcC, paramSetsFromAvcC, paramSetsFromHvcC, parseHevcPps, sliceH264PocLsb, sliceHevcPocLsb } from './nal.js';
import type { SpsInfo } from './nal.js';
import { readReference } from './ref.js';
import { buildFtypBox, buildMdatHeader, buildMoov } from './mux.js';

type Codec = 'h264' | 'hevc';
const WIN = 8 * 1024 * 1024;
const MAX_NAL = 96 * 1024 * 1024;

/** Small cached window over a Blob so tight scan loops stay synchronous. */
class Win {
  buf = new Uint8Array(0); base = 0;
  constructor(public file: Blob) {}
  async load(pos: number, need = 1) {
    const len = Math.min(this.file.size - pos, Math.max(WIN, need));
    this.buf = new Uint8Array(await this.file.slice(pos, pos + len).arrayBuffer()); this.base = pos;
  }
  has(pos: number, n: number) { return pos >= this.base && pos + n <= this.base + this.buf.length; }
  /** bytes at pos (n bytes) or null when beyond EOF. Uses the window; falls back to a tiny read. */
  async peek(pos: number, n: number): Promise<Uint8Array | null> {
    if (pos + n > this.file.size) return null;
    if (this.has(pos, n)) return this.buf.subarray(pos - this.base, pos - this.base + n);
    return new Uint8Array(await this.file.slice(pos, pos + n).arrayBuffer());
  }
}

interface NalInfo { len: number; type: number; first: boolean; vcl: boolean }
interface Sample { off: number; size: number; key: boolean; type: number }

function nalAt(b: Uint8Array, p: number, avail: number, codec: Codec): NalInfo | null {
  if (p + 7 > b.length) return null;
  const len = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
  if (len < 2 || len > MAX_NAL || len > avail - 4) return null;
  const h = b[p + 4];
  if (codec === 'h264') {
    if (h & 0x80) return null;
    const t = h & 0x1f;
    if (t === 0 || t > 12 && t < 19 || t > 20 && t !== 24 && t < 24 || t > 23) return null;
    if (t > 20) return null;
    const vcl = t >= 1 && t <= 5;
    return { len, type: t, vcl, first: vcl ? (b[p + 5] & 0x80) !== 0 : false };
  }
  const b1 = b[p + 5];
  if (h & 0x80) return null;
  const t = (h >> 1) & 0x3f, layer = ((h & 1) << 5) | (b1 >> 3), tid = b1 & 7;
  if (layer !== 0 || tid === 0 || t > 40 || (t >= 10 && t <= 15) || (t >= 22 && t <= 31)) return null;
  const vcl = t <= 21;
  return { len, type: t, vcl, first: vcl ? (b[p + 6] & 0x80) !== 0 : false };
}

interface AU { maxLen: number; end: number; key: boolean; type: number; params: { type: number; off: number; len: number }[]; slice0: number }
/** Parse one access unit starting at p. buf is a window with absolute origin base; remaining = bytes until EOF. */
function auAt(b: Uint8Array, base: number, p: number, remaining: number, codec: Codec): AU | null {
  let q = p; let sawVcl = false; let first = false;
  const params: AU['params'] = []; let key = false, type = 0, slice0 = -1, maxLen = 0;
  for (;;) {
    const n = nalAt(b, q - base, remaining - (q - p), codec);
    if (!n) break;
    if (n.vcl) {
      if (sawVcl && n.first) break;
      if (!sawVcl) { first = n.first; key = codec === 'h264' ? n.type === 5 : n.type >= 16 && n.type <= 21; type = n.type; slice0 = q + 4; }
      sawVcl = true;
    } else {
      if (sawVcl) break;
      if (codec === 'h264' ? n.type === 7 || n.type === 8 : n.type >= 32 && n.type <= 34) params.push({ type: n.type, off: q + 4, len: n.len });
    }
    if (n.len > maxLen) maxLen = n.len;
    q += 4 + n.len;
    if (q - base + 7 > b.length) break;
  }
  if (!sawVcl || !first) return null;
  return { end: q, key, type, params, slice0, maxLen };
}

function parseBoxHeaderTop(b: Uint8Array, p: number, fileSize: number) {
  if (p + 8 > b.length) return null;
  let size = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
  const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]); let hdr = 8;
  if (size === 1 && p + 16 <= b.length) { size = ((b[p + 8] << 24) >>> 0) * 4294967296 + (((b[p + 12] << 24) >>> 0) + (b[p + 13] << 16) + (b[p + 14] << 8) + b[p + 15]); hdr = 16; }
  return { type, size, hdr };
}

export async function rescue(file: Blob, opts: RescueOptions = {}): Promise<RescueResult> {
  const total = file.size;
  const warnings: string[] = [];
  const fail = (summary: string, extra: Partial<Report> = {}): RescueResult => ({
    output: null,
    report: { ok: false, container: 'unknown', videoCodec: 'unknown', audioCodec: 'unknown', recoveredSeconds: 0, framesRecovered: 0, keyframes: 0, bytesTotal: total, bytesUsable: 0, bytesEmpty: 0, usedReference: false, warnings, verdict: 'failed', summary, ...extra },
  });
  const emit = (stage: Progress['stage'], done: number, frames: number, segs: Segment[]) => opts.onProgress?.({ stage, bytesDone: done, bytesTotal: total, framesFound: frames, segments: segs });
  emit('reading', 0, 0, []);

  // 1. Locate the media data (mdat) among the top-level boxes of the damaged file.
  const w = new Win(file);
  let pos = 0, dataStart = -1, dataEnd = total, container = 'mp4', hasMoov = false;
  await w.load(0, 64);
  while (pos + 8 <= total) {
    const h = await w.peek(pos, 16); if (!h) break;
    const bx = parseBoxHeaderTop(h, 0, total); if (!bx) break;
    if (bx.type === 'ftyp') { const br = await w.peek(pos + 8, 4); if (br && String.fromCharCode(...br) === 'qt  ') container = 'mov'; }
    if (bx.type === 'moov') hasMoov = true;
    if (bx.type === 'mdat') { dataStart = pos + bx.hdr; dataEnd = bx.size === 0 || pos + bx.size > total ? total : pos + bx.size; if (bx.size === 0 || pos + bx.size > total) break; }
    if (!/^[\x20-\x7e]{4}$/.test(bx.type) || bx.size < bx.hdr) break;
    pos += bx.size;
  }
  if (dataStart < 0) {
    // fall back: look for the 'mdat' tag near the start
    const head = new Uint8Array(await file.slice(0, Math.min(total, 1 << 20)).arrayBuffer());
    for (let i = 4; i + 8 < head.length; i++) if (head[i] === 0x6d && head[i + 1] === 0x64 && head[i + 2] === 0x61 && head[i + 3] === 0x74) { dataStart = i + 4; break; }
  }
  if (dataStart < 0) return fail("This doesn't look like an MP4 or MOV video, or the picture data is missing.");
  if (hasMoov) warnings.push('This file already has an index (moov). It may not be the problem; the rebuilt copy uses the picture data only.');

  // 2. Reference (optional): parameter sets, size and frame rate from a good clip of the same camera.
  const ref = opts.reference ? await readReference(opts.reference).catch(() => null) : null;
  if (opts.reference && !ref?.video) warnings.push("The extra video couldn't be read, so it was ignored.");

  // 3. Detect codec by probing the start of the picture data.
  const tryProbe = async (codec: Codec) => { await w.load(dataStart, 1 << 20); let p = dataStart, n = 0; for (; n < 40;) { const au = auAt(w.buf, w.base, p, dataEnd - p, codec); if (!au) break; p = au.end; n++; if (p - w.base + 64 > w.buf.length) break; } return n; };
  let codec: Codec | null = ref?.video?.hvcC ? 'hevc' : ref?.video?.avcC ? 'h264' : null;
  if (!codec) { const a = await tryProbe('h264'), b = await tryProbe('hevc'); if (a === 0 && b === 0) { /* first run may start mid-way; resync handles it */ } codec = b > a ? 'hevc' : 'h264'; if (a === 0 && b === 0) codec = 'h264'; }

  // 4. Scan: find every picture, resynchronising across interleaved sound or zero runs.
  const samples: Sample[] = [];
  const pset: { vps?: Uint8Array; sps?: Uint8Array; pps?: Uint8Array } = {};
  let firstSliceHdr: Uint8Array[] = [];
  const picHdr: (Uint8Array | null)[] = [];
  const CELLS = 240; const cells = new Uint8Array(CELLS); // 0 unknown,1 video,2 other
  const cellOf = (o: number) => Math.min(CELLS - 1, Math.floor(o / total * CELLS));
  const markSegs = (): Segment[] => { const s: Segment[] = []; for (let i = 0; i < CELLS; i++) s.push({ start: Math.floor(i * total / CELLS), end: Math.floor((i + 1) * total / CELLS), kind: cells[i] === 1 ? 'video' : cells[i] === 2 ? 'audio' : 'empty' }); return s; };
  let pcur = dataStart, bytesVideo = 0, lastEmit = 0, maxSeen = 0;
  const need = (o: number) => { if (!w.has(o, 4096) && !(w.base + w.buf.length >= total && o >= w.base)) return true; return false; };
  while (pcur < dataEnd) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (!w.has(pcur, Math.min(1 << 16, dataEnd - pcur)) || w.base + w.buf.length - pcur < 1 << 20 && w.base + w.buf.length < total) await w.load(pcur, 1 << 21);
    const b = w.buf, base = w.base;
    const limit = Math.min(dataEnd, base + b.length - (w.base + b.length < total ? 1 << 20 : 0));
    let au = pcur < limit ? auAt(b, base, pcur, dataEnd - pcur, codec) : null;
    if (au && au.end > base + b.length) au = null;
    if (au) {
      for (const pr of au.params) { const bytes = b.slice(pr.off - base, pr.off - base + pr.len); if (codec === 'h264') { if (pr.type === 7 && !pset.sps) pset.sps = bytes; if (pr.type === 8 && !pset.pps) pset.pps = bytes; } else { if (pr.type === 32 && !pset.vps) pset.vps = bytes; if (pr.type === 33 && !pset.sps) pset.sps = bytes; if (pr.type === 34 && !pset.pps) pset.pps = bytes; } }
      samples.push({ off: pcur, size: au.end - pcur, key: au.key, type: au.type });
      picHdr.push(b.slice(au.slice0 - base, au.slice0 - base + 24));
      bytesVideo += au.end - pcur; if (au.maxLen > maxSeen) maxSeen = au.maxLen;
      for (let c = cellOf(pcur); c <= cellOf(au.end - 1); c++) cells[c] = 1;
      pcur = au.end;
    } else {
      // resync: slide forward until a plausible picture chain (this one + next one) starts
      let found = -1; const endScan = Math.min(dataEnd, base + b.length - 64);
      let q = pcur + 1;
      for (; q < endScan; q++) {
        const o = q - base;
        if (b[o] !== 0 || (b[o + 1] > 0x5f)) continue;
        const a1 = auAt(b, base, q, dataEnd - q, codec); if (!a1 || a1.end > base + b.length) continue;
        // a real picture is never wildly bigger than the ones already seen; this rejects look-alikes inside sound data
        const cap = Math.max(64 * 1024, maxSeen * 6);
        if (a1.maxLen <= cap) { found = q; break; }
        if (a1.end >= dataEnd) { found = q; break; }
        const a2 = auAt(b, base, a1.end, dataEnd - a1.end, codec);
        if (a2 && a2.end <= base + b.length) { found = q; break; }
      }
      if (found < 0) {
        if (endScan >= dataEnd - 64 || base + b.length >= total) { for (let c = cellOf(pcur); c < CELLS; c++) if (!cells[c]) cells[c] = 2; pcur = dataEnd; break; }
        for (let c = cellOf(pcur); c <= cellOf(q); c++) if (!cells[c]) cells[c] = 2;
        pcur = Math.max(q, pcur + 1); continue;
      }
      for (let c = cellOf(pcur); c <= cellOf(found); c++) if (!cells[c]) cells[c] = 2;
      pcur = found;
    }
    const now = Date.now(); if (now - lastEmit > 60) { lastEmit = now; emit('scanning', pcur, samples.length, markSegs()); await new Promise((r) => setTimeout(r, 0)); }
  }
  void need; void firstSliceHdr;
  emit('rebuilding', total, samples.length, markSegs());

  if (samples.length === 0) return fail("No video pictures could be found in this file.", { container, needsReference: false });

  // 5. Parameter sets: from the file itself, else from the reference.
  let info: SpsInfo | null = null; let avcC: Uint8Array | undefined, hvcC: Uint8Array | undefined; let usedRef = false;
  let width = 0, height = 0;
  if (codec === 'h264') {
    if (pset.sps && pset.pps) { avcC = buildAvcC([pset.sps], [pset.pps]); info = parseH264Sps(pset.sps); }
    else if (ref?.video?.avcC) { avcC = ref.video.avcC; usedRef = true; const ps = paramSetsFromAvcC(avcC); info = ps.sps[0] ? parseH264Sps(ps.sps[0]) : null; }
  } else {
    if (pset.vps && pset.sps && pset.pps) { hvcC = buildHvcC([pset.vps], [pset.sps], [pset.pps]); info = parseHevcSps(pset.sps); }
    else if (ref?.video?.hvcC) { hvcC = ref.video.hvcC; usedRef = true; const ps = paramSetsFromHvcC(hvcC); info = ps.sps[0] ? parseHevcSps(ps.sps[0]) : null; }
  }
  if (!avcC && !hvcC) {
    return fail("The picture data was found, but this phone doesn't store the video settings next to it, so they can't be rebuilt from this file alone. Add a short good video recorded on the same phone with the same settings.", { container, videoCodec: codec, framesRecovered: samples.length, bytesUsable: bytesVideo, needsReference: true });
  }
  width = info?.width || ref?.video?.width || 0; height = info?.height || ref?.video?.height || 0;
  if (!width || !height) return fail("The video settings were found but couldn't be read.", { container, videoCodec: codec, needsReference: !usedRef });

  // 6. Timing: frame rate from reference, stream VUI, or an honest guess.
  const timescale = ref?.video?.timescale || 30000;
  let fps = 0, delta = 0;
  if (ref?.video?.firstDelta && ref.video.timescale) { delta = ref.video.firstDelta; fps = ref.video.timescale / delta; }
  else if (info?.fps && info.fps > 1 && info.fps < 241) { fps = info.fps; delta = Math.round(timescale / fps); }
  else { fps = 30; delta = Math.round(timescale / 30); warnings.push("The frame rate wasn't stored in the file, so 30 fps was assumed. If the video plays too fast or slow, add a good video from the same phone."); }

  // 7. Presentation order (B-frames) from picture order counts.
  let comp: number[] | undefined; let editStart = 0;
  try {
    const ppsBytes = codec === 'hevc' ? (pset.pps ?? (hvcC ? paramSetsFromHvcC(hvcC).pps[0] : undefined)) : undefined;
    const ppsH = ppsBytes ? parseHevcPps(ppsBytes) : null;
    const pocs: (number | null)[] = samples.map((s, i) => { try { return codec === 'h264' ? (info ? sliceH264PocLsb(picHdr[i]!, info) : null) : (info && ppsH ? sliceHevcPocLsb(picHdr[i]!, info, ppsH) : null); } catch { return null; } });
    if (pocs.every((p) => p !== null) && info) {
      const bits = info.log2MaxPocLsb || 8, M = 2 ** bits;
      const abs: number[] = []; let prevLsb = 0, msb = 0, keyBase = 0;
      const isBoundary = (t: number) => codec === 'h264' ? t === 5 : t >= 16 && t <= 20;
      samples.forEach((s, i) => { const l = pocs[i]!; if (isBoundary(s.type)) { msb = 0; prevLsb = l; keyBase = abs.length; } else { if (l < prevLsb && prevLsb - l >= M / 2) msb += M; else if (l > prevLsb && l - prevLsb > M / 2) msb -= M; prevLsb = l; } abs.push(msb + l); void keyBase; });
      // rank within each key-to-key group to get presentation index
      const pres: number[] = new Array(samples.length); let gs = 0;
      for (let i = 1; i <= samples.length; i++) if (i === samples.length || isBoundary(samples[i].type)) { const idx = []; for (let k = gs; k < i; k++) idx.push(k); idx.sort((a, b2) => abs[a] - abs[b2]); idx.forEach((k, r) => (pres[k] = gs + r)); gs = i; }
      const offs = samples.map((_, i) => (pres[i] - i) * delta);
      const mn = Math.min(...offs); comp = offs.map((o) => o - mn); if (comp.every((c) => c === 0)) comp = undefined; else editStart = -mn;
      void editStart;
    } else if (codec === 'h264' && info && info.pocType !== 0) warnings.push('Frame ordering could not be determined; if the motion looks jumpy, add a good video from the same phone.');
  } catch { /* leave in decode order */ }

  // 8. Build the new file: ftyp + moov + mdat that re-uses the original bytes (merged slices).
  const keyframes: number[] = []; samples.forEach((s, i) => s.key && keyframes.push(i + 1));
  if (!keyframes.length) { keyframes.push(1); warnings.push('No keyframe was found; playback may start with a glitch.'); }
  const ftyp = buildFtypBox(container === 'mov' ? 'mov' : 'mp4');
  const mk = (base: number) => {
    let o = base; const smp = samples.map((s) => { const r = { offset: o, size: s.size }; o += s.size; return r; });
    return buildMoov({ container: container === 'mov' ? 'mov' : 'mp4', video: { codec, width, height, fps, timescale, sampleDelta: delta, samples: smp, keyframes, avcC, hvcC, compositionOffsets: comp } });
  };
  const payload = samples.reduce((a, s) => a + s.size, 0);
  const mdatHdr = buildMdatHeader(payload);
  let moov = mk(0); let moov2 = mk(ftyp.length + moov.length + mdatHdr.length);
  if (moov2.length !== moov.length) moov2 = mk(ftyp.length + moov2.length + mdatHdr.length);
  const parts: BlobPart[] = [ftyp as BlobPart, moov2 as BlobPart, mdatHdr as BlobPart];
  let rs = samples[0].off, re = rs;
  for (const s of samples) { if (s.off === re) re = s.off + s.size; else { parts.push(file.slice(rs, re)); rs = s.off; re = s.off + s.size; } }
  parts.push(file.slice(rs, re));
  const output = new Blob(parts, { type: 'video/mp4' });

  // 9. Report.
  const seconds = samples.length * delta / timescale;
  const unknownBytes = total - dataStart - bytesVideo;
  const audioish = unknownBytes > 0.02 * total;
  if (audioish) warnings.push("Sound could not be recovered, so the repaired video has no audio. The picture is complete.");
  const emptyBytes = cells.reduce((a, c) => a + (c === 0 ? 1 : 0), 0) * (total / CELLS);
  const partial = dataEnd >= total && samples.length > 0 && (total - samples[samples.length - 1].off - samples[samples.length - 1].size) > 0.02 * total && !audioish;
  const verdict: Report['verdict'] = partial ? 'partial' : 'full';
  const mm = Math.floor(seconds / 60), ss = Math.round(seconds % 60);
  emit('done', total, samples.length, markSegs());
  return {
    output,
    report: {
      ok: true, container, videoCodec: codec, audioCodec: audioish ? 'unknown' : 'none', width, height, fps, recoveredSeconds: seconds, framesRecovered: samples.length, keyframes: keyframes.length,
      bytesTotal: total, bytesUsable: bytesVideo, bytesEmpty: Math.round(emptyBytes), usedReference: usedRef, warnings, verdict,
      summary: `Recovered ${mm}m ${ss}s of ${width}×${height} ${codec === 'hevc' ? 'HEVC' : 'H.264'} video${audioish ? ' (without sound)' : ''}${usedRef ? ' using your reference clip' : ''}.`,
    },
  };
}
