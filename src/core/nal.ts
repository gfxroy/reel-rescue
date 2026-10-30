/**
 * NAL unit processing, parameter set parsing (SPS/PPS/VPS),
 * avcC / hvcC reconstruction, and Access Unit demarcation.
 */

import { BitReader, stripEmulationPrevention } from './bitreader.js';

export interface SpsInfo {
  width: number;
  height: number;
  fps?: number;
  log2MaxFrameNum?: number;
  pocType?: number;
  log2MaxPocLsb?: number;
  frameMbsOnly?: number;
  separateColourPlane?: number;
}

// Fallback SPS / PPS for H.264 (640x360 30fps)
export const DEFAULT_H264_SPS = new Uint8Array([
  0x67, 0x64, 0x00, 0x1e, 0xac, 0xd9, 0x40, 0xa0,
  0x2f, 0xf9, 0x70, 0x11, 0x00, 0x00, 0x03, 0x00,
  0x01, 0x00, 0x00, 0x03, 0x00, 0x3c, 0x0f, 0x16,
  0x2d, 0x96
]);

export const DEFAULT_H264_PPS = new Uint8Array([
  0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0
]);

// Fallback VPS / SPS / PPS for HEVC (640x360 30fps)
export const DEFAULT_HEVC_VPS = new Uint8Array([
  0x40, 0x01, 0x0c, 0x01, 0xff, 0xff, 0x04, 0x08,
  0x00, 0x00, 0x03, 0x00, 0x9e, 0x08, 0x00, 0x00,
  0x03, 0x00, 0x00, 0x3f, 0x95, 0x98, 0x09
]);

export const DEFAULT_HEVC_SPS = new Uint8Array([
  0x42, 0x01, 0x01, 0x04, 0x08, 0x00, 0x00, 0x03,
  0x00, 0x9e, 0x08, 0x00, 0x00, 0x03, 0x00, 0x00,
  0x3f, 0x90, 0x00, 0xa0, 0x40, 0x2d, 0x2c, 0xb2,
  0xb3, 0x49, 0x26, 0x57, 0x80, 0xb7, 0x02, 0x02,
  0x00, 0x04, 0x00, 0x00, 0x03, 0x00, 0x04, 0x00,
  0x00, 0x03, 0x00, 0x78, 0x20
]);

export const DEFAULT_HEVC_PPS = new Uint8Array([
  0x44, 0x01, 0xc1, 0x72, 0x86, 0x0c, 0x46, 0x24
]);

