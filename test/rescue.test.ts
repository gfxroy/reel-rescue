import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rescue } from '../src/core/index';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'rr-'));

/** Make a good video, then keep only the first `keep` fraction of its picture data (moov is lost, like a dead battery). */
function make(codec: 'libx264' | 'libx265', name: string, keep = 0.7, extra: string[] = []) {
  const good = join(dir, `${name}.mp4`);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=duration=8:size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=duration=8',
    '-c:v', codec, '-pix_fmt', 'yuv420p', '-c:a', 'aac', ...(codec === 'libx265' ? ['-tag:v', 'hvc1', '-x265-params', 'log-level=none'] : []), ...extra, good]);
  const d = readFileSync(good); let i = 0, start = 0, end = 0;
  while (i + 8 <= d.length) { const sz = d.readUInt32BE(i); if (d.toString('latin1', i + 4, i + 8) === 'mdat') { start = i; end = i + sz; } i += sz; }
  const broken = join(dir, `${name}-broken.mp4`);
  writeFileSync(broken, d.subarray(0, start + Math.floor((end - start) * keep)));
  return { good, broken };
}
const blob = (p: string) => new Blob([readFileSync(p)]);
async function probe(buf: Blob) {
  const out = join(dir, `out-${Math.random().toString(36).slice(2)}.mp4`);
  writeFileSync(out, Buffer.from(await buf.arrayBuffer()));
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,nb_frames:format=duration', '-of', 'json', out]).toString());
  const err = spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-an', '-f', 'null', '-']).stderr.toString();
  return { j, err, out };
}

describe.skipIf(!hasFfmpeg)('Reel Rescue', () => {
  for (const [codec, label] of [['libx264', 'H.264'], ['libx265', 'HEVC']] as const) {
    describe(label, () => {
      let f: { good: string; broken: string };
      beforeAll(() => { f = make(codec, label); });

      it('rebuilds a playable video using a reference clip, with no decode errors', async () => {
        const r = await rescue(blob(f.broken), { reference: blob(f.good) });
        expect(r.output).not.toBeNull();
        expect(r.report.ok).toBe(true);
        expect(r.report.width).toBe(640); expect(r.report.height).toBe(360);
        expect(r.report.usedReference).toBe(true);
        expect(r.report.recoveredSeconds).toBeGreaterThan(8 * 0.7 * 0.9);
        const p = await probe(r.output!);
        expect(p.err.trim()).toBe('');
        expect(Math.abs(Number(p.j.format.duration) - r.report.recoveredSeconds)).toBeLessThan(0.2);
      });

      it('recovered frames are identical to the original (bit-exact)', async () => {
        const r = await rescue(blob(f.broken), { reference: blob(f.good) });
        const p = await probe(r.output!);
        const out = spawnSync('ffmpeg', ['-i', p.out, '-i', f.good, '-lavfi', `[0:v]trim=end_frame=100,setpts=PTS-STARTPTS[a];[1:v]trim=end_frame=100,setpts=PTS-STARTPTS[b];[a][b]psnr`, '-f', 'null', '-']).stderr.toString();
        expect(out).toMatch(/average:inf/);
      });

      it('says honestly that a reference is needed when the file has no stored settings', async () => {
        const r = await rescue(blob(f.broken));
        expect(r.output).toBeNull();
        expect(r.report.verdict).toBe('failed');
        expect(r.report.needsReference).toBe(true);
      });
    });
  }

  it('reports progress and a segment strip', async () => {
    const f = make('libx264', 'prog');
    const seen: number[] = []; let segs = 0;
    await rescue(blob(f.broken), { reference: blob(f.good), onProgress: (p) => { seen.push(p.bytesDone); segs = Math.max(segs, p.segments.length); } });
    expect(seen.length).toBeGreaterThan(1); expect(segs).toBeGreaterThan(0);
  });

  it('rejects files that are not videos', async () => {
    const r = await rescue(new Blob([new Uint8Array(5000).fill(7)]));
    expect(r.report.ok).toBe(false);
  });
});
