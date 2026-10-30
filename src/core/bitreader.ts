/**
 * BitReader and bitstream parsing utilities for H.264 / HEVC parameter sets and slice headers.
 */

export function stripEmulationPrevention(data: Uint8Array, start = 0, end?: number): Uint8Array {
  const sliceEnd = end ?? data.length;
  const out = new Uint8Array(sliceEnd - start);
  let outIdx = 0;
  let i = start;
  while (i < sliceEnd) {
    if (i + 2 < sliceEnd && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 3) {
      out[outIdx++] = data[i];
      out[outIdx++] = data[i + 1];
      i += 3;
    } else {
      out[outIdx++] = data[i++];
    }
  }
  return out.subarray(0, outIdx);
}

export class BitReader {
  private data: Uint8Array;
  private bitPos = 0;
  private totalBits: number;

  constructor(data: Uint8Array) {
    this.data = data;
    this.totalBits = data.length * 8;
  }

  get bitsLeft(): number {
    return Math.max(0, this.totalBits - this.bitPos);
  }

  hasMoreBits(): boolean {
    return this.bitPos < this.totalBits;
  }

  readBit(): number {
    if (this.bitPos >= this.totalBits) return 0;
    const byte = this.data[this.bitPos >> 3];
    const bit = (byte >> (7 - (this.bitPos & 7))) & 1;
    this.bitPos++;
    return bit;
  }

  readBits(n: number): number {
    let val = 0;
    for (let i = 0; i < n; i++) {
      val = (val << 1) | this.readBit();
    }
    return val;
  }

  skipBits(n: number): void {
    this.bitPos = Math.min(this.totalBits, this.bitPos + n);
  }

  readUe(): number {
    let zeros = 0;
    while (this.readBit() === 0 && this.bitPos < this.totalBits) {
      zeros++;
    }
    if (zeros === 0) return 0;
    const val = this.readBits(zeros);
    return ((1 << zeros) - 1) + val;
  }

  readSe(): number {
    const val = this.readUe();
    if (val & 1) {
      return (val + 1) >>> 1;
    } else {
      return -(val >>> 1);
    }
  }
}