export function parseH264Sps(sps: Uint8Array): SpsInfo | null {
  try {
    const rbsp = stripEmulationPrevention(sps, 1);
    const br = new BitReader(rbsp);

    const profileIdc = br.readBits(8);
    br.readBits(8); // constraint flags
    br.readBits(8); // level_idc
    br.readUe(); // seq_parameter_set_id

    let chromaFormatIdc = 1;
    let separateColourPlane = 0;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
      chromaFormatIdc = br.readUe();
      if (chromaFormatIdc === 3) {
        separateColourPlane = br.readBit();
      }
      br.readUe(); // bit_depth_luma_minus8
      br.readUe(); // bit_depth_chroma_minus8
      br.readBit(); // qpprime_y_zero_transform_bypass_flag
      const seqScalingMatrixPresent = br.readBit();
      if (seqScalingMatrixPresent) {
        const count = chromaFormatIdc !== 3 ? 8 : 12;
        for (let i = 0; i < count; i++) {
          if (br.readBit()) {
            const size = i < 6 ? 16 : 64;
            let lastScale = 8;
            let nextScale = 8;
            for (let j = 0; j < size; j++) {
              if (nextScale !== 0) {
                const deltaScale = br.readSe();
                nextScale = (lastScale + deltaScale + 256) % 256;
              }
              lastScale = nextScale === 0 ? lastScale : nextScale;
            }
          }
        }
      }
    }

    const log2MaxFrameNum = br.readUe() + 4;
    const picOrderCntType = br.readUe();
    let log2MaxPocLsb = 0;
    if (picOrderCntType === 0) {
      log2MaxPocLsb = br.readUe() + 4;
    } else if (picOrderCntType === 1) {
      br.readBit(); // delta_pic_order_always_zero_flag
      br.readSe(); // offset_for_non_ref_pic
      br.readSe(); // offset_for_top_to_bottom_field
      const numRefFramesInPicOrderCntCycle = br.readUe();
      for (let i = 0; i < numRefFramesInPicOrderCntCycle; i++) {
        br.readSe();
      }
    }

    br.readUe(); // max_num_ref_frames
    br.readBit(); // gaps_in_frame_num_value_allowed_flag

    const picWidthInMbsMinus1 = br.readUe();
    const picHeightInMapUnitsMinus1 = br.readUe();
    const frameMbsOnlyFlag = br.readBit();
    if (!frameMbsOnlyFlag) {
      br.readBit(); // mb_adaptive_frame_field_flag
    }
    br.readBit(); // direct_8x8_inference_flag

    const frameCroppingFlag = br.readBit();
    let cropLeft = 0;
    let cropRight = 0;
    let cropTop = 0;
    let cropBottom = 0;
    if (frameCroppingFlag) {
      cropLeft = br.readUe();
      cropRight = br.readUe();
      cropTop = br.readUe();
      cropBottom = br.readUe();
    }

    const cropUnitX = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1;
    const cropUnitY = (2 - frameMbsOnlyFlag) * (chromaFormatIdc === 1 ? 2 : 1);

    const width = (picWidthInMbsMinus1 + 1) * 16 - (cropLeft + cropRight) * cropUnitX;
    const height = (2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16 - (cropTop + cropBottom) * cropUnitY;

    let fps: number | undefined;
    const vuiParametersPresentFlag = br.readBit();
    if (vuiParametersPresentFlag) {
      const aspectRatioInfoPresent = br.readBit();
      if (aspectRatioInfoPresent) {
        const aspectIdc = br.readBits(8);
        if (aspectIdc === 255) {
          br.readBits(32); // sar_width & sar_height
        }
      }
      if (br.readBit()) br.readBit(); // overscan_info_present
      if (br.readBit()) { // video_signal_type_present
        br.readBits(4);
        if (br.readBit()) br.readBits(24);
      }
      if (br.readBit()) { // chroma_loc_info_present
        br.readUe();
        br.readUe();
      }
      const timingInfoPresent = br.readBit();
      if (timingInfoPresent) {
        const numUnitsInTick = br.readBits(32) >>> 0;
        const timeScale = br.readBits(32) >>> 0;
        if (numUnitsInTick > 0) {
          fps = timeScale / (2 * numUnitsInTick);
        }
      }
    }

    return { width, height, fps, log2MaxFrameNum, pocType: picOrderCntType, log2MaxPocLsb, frameMbsOnly: frameMbsOnlyFlag, separateColourPlane };
  } catch {
    return null;
  }
}

export function parseHevcSps(sps: Uint8Array): SpsInfo | null {
  try {
    const rbsp = stripEmulationPrevention(sps, 2);
    const br = new BitReader(rbsp);

    br.readBits(4); // sps_video_parameter_set_id
    const maxSubLayers = br.readBits(3);
    br.readBit(); // sps_temporal_id_nesting_flag

    // profile_tier_level
    br.readBits(2); // profile_space
    br.readBit(); // tier_flag
    br.readBits(5); // profile_idc
    br.readBits(32); // profile_compatibility_flags
    br.readBits(48); // constraint_flags
    br.readBits(8); // level_idc

    const subLayerProfilePresent: number[] = [];
    const subLayerLevelPresent: number[] = [];
    for (let i = 0; i < maxSubLayers; i++) {
      subLayerProfilePresent.push(br.readBit());
      subLayerLevelPresent.push(br.readBit());
    }
    if (maxSubLayers > 0) {
      for (let i = maxSubLayers; i < 8; i++) {
        br.readBits(2);
      }
    }
    for (let i = 0; i < maxSubLayers; i++) {
      if (subLayerProfilePresent[i]) br.readBits(88);
      if (subLayerLevelPresent[i]) br.readBits(8);
    }

    br.readUe(); // sps_seq_parameter_set_id
    const chromaFormatIdc = br.readUe();
    let separateColourPlane = 0;
    if (chromaFormatIdc === 3) separateColourPlane = br.readBit();

    const picWidth = br.readUe();
    const picHeight = br.readUe();

    let cropLeft = 0;
    let cropRight = 0;
    let cropTop = 0;
    let cropBottom = 0;
    const conformanceWindow = br.readBit();
    if (conformanceWindow) {
      cropLeft = br.readUe();
      cropRight = br.readUe();
      cropTop = br.readUe();
      cropBottom = br.readUe();
    }

    const subWidthC = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1;
    const subHeightC = chromaFormatIdc === 1 ? 2 : 1;
    const width = picWidth - (cropLeft + cropRight) * subWidthC;
    const height = picHeight - (cropTop + cropBottom) * subHeightC;

    br.readUe(); // bit_depth_luma_minus8
    br.readUe(); // bit_depth_chroma_minus8
    const log2MaxPocLsb = br.readUe() + 4;
    return { width, height, log2MaxPocLsb, separateColourPlane };
  } catch {
    return null;
  }
}

