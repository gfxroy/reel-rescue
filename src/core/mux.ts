/**
 * MP4 / MOV container muxer: builds moov, tracks, sample tables, and the final MP4 Blob.
 */

import { writeBox, writeFullBox } from './boxes.js';

export interface VideoMuxTrack {
  codec: 'h264' | 'hevc';
  width: number;
  height: number;
  fps: number;
  timescale: number;
  sampleDelta: number;
  samples: { offset: number; size: number }[];
  keyframes: number[]; // 1-based indices
  avcC?: Uint8Array;
  hvcC?: Uint8Array;
  /** per-sample composition offsets (in timescale units, >= 0) */
  compositionOffsets?: number[];
  /** media time where presentation starts (edit list), in timescale units */
  editMediaTime?: number;
}

export interface AudioMuxTrack {
  codec: 'aac' | 'pcm';
  timescale: number;
  sampleDelta: number;
  samples: { offset: number; size: number }[];
  channels: number;
  sampleRate: number;
  esds?: Uint8Array;
  pcmFormat?: 'sowt' | 'twos';
}

export interface MuxParams {
  container: 'mp4' | 'mov';
  video: VideoMuxTrack;
  audio?: AudioMuxTrack;
  mvhdTimescale?: number;
}

const UNITY_MATRIX = new Uint8Array([
  0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00
]);

