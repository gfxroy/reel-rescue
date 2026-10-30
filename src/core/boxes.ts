/**
 * ISO Base Media File Format (MP4 / MOV) box reader, writer, and reference inspector.
 */

export interface BoxHeader {
  type: string;
  size: number; // total box size (including header)
  headerSize: number; // 8 or 16
  offset: number;
}

export function writeBox(type: string, payload: Uint8Array): Uint8Array {
  const size = payload.length + 8;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, size, false);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(payload, 8);
  return out;
}

export function writeFullBox(type: string, version: number, flags: number, payload: Uint8Array): Uint8Array {
  const size = payload.length + 12;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setUint32(0, size, false);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }
  view.setUint32(8, (version << 24) | (flags & 0x00ffffff), false);
  out.set(payload, 12);
  return out;
}

export interface ParsedBox {
  type: string;
  size: number;
  headerSize: number;
  start: number;
  payloadStart: number;
  payloadEnd: number;
}

export function findTopLevelBoxes(data: Uint8Array, maxOffset = data.length): ParsedBox[] {
  const boxes: ParsedBox[] = [];
  let p = 0;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  while (p + 8 <= maxOffset) {
    let size = view.getUint32(p, false);
    const type = String.fromCharCode(data[p + 4], data[p + 5], data[p + 6], data[p + 7]);
    let headerSize = 8;

    if (size === 1) {
      if (p + 16 > maxOffset) break;
      const high = view.getUint32(p + 8, false);
      const low = view.getUint32(p + 12, false);
      size = high * 4294967296 + low;
      headerSize = 16;
    } else if (size === 0) {
      size = maxOffset - p;
    }

    const payloadStart = p + headerSize;
    const payloadEnd = Math.min(maxOffset, p + size);

    boxes.push({
      type,
      size,
      headerSize,
      start: p,
      payloadStart,
      payloadEnd
    });

    if (size <= 0) break;
    p += size;
  }

  return boxes;
}

export function findBoxRecursive(data: Uint8Array, targetType: string, start = 0, end = data.length): Uint8Array | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let p = start;

  while (p + 8 <= end) {
    let size = view.getUint32(p, false);
    const type = String.fromCharCode(data[p + 4], data[p + 5], data[p + 6], data[p + 7]);
    let headerSize = 8;

    if (size === 1) {
      if (p + 16 > end) break;
      const high = view.getUint32(p + 8, false);
      const low = view.getUint32(p + 12, false);
      size = high * 4294967296 + low;
      headerSize = 16;
    } else if (size === 0) {
      size = end - p;
    }

    if (size < headerSize) break;

    const payloadStart = p + headerSize;
    const payloadEnd = Math.min(end, p + size);

    if (type === targetType) {
      return data.subarray(payloadStart, payloadEnd);
    }

    // Inspect container boxes
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'wave', 'dinf'].includes(type)) {
      const found = findBoxRecursive(data, targetType, payloadStart, payloadEnd);
      if (found) return found;
    } else if (type === 'stsd') {
      // stsd has 8 bytes (version/flags + entry count)
      if (payloadStart + 8 <= payloadEnd) {
        const found = findBoxRecursive(data, targetType, payloadStart + 8, payloadEnd);
        if (found) return found;
      }
    } else if (['avc1', 'hvc1'].includes(type)) {
      // Visual sample entry has 78 bytes header
      if (payloadStart + 70 <= payloadEnd) {
        const found = findBoxRecursive(data, targetType, payloadStart + 70, payloadEnd);
        if (found) return found;
      }
    } else if (['mp4a', 'sowt', 'twos'].includes(type)) {
      // Audio sample entry has 28 or 44 bytes header (QT v1)
      // Check for inner boxes starting at 28 or 44 or search through payload
      for (let offset = payloadStart + 28; offset + 8 <= payloadEnd; offset += 4) {
        const subType = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
        if (subType === targetType || ['esds', 'wave', 'chan'].includes(subType)) {
          const found = findBoxRecursive(data, targetType, offset, payloadEnd);
          if (found) return found;
        }
      }
    }

    p += size;
  }

  return null;
}

export interface ReferenceInfo {
  videoCodec: 'h264' | 'hevc' | 'unknown';
  audioCodec: 'aac' | 'pcm' | 'none' | 'unknown';
  width?: number;
  height?: number;
  mvhdTimescale: number;
  videoTimescale: number;
  audioTimescale: number;
  rawAvcC?: Uint8Array;
  rawHvcC?: Uint8Array;
  rawEsds?: Uint8Array;
  audioChannels: number;
  audioSampleRate: number;
  audioSampleSize: number;
  pcmFormat?: 'sowt' | 'twos';
}

export function parseReferenceMoov(data: Uint8Array): ReferenceInfo {
  const result: ReferenceInfo = {
    videoCodec: 'unknown',
    audioCodec: 'none',
    mvhdTimescale: 1000,
    videoTimescale: 30000,
    audioTimescale: 44100,
    audioChannels: 1,
    audioSampleRate: 44100,
    audioSampleSize: 16
  };

  const mvhd = findBoxRecursive(data, 'mvhd');
  if (mvhd && mvhd.length >= 20) {
    const view = new DataView(mvhd.buffer, mvhd.byteOffset, mvhd.byteLength);
    const version = mvhd[0];
    const tsOffset = version === 1 ? 20 : 12;
    if (mvhd.length >= tsOffset + 4) {
      result.mvhdTimescale = view.getUint32(tsOffset, false) || 1000;
    }
  }

  // Check for avcC or hvcC
  const avcC = findBoxRecursive(data, 'avcC');
  if (avcC) {
    result.videoCodec = 'h264';
    result.rawAvcC = avcC;
  }

  const hvcC = findBoxRecursive(data, 'hvcC');
  if (hvcC) {
    result.videoCodec = 'hevc';
    result.rawHvcC = hvcC;
  }

  // Check for tkhd (track 1 dimensions)
  const tkhd = findBoxRecursive(data, 'tkhd');
  if (tkhd && tkhd.length >= 84) {
    const view = new DataView(tkhd.buffer, tkhd.byteOffset, tkhd.byteLength);
    const version = tkhd[0];
    const dimOffset = version === 1 ? 88 : 76;
    if (tkhd.length >= dimOffset + 8) {
      const w = view.getUint32(dimOffset, false) >> 16;
      const h = view.getUint32(dimOffset + 4, false) >> 16;
      if (w > 0 && h > 0) {
        result.width = w;
        result.height = h;
      }
    }
  }

  // Check for esds or audio sample entries
  const esds = findBoxRecursive(data, 'esds');
  if (esds) {
    result.audioCodec = 'aac';
    result.rawEsds = esds;
  }

  if (findBoxRecursive(data, 'mp4a')) {
    result.audioCodec = 'aac';
  } else if (findBoxRecursive(data, 'sowt')) {
    result.audioCodec = 'pcm';
    result.pcmFormat = 'sowt';
  } else if (findBoxRecursive(data, 'twos')) {
    result.audioCodec = 'pcm';
    result.pcmFormat = 'twos';
  }

  return result;
}