export function buildAvcC(spsList: Uint8Array[], ppsList: Uint8Array[]): Uint8Array {
  const sps = spsList[0] ?? DEFAULT_H264_SPS;
  const pps = ppsList[0] ?? DEFAULT_H264_PPS;

  let totalLen = 7;
  for (const s of spsList) totalLen += 2 + s.length;
  for (const p of ppsList) totalLen += 2 + p.length;

  const out = new Uint8Array(totalLen);
  out[0] = 1; // configurationVersion
  out[1] = sps[1]; // AVCProfileIndication
  out[2] = sps[2]; // profile_compatibility
  out[3] = sps[3]; // AVCLevelIndication
  out[4] = 0xff; // lengthSizeMinusOne (3)
  out[5] = 0xe0 | (spsList.length & 0x1f); // numOfSequenceParameterSets

  let offset = 6;
  const view = new DataView(out.buffer);
  for (const s of spsList) {
    view.setUint16(offset, s.length, false);
    offset += 2;
    out.set(s, offset);
    offset += s.length;
  }

  out[offset++] = ppsList.length; // numOfPictureParameterSets
  for (const p of ppsList) {
    view.setUint16(offset, p.length, false);
    offset += 2;
    out.set(p, offset);
    offset += p.length;
  }

  return out;
}

export function buildHvcC(vpsList: Uint8Array[], spsList: Uint8Array[], ppsList: Uint8Array[]): Uint8Array {
  const sps = spsList[0] ?? DEFAULT_HEVC_SPS;

  // Extract profile/tier/level from sps if available
  let profileSpace = 0;
  let tierFlag = 0;
  let profileIdc = 1;
  let profileCompat = 0x60000000;
  let levelIdc = 90;

  if (sps.length > 12) {
    profileSpace = (sps[3] >> 6) & 0x03;
    tierFlag = (sps[3] >> 5) & 0x01;
    profileIdc = sps[3] & 0x1f;
    const viewSps = new DataView(sps.buffer, sps.byteOffset, sps.byteLength);
    profileCompat = viewSps.getUint32(4, false);
    levelIdc = sps[12];
  }

  const arrays: { type: number; nals: Uint8Array[] }[] = [];
  if (vpsList.length > 0) arrays.push({ type: 32, nals: vpsList });
  if (spsList.length > 0) arrays.push({ type: 33, nals: spsList });
  if (ppsList.length > 0) arrays.push({ type: 34, nals: ppsList });

  let totalSize = 23;
  for (const arr of arrays) {
    totalSize += 3;
    for (const nal of arr.nals) {
      totalSize += 2 + nal.length;
    }
  }

  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);

  out[0] = 1; // configurationVersion
  out[1] = (profileSpace << 6) | (tierFlag << 5) | (profileIdc & 0x1f);
  view.setUint32(2, profileCompat, false);
  // 6 bytes constraint indicator flags
  out[6] = 0x90;
  out[12] = levelIdc;
  view.setUint16(13, 0xf000, false); // min_spatial_segmentation_idc
  out[15] = 0xfc; // parallelismType
  out[16] = 0xfd; // chromaFormat (4:2:0)
  out[17] = 0xf8; // bitDepthLumaMinus8 (0)
  out[18] = 0xf8; // bitDepthChromaMinus8 (0)
  view.setUint16(19, 0, false); // avgFrameRate
  out[21] = 0x0f; // constantFrameRate(0), numTemporalLayers(1), temporalIdNested(1), lengthSizeMinusOne(3)
  out[22] = arrays.length;

  let offset = 23;
  for (const arr of arrays) {
    out[offset++] = (1 << 7) | (arr.type & 0x3f); // array_completeness=1
    view.setUint16(offset, arr.nals.length, false);
    offset += 2;
    for (const nal of arr.nals) {
      view.setUint16(offset, nal.length, false);
      offset += 2;
      out.set(nal, offset);
      offset += nal.length;
    }
  }

  return out;
}