function buildChunkOffsetBox(offsets: number[]): Uint8Array {
  const needs64 = offsets.some((o) => o > 0xffffffff);
  if (needs64) {
    const payload = new Uint8Array(4 + offsets.length * 8);
    const view = new DataView(payload.buffer);
    view.setUint32(0, offsets.length, false);
    for (let i = 0; i < offsets.length; i++) {
      const o = offsets[i];
      const high = Math.floor(o / 4294967296);
      const low = o >>> 0;
      view.setUint32(4 + i * 8, high, false);
      view.setUint32(8 + i * 8, low, false);
    }
    return writeFullBox('co64', 0, 0, payload);
  } else {
    const payload = new Uint8Array(4 + offsets.length * 4);
    const view = new DataView(payload.buffer);
    view.setUint32(0, offsets.length, false);
    for (let i = 0; i < offsets.length; i++) {
      view.setUint32(4 + i * 4, offsets[i], false);
    }
    return writeFullBox('stco', 0, 0, payload);
  }
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  let totalLen = 0;
  for (const a of arrays) totalLen += a.length;
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

export function buildFtypBox(container: 'mp4' | 'mov' = 'mp4'): Uint8Array {
  if (container === 'mov') {
    const payload = new Uint8Array(12);
    // major_brand 'qt  '
    payload.set([0x71, 0x74, 0x20, 0x20], 0);
    // minor_version 0x200
    new DataView(payload.buffer).setUint32(4, 0x200, false);
    // compatible_brand 'qt  '
    payload.set([0x71, 0x74, 0x20, 0x20], 8);
    return writeBox('ftyp', payload);
  } else {
    const payload = new Uint8Array(24);
    // isom
    payload.set([0x69, 0x73, 0x6f, 0x6d], 0);
    new DataView(payload.buffer).setUint32(4, 0x200, false);
    payload.set([0x69, 0x73, 0x6f, 0x6d], 8);
    payload.set([0x69, 0x73, 0x6f, 0x32], 12);
    payload.set([0x61, 0x76, 0x63, 0x31], 16);
    payload.set([0x6d, 0x70, 0x34, 0x31], 20);
    return writeBox('ftyp', payload);
  }
}

export function buildMdatHeader(payloadLength: number): Uint8Array {
  if (payloadLength + 8 > 0xffffffff) {
    const out = new Uint8Array(16);
    const view = new DataView(out.buffer);
    view.setUint32(0, 1, false);
    out.set([0x6d, 0x64, 0x61, 0x74], 4);
    const totalSize = payloadLength + 16;
    view.setUint32(8, Math.floor(totalSize / 4294967296), false);
    view.setUint32(12, totalSize >>> 0, false);
    return out;
  } else {
    const out = new Uint8Array(8);
    const view = new DataView(out.buffer);
    view.setUint32(0, payloadLength + 8, false);
    out.set([0x6d, 0x64, 0x61, 0x74], 4);
    return out;
  }
}

export function buildMoov(params: MuxParams): Uint8Array {
  const mvhdTimescale = params.mvhdTimescale ?? 1000;
  const numVideoFrames = params.video.samples.length;
  const videoDurationInSeconds = (numVideoFrames * params.video.sampleDelta) / (params.video.timescale || 1);
  const mvDuration = Math.round(videoDurationInSeconds * mvhdTimescale);

  // Common dinf
  const drefPayload = new Uint8Array(4 + 12);
  new DataView(drefPayload.buffer).setUint32(0, 1, false);
  drefPayload.set(writeFullBox('url ', 0, 1, new Uint8Array(0)), 4);
  const dinf = writeBox('dinf', writeFullBox('dref', 0, 0, drefPayload));

  // --- Video trak ---
  const vSampleCount = params.video.samples.length;
  const vDurationInTimescale = vSampleCount * params.video.sampleDelta;

  // VisualSampleEntry
  const visualEntryPayload = new Uint8Array(78);
  const visualView = new DataView(visualEntryPayload.buffer);
  visualView.setUint16(6, 1, false); // data_reference_index
  visualView.setUint16(24, params.video.width, false);
  visualView.setUint16(26, params.video.height, false);
  visualView.setUint32(28, 0x00480000, false); // 72 dpi
  visualView.setUint32(32, 0x00480000, false);
  visualView.setUint16(40, 1, false); // frame_count
  visualView.setUint16(74, 0x0018, false); // depth (24)
  visualView.setInt16(76, -1, false);

  let visualSampleEntry: Uint8Array;
  if (params.video.codec === 'hevc') {
    const hvcCBox = writeBox('hvcC', params.video.hvcC ?? new Uint8Array(0));
    visualSampleEntry = writeBox('hvc1', concatUint8Arrays([visualEntryPayload, hvcCBox]));
  } else {
    const avcCBox = writeBox('avcC', params.video.avcC ?? new Uint8Array(0));
    visualSampleEntry = writeBox('avc1', concatUint8Arrays([visualEntryPayload, avcCBox]));
  }

  // Video stsd
  const vStsdPayload = new Uint8Array(4 + visualSampleEntry.length);
  new DataView(vStsdPayload.buffer).setUint32(0, 1, false);
  vStsdPayload.set(visualSampleEntry, 4);
  const vStsd = writeFullBox('stsd', 0, 0, vStsdPayload);

  // Video stts
  const vSttsPayload = new Uint8Array(12);
  const vSttsView = new DataView(vSttsPayload.buffer);
  vSttsView.setUint32(0, 1, false); // entry_count
  vSttsView.setUint32(4, vSampleCount, false);
  vSttsView.setUint32(8, params.video.sampleDelta, false);
  const vStts = writeFullBox('stts', 0, 0, vSttsPayload);

  // Video stss (sync samples / keyframes)
  const vKeyframes = params.video.keyframes.length > 0 ? params.video.keyframes : [1];
  const vStssPayload = new Uint8Array(4 + vKeyframes.length * 4);
  const vStssView = new DataView(vStssPayload.buffer);
  vStssView.setUint32(0, vKeyframes.length, false);
  for (let i = 0; i < vKeyframes.length; i++) {
    vStssView.setUint32(4 + i * 4, vKeyframes[i], false);
  }
  const vStss = writeFullBox('stss', 0, 0, vStssPayload);

  // Video stsc
  const vStscPayload = new Uint8Array(4 + 12);
  const vStscView = new DataView(vStscPayload.buffer);
  vStscView.setUint32(0, 1, false); // 1 entry
  vStscView.setUint32(4, 1, false); // first_chunk
  vStscView.setUint32(8, 1, false); // samples_per_chunk
  vStscView.setUint32(12, 1, false); // sample_description_index
  const vStsc = writeFullBox('stsc', 0, 0, vStscPayload);

  // Video stsz
  const vStszPayload = new Uint8Array(8 + vSampleCount * 4);
  const vStszView = new DataView(vStszPayload.buffer);
  vStszView.setUint32(0, 0, false); // sample_size = 0 (variable)
  vStszView.setUint32(4, vSampleCount, false);
  for (let i = 0; i < vSampleCount; i++) {
    vStszView.setUint32(8 + i * 4, params.video.samples[i].size, false);
  }
  const vStsz = writeFullBox('stsz', 0, 0, vStszPayload);

  // Video stco / co64
  const vOffsets = params.video.samples.map((s) => s.offset);
  const vStco = buildChunkOffsetBox(vOffsets);

  const vExtra: Uint8Array[] = [];
  const co = params.video.compositionOffsets;
  if (co && co.length === vSampleCount && co.some((x) => x !== 0)) {
    const runs: [number, number][] = [];
    for (const x of co) { const l = runs[runs.length - 1]; if (l && l[1] === x) l[0]++; else runs.push([1, x]); }
    const cp = new Uint8Array(4 + runs.length * 8); const cv = new DataView(cp.buffer);
    cv.setUint32(0, runs.length, false);
    runs.forEach(([n, x], i) => { cv.setUint32(4 + i * 8, n, false); cv.setUint32(8 + i * 8, x, false); });
    vExtra.push(writeFullBox('ctts', 0, 0, cp));
  }
  const vStbl = writeBox('stbl', concatUint8Arrays([vStsd, vStts, ...vExtra, vStss, vStsc, vStsz, vStco]));
  const vmhd = writeFullBox('vmhd', 0, 1, new Uint8Array(8));
  const vMinf = writeBox('minf', concatUint8Arrays([vmhd, dinf, vStbl]));

  // Video hdlr
  const vHdlrPayload = new Uint8Array(20 + 13);
  vHdlrPayload.set([0x76, 0x69, 0x64, 0x65], 8); // 'vide'
  const vHdlrName = 'VideoHandler\0';
  for (let i = 0; i < vHdlrName.length; i++) {
    vHdlrPayload[20 + i] = vHdlrName.charCodeAt(i);
  }
  const vHdlr = writeFullBox('hdlr', 0, 0, vHdlrPayload);

  // Video mdhd
  const vMdhdPayload = new Uint8Array(20);
  const vMdhdView = new DataView(vMdhdPayload.buffer);
  vMdhdView.setUint32(8, params.video.timescale, false);
  vMdhdView.setUint32(12, vDurationInTimescale, false);
  vMdhdView.setUint16(16, 0x55c4, false); // 'und'
  const vMdhd = writeFullBox('mdhd', 0, 0, vMdhdPayload);

  const vMdia = writeBox('mdia', concatUint8Arrays([vMdhd, vHdlr, vMinf]));

  // Video tkhd
  const vTkhdPayload = new Uint8Array(80);
  const vTkhdView = new DataView(vTkhdPayload.buffer);
  vTkhdView.setUint32(8, 1, false); // track_id = 1
  vTkhdView.setUint32(16, mvDuration, false);
  vTkhdPayload.set(UNITY_MATRIX, 32);
  vTkhdView.setUint32(68, params.video.width << 16, false);
  vTkhdView.setUint32(72, params.video.height << 16, false);
  const vTkhd = writeFullBox('tkhd', 0, 7, vTkhdPayload);

  const vTrakParts = [vTkhd];
  if (params.video.editMediaTime && params.video.editMediaTime > 0) {
    const ep = new Uint8Array(16); const ev = new DataView(ep.buffer);
    ev.setUint32(0, 1, false); ev.setUint32(4, mvDuration, false);
    ev.setUint32(8, params.video.editMediaTime, false); ev.setUint32(12, 0x00010000, false);
    vTrakParts.push(writeBox('edts', writeFullBox('elst', 0, 0, ep)));
  }
  const vTrak = writeBox('trak', concatUint8Arrays([...vTrakParts, vMdia]));

  const trakBoxes: Uint8Array[] = [vTrak];

  // --- Audio trak (if present) ---
  if (params.audio && params.audio.samples.length > 0) {
    const aSampleCount = params.audio.samples.length;
    const aDurationInTimescale = aSampleCount * params.audio.sampleDelta;

    // AudioSampleEntry
    const isPcm = params.audio.codec === 'pcm';
    const entryType = isPcm ? (params.audio.pcmFormat ?? 'sowt') : 'mp4a';
    const audioEntryHeader = new Uint8Array(28);
    const audioEntryView = new DataView(audioEntryHeader.buffer);
    audioEntryView.setUint16(6, 1, false); // data_reference_index
    audioEntryView.setUint16(16, params.audio.channels || 1, false);
    audioEntryView.setUint16(18, 16, false); // 16-bit
    audioEntryView.setUint32(24, (params.audio.sampleRate || 44100) << 16, false);

    let audioEntry: Uint8Array;
    if (isPcm) {
      audioEntry = writeBox(entryType, audioEntryHeader);
    } else {
      const esdsBox = writeFullBox('esds', 0, 0, params.audio.esds ?? new Uint8Array(0));
      audioEntry = writeBox('mp4a', concatUint8Arrays([audioEntryHeader, esdsBox]));
    }

    const aStsdPayload = new Uint8Array(4 + audioEntry.length);
    new DataView(aStsdPayload.buffer).setUint32(0, 1, false);
    aStsdPayload.set(audioEntry, 4);
    const aStsd = writeFullBox('stsd', 0, 0, aStsdPayload);

    // Audio stts
    const aSttsPayload = new Uint8Array(12);
    const aSttsView = new DataView(aSttsPayload.buffer);
    aSttsView.setUint32(0, 1, false);
    aSttsView.setUint32(4, aSampleCount, false);
    aSttsView.setUint32(8, params.audio.sampleDelta, false);
    const aStts = writeFullBox('stts', 0, 0, aSttsPayload);

    // Audio stsc
    const aStscPayload = new Uint8Array(4 + 12);
    const aStscView = new DataView(aStscPayload.buffer);
    aStscView.setUint32(0, 1, false);
    aStscView.setUint32(4, 1, false);
    aStscView.setUint32(8, 1, false);
    aStscView.setUint32(12, 1, false);
    const aStsc = writeFullBox('stsc', 0, 0, aStscPayload);

    // Audio stsz
    const aStszPayload = new Uint8Array(8 + aSampleCount * 4);
    const aStszView = new DataView(aStszPayload.buffer);
    aStszView.setUint32(0, 0, false);
    aStszView.setUint32(4, aSampleCount, false);
    for (let i = 0; i < aSampleCount; i++) {
      aStszView.setUint32(8 + i * 4, params.audio.samples[i].size, false);
    }
    const aStsz = writeFullBox('stsz', 0, 0, aStszPayload);

    // Audio stco / co64
    const aOffsets = params.audio.samples.map((s) => s.offset);
    const aStco = buildChunkOffsetBox(aOffsets);

    const aStbl = writeBox('stbl', concatUint8Arrays([aStsd, aStts, aStsc, aStsz, aStco]));
    const smhd = writeFullBox('smhd', 0, 0, new Uint8Array(4));
    const aMinf = writeBox('minf', concatUint8Arrays([smhd, dinf, aStbl]));

    // Audio hdlr
    const aHdlrPayload = new Uint8Array(20 + 13);
    aHdlrPayload.set([0x73, 0x6f, 0x75, 0x6e], 8); // 'soun'
    const aHdlrName = 'SoundHandler\0';
    for (let i = 0; i < aHdlrName.length; i++) {
      aHdlrPayload[20 + i] = aHdlrName.charCodeAt(i);
    }
    const aHdlr = writeFullBox('hdlr', 0, 0, aHdlrPayload);

    // Audio mdhd
    const aMdhdPayload = new Uint8Array(20);
    const aMdhdView = new DataView(aMdhdPayload.buffer);
    aMdhdView.setUint32(8, params.audio.timescale, false);
    aMdhdView.setUint32(12, aDurationInTimescale, false);
    aMdhdView.setUint16(16, 0x55c4, false);
    const aMdhd = writeFullBox('mdhd', 0, 0, aMdhdPayload);

    const aMdia = writeBox('mdia', concatUint8Arrays([aMdhd, aHdlr, aMinf]));

    // Audio tkhd
    const aTkhdPayload = new Uint8Array(80);
    const aTkhdView = new DataView(aTkhdPayload.buffer);
    aTkhdView.setUint32(8, 2, false); // track_id = 2
    aTkhdView.setUint32(16, mvDuration, false);
    aTkhdView.setUint16(36, 0x0100, false); // volume = 1.0
    aTkhdPayload.set(UNITY_MATRIX, 32);
    const aTkhd = writeFullBox('tkhd', 0, 7, aTkhdPayload);

    const aTrak = writeBox('trak', concatUint8Arrays([aTkhd, aMdia]));
    trakBoxes.push(aTrak);
  }

  // --- mvhd ---
  const mvhdPayload = new Uint8Array(96);
  const mvhdView = new DataView(mvhdPayload.buffer);
  mvhdView.setUint32(8, mvhdTimescale, false);
  mvhdView.setUint32(12, mvDuration, false);
  mvhdView.setUint32(16, 0x00010000, false); // rate = 1.0
  mvhdView.setUint16(20, 0x0100, false); // volume = 1.0
  mvhdPayload.set(UNITY_MATRIX, 32);
  mvhdView.setUint32(68, trakBoxes.length + 1, false); // next_track_id
  const mvhd = writeFullBox('mvhd', 0, 0, mvhdPayload);

  return writeBox('moov', concatUint8Arrays([mvhd, ...trakBoxes]));
}
