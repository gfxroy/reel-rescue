/**
 * Reads only the moov box of a reference clip (same camera + settings) using small slices,
 * so multi-GB references never load into memory.
 */
export interface RefTrack {
  handler: string; timescale: number; firstDelta?: number;
  sampleEntry?: string; avcC?: Uint8Array; hvcC?: Uint8Array; esds?: Uint8Array;
  width?: number; height?: number; channels?: number; sampleRate?: number;
}
export interface RefInfo { tracks: RefTrack[]; video?: RefTrack; audio?: RefTrack }

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const fourcc = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

export async function locateTopBox(file: Blob, type: string): Promise<{ start: number; header: number; size: number } | null> {
  let p = 0;
  while (p + 8 <= file.size) {
    const h = new Uint8Array(await file.slice(p, Math.min(file.size, p + 16)).arrayBuffer());
    let size = u32(h, 0); let header = 8;
    if (size === 1 && h.length >= 16) { size = u32(h, 8) * 4294967296 + u32(h, 12); header = 16; }
    else if (size === 0) size = file.size - p;
    if (size < header) return null;
    if (fourcc(h, 4) === type) return { start: p, header, size };
    p += size;
  }
  return null;
}

function* children(b: Uint8Array, start: number, end: number): Generator<{ type: string; ps: number; end: number }> {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p); let hs = 8;
    if (size === 1) { size = u32(b, p + 8) * 4294967296 + u32(b, p + 12); hs = 16; } else if (size === 0) size = end - p;
    if (size < hs || p + size > end) return;
    yield { type: fourcc(b, p + 4), ps: p + hs, end: p + size };
    p += size;
  }
}
const child = (b: Uint8Array, s: number, e: number, t: string) => { for (const c of children(b, s, e)) if (c.type === t) return c; return undefined; };

export function parseMoov(m: Uint8Array): RefInfo {
  const tracks: RefTrack[] = [];
  for (const trak of children(m, 0, m.length)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(m, trak.ps, trak.end, 'mdia'); if (!mdia) continue;
    const mdhd = child(m, mdia.ps, mdia.end, 'mdhd'); const hdlr = child(m, mdia.ps, mdia.end, 'hdlr');
    const t: RefTrack = { handler: hdlr ? fourcc(m, hdlr.ps + 8) : '', timescale: 0 };
    if (mdhd) t.timescale = u32(m, mdhd.ps + (m[mdhd.ps] === 1 ? 20 : 12));
    const minf = child(m, mdia.ps, mdia.end, 'minf'); const stbl = minf && child(m, minf.ps, minf.end, 'stbl');
    if (stbl) {
      const stts = child(m, stbl.ps, stbl.end, 'stts');
      if (stts && u32(m, stts.ps + 4) > 0) t.firstDelta = u32(m, stts.ps + 12);
      const stsd = child(m, stbl.ps, stbl.end, 'stsd');
      if (stsd) {
        const e = children(m, stsd.ps + 8, stsd.end).next().value as { type: string; ps: number; end: number } | undefined;
        if (e) {
          t.sampleEntry = e.type;
          if (t.handler === 'vide') {
            t.width = (m[e.ps + 24] << 8) | m[e.ps + 25]; t.height = (m[e.ps + 26] << 8) | m[e.ps + 27];
            for (const c of children(m, e.ps + 78, e.end)) {
              if (c.type === 'avcC') t.avcC = m.slice(c.ps, c.end);
              if (c.type === 'hvcC') t.hvcC = m.slice(c.ps, c.end);
            }
          } else if (t.handler === 'soun') {
            t.channels = (m[e.ps + 16] << 8) | m[e.ps + 17];
            t.sampleRate = (m[e.ps + 24] << 8) | m[e.ps + 25];
            const ver = (m[e.ps + 8] << 8) | m[e.ps + 9];
            const off = e.ps + 28 + (ver === 1 ? 16 : ver === 2 ? 36 : 0);
            for (const c of children(m, off, e.end)) {
              if (c.type === 'esds') t.esds = m.slice(c.ps, c.end);
              if (c.type === 'wave') for (const w of children(m, c.ps, c.end)) if (w.type === 'esds') t.esds = m.slice(w.ps, w.end);
            }
          }
        }
      }
    }
    tracks.push(t);
  }
  return { tracks, video: tracks.find((t) => t.handler === 'vide'), audio: tracks.find((t) => t.handler === 'soun') };
}

export async function readReference(file: Blob): Promise<RefInfo | null> {
  const box = await locateTopBox(file, 'moov');
  if (!box || box.size > 64 * 1024 * 1024 || box.start + box.size > file.size) return null;
  const m = new Uint8Array(await file.slice(box.start + box.header, box.start + box.size).arrayBuffer());
  return parseMoov(m);
}