export interface HevcPpsInfo { numExtraSliceHeaderBits: number; outputFlagPresent: number }

export function parseHevcPps(pps: Uint8Array): HevcPpsInfo | null {
  try {
    const br = new BitReader(stripEmulationPrevention(pps, 2));
    br.readUe(); br.readUe();
    br.readBit(); // dependent_slice_segments_enabled_flag
    const outputFlagPresent = br.readBit();
    const numExtraSliceHeaderBits = br.readBits(3);
    return { numExtraSliceHeaderBits, outputFlagPresent };
  } catch { return null; }
}

/** Picture order count LSB from the first slice header of an access unit (null if not derivable). */
export function sliceH264PocLsb(header: Uint8Array, sps: SpsInfo): number | null {
  if (sps.pocType !== 0 || !sps.log2MaxPocLsb || !sps.log2MaxFrameNum) return null;
  const nut = header[0] & 0x1f;
  const br = new BitReader(stripEmulationPrevention(header, 1));
  br.readUe(); br.readUe(); br.readUe();
  if (sps.separateColourPlane) br.readBits(2);
  br.readBits(sps.log2MaxFrameNum);
  if (!sps.frameMbsOnly) { if (br.readBit()) br.readBit(); }
  if (nut === 5) br.readUe();
  return br.readBits(sps.log2MaxPocLsb);
}

export function sliceHevcPocLsb(header: Uint8Array, sps: SpsInfo, pps: HevcPpsInfo): number | null {
  if (!sps.log2MaxPocLsb) return null;
  const nut = (header[0] >> 1) & 0x3f;
  if (nut === 19 || nut === 20) return 0;
  const br = new BitReader(stripEmulationPrevention(header, 2));
  br.readBit(); // first_slice_segment_in_pic_flag
  if (nut >= 16 && nut <= 23) br.readBit();
  br.readUe();
  br.readBits(pps.numExtraSliceHeaderBits);
  br.readUe();
  if (pps.outputFlagPresent) br.readBit();
  if (sps.separateColourPlane) br.readBits(2);
  return br.readBits(sps.log2MaxPocLsb);
}

/** Split an avcC / hvcC record into its parameter-set NAL units. */
export function paramSetsFromAvcC(avcC: Uint8Array): { sps: Uint8Array[]; pps: Uint8Array[] } {
  const sps: Uint8Array[] = []; const pps: Uint8Array[] = [];
  let p = 5; const ns = avcC[p++] & 0x1f;
  for (let i = 0; i < ns && p + 2 <= avcC.length; i++) { const l = (avcC[p] << 8) | avcC[p + 1]; sps.push(avcC.slice(p + 2, p + 2 + l)); p += 2 + l; }
  const np = avcC[p++] ?? 0;
  for (let i = 0; i < np && p + 2 <= avcC.length; i++) { const l = (avcC[p] << 8) | avcC[p + 1]; pps.push(avcC.slice(p + 2, p + 2 + l)); p += 2 + l; }
  return { sps, pps };
}

export function paramSetsFromHvcC(hvcC: Uint8Array): { vps: Uint8Array[]; sps: Uint8Array[]; pps: Uint8Array[] } {
  const out = { vps: [] as Uint8Array[], sps: [] as Uint8Array[], pps: [] as Uint8Array[] };
  let p = 22; const na = hvcC[p++] ?? 0;
  for (let a = 0; a < na && p + 3 <= hvcC.length; a++) {
    const t = hvcC[p] & 0x3f; const n = (hvcC[p + 1] << 8) | hvcC[p + 2]; p += 3;
    for (let i = 0; i < n && p + 2 <= hvcC.length; i++) {
      const l = (hvcC[p] << 8) | hvcC[p + 1]; const nal = hvcC.slice(p + 2, p + 2 + l); p += 2 + l;
      if (t === 32) out.vps.push(nal); else if (t === 33) out.sps.push(nal); else if (t === 34) out.pps.push(nal);
    }
  }
  return out;
}
