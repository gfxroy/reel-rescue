import './style.css';
import { runRescue } from './engine';
import type { Progress, Report, Segment } from './types';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const touch = matchMedia('(hover: none)').matches;

/* ---------- mouse-reactive background ---------- */
const grid = $<HTMLCanvasElement>('grid'), gctx = grid.getContext('2d')!, glow = $('glow');
let mx = innerWidth / 2, my = innerHeight * .3, gx = mx, gy = my, W = 0, H = 0, dpr = 1;
function size() { dpr = Math.min(devicePixelRatio || 1, 2); W = innerWidth; H = innerHeight; grid.width = W * dpr; grid.height = H * dpr; gctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
addEventListener('resize', size); size();
addEventListener('pointermove', e => { mx = e.clientX; my = e.clientY; }, { passive: true });
function frame(t: number) {
  gx += (mx - gx) * .08; gy += (my - gy) * .08;
  if (!touch) glow.style.transform = `translate3d(${gx}px,${gy}px,0)`;
  if (!reduce) {
    gctx.clearRect(0, 0, W, H);
    const gap = 34, R = 170;
    const px = touch ? W / 2 + Math.cos(t / 3000) * W / 3 : gx, py = touch ? H / 3 + Math.sin(t / 2500) * H / 5 : gy;
    for (let x = gap / 2; x < W; x += gap) for (let y = gap / 2; y < H; y += gap) {
      const dx = x - px, dy = y - py, d = Math.hypot(dx, dy), k = Math.max(0, 1 - d / R);
      const o = k * k * 12, a = .10 + k * .7;
      gctx.fillStyle = `rgba(255,255,255,${a})`;
      gctx.beginPath(); gctx.arc(x + (dx / (d || 1)) * o, y + (dy / (d || 1)) * o, 1 + k * 1.3, 0, 6.283); gctx.fill();
    }
  }
  requestAnimationFrame(frame);
}
if (reduce) { gctx.fillStyle = 'rgba(255,255,255,.12)'; for (let x = 17; x < W; x += 34) for (let y = 17; y < H; y += 34) gctx.fillRect(x, y, 1.5, 1.5); } else requestAnimationFrame(frame);

/* ---------- card spotlight + tilt ---------- */
document.querySelectorAll<HTMLElement>('.panel, .card').forEach(el => {
  el.addEventListener('pointermove', e => {
    const r = el.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    el.style.setProperty('--mx', x + 'px'); el.style.setProperty('--my', y + 'px');
    if (el.classList.contains('tilt') && !reduce && !touch) el.style.transform = `perspective(800px) rotateX(${((y / r.height) - .5) * -7}deg) rotateY(${((x / r.width) - .5) * 7}deg) translateY(-3px)`;
  });
  el.addEventListener('pointerleave', () => { if (el.classList.contains('tilt')) el.style.transform = ''; });
});

/* ---------- scroll reveal ---------- */
const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .12 });
document.querySelectorAll('.reveal').forEach((el, i) => { if (i < 3) setTimeout(() => el.classList.add('in'), 80); else io.observe(el); });

/* ---------- app ---------- */
const drop = $('drop'), fileIn = $<HTMLInputElement>('file'), refIn = $<HTMLInputElement>('ref'), opt = $('opt');
const work = $('work'), result = $('result');
let lastFile: File | null = null, ref: File | null = null, outUrl = '', outName = 'fixed.mp4', outBlob: Blob | null = null;

function show(state: 'idle' | 'work' | 'result') {
  drop.hidden = opt.hidden = state !== 'idle'; work.hidden = state !== 'work'; result.hidden = state !== 'result';
  (state === 'work' ? work : state === 'result' ? result : drop).classList.add('fade-in');
}
refIn.addEventListener('change', () => { ref = refIn.files?.[0] ?? null; opt.classList.toggle('has', !!ref); opt.querySelector('.opt-link')!.firstChild!.textContent = ref ? `✓ Using ${ref.name} ` : '+ Add a good video from the same phone '; });
['dragenter', 'dragover'].forEach(n => drop.addEventListener(n, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(n => drop.addEventListener(n, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => { const f = (e as DragEvent).dataTransfer?.files?.[0]; if (f) start(f); });
drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileIn.click(); } });
fileIn.addEventListener('change', () => { const f = fileIn.files?.[0]; if (f) start(f); fileIn.value = ''; });
// Allow dropping anywhere on the page
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f && !drop.hidden) start(f); });

const fmtT = (s: number) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(ss).padStart(2, '0'); };
const mb = (n: number) => n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : (n / 1e6).toFixed(n > 1e8 ? 0 : 1) + ' MB';

function drawStrip(c: HTMLCanvasElement, segs: Segment[], total: number) {
  const r = c.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2);
  c.width = Math.max(1, r.width * d); c.height = Math.max(1, r.height * d);
  const x = c.getContext('2d')!; x.clearRect(0, 0, c.width, c.height);
  const span = Math.max(total, segs.at(-1)?.end ?? 0, 1);
  const col = { video: '#fafafa', audio: '#8a8a8f', empty: '#1c1c1e', unknown: '#3a3a3d' };
  for (const s of segs) { x.fillStyle = col[s.kind]; const a = s.start / span * c.width; x.fillRect(a, 0, Math.max(1.5 * d, (s.end - s.start) / span * c.width - 1 * d), c.height); }
}

async function start(file: File) {
  lastFile = file;
  show('work'); $('wname').textContent = file.name; $('wpct').textContent = '0%'; $('cframes').textContent = '0'; $('cmb').textContent = '0';
  const labels: Record<string, string> = { reading: 'Reading your file…', scanning: 'Finding every frame of your video…', rebuilding: 'Writing a new index so it plays…', done: 'Finishing up…' };
  let last = 0, lastSegs: Segment[] = [];
  try {
    const res = await runRescue(file, ref, (p: Progress) => {
      const now = performance.now(); if (now - last < 40 && p.stage !== 'done') return; last = now; lastSegs = p.segments;
      $('wpct').textContent = Math.min(99, Math.round(p.bytesDone / p.bytesTotal * 100)) + '%';
      $('wlabel').textContent = labels[p.stage]; $('cframes').textContent = p.framesFound.toLocaleString(); $('cmb').textContent = Math.round(p.bytesDone / 1e6).toLocaleString();
      drawStrip($<HTMLCanvasElement>('stripc'), p.segments, p.bytesTotal);
    });
    showResult(file, res.output, res.report, lastSegs);
  } catch (err) {
    showResult(file, null, { ok: false, container: '?', videoCodec: 'unknown', audioCodec: 'unknown', recoveredSeconds: 0, framesRecovered: 0, keyframes: 0, bytesTotal: file.size, bytesUsable: 0, bytesEmpty: 0, usedReference: false, warnings: [String(err)], verdict: 'failed', summary: 'Something went wrong while reading this file.' });
  }
}

function showResult(file: File, out: Blob | null, r: Report, segs?: Segment[]) {
  show('result'); outBlob = out; if (outUrl) URL.revokeObjectURL(outUrl);
  outName = file.name.replace(/\.[^.]+$/, '') + '-fixed.mp4';
  const v = $('verdict'); v.className = 'verdict ' + r.verdict;
  v.innerHTML = `<i></i>${r.verdict === 'full' ? 'Fully recovered' : r.verdict === 'partial' ? 'Partly recovered' : 'Could not recover'}`;
  $('rtitle').textContent = r.needsReference ? 'One more thing needed' : r.verdict === 'failed' ? "This one couldn't be fixed" : r.estimatedTotalSeconds && r.estimatedTotalSeconds - r.recoveredSeconds > 2 ? `Recovered ${fmtT(r.recoveredSeconds)} of about ${fmtT(r.estimatedTotalSeconds)}` : `Recovered ${fmtT(r.recoveredSeconds)} of video`;
  $('rsum').textContent = r.summary;
  const p = $('preview'), vid = $<HTMLVideoElement>('video');
  if (out) { outUrl = URL.createObjectURL(out); vid.src = outUrl; p.hidden = false; } else { p.hidden = true; vid.removeAttribute('src'); }
  ($('dl') as HTMLButtonElement).disabled = !out; $('rstrip').hidden = !out;
  $('needref').hidden = !r.needsReference; $('actions').querySelector('#dl')!.toggleAttribute('hidden', !out);
  const rs = $<HTMLCanvasElement>('rstripc'); requestAnimationFrame(() => { drawStrip(rs, segs ?? [{ start: 0, end: r.bytesUsable, kind: 'video' }, { start: r.bytesUsable, end: r.bytesTotal, kind: 'empty' }], r.bytesTotal); });
  const rows: [string, string][] = [['Format', r.container], ['Video', `${r.videoCodec.toUpperCase()}${r.width ? ` · ${r.width}×${r.height}` : ''}${r.fps ? ` · ${Math.round(r.fps)} fps` : ''}`], ['Sound', r.audioCodec.toUpperCase()], ['Frames', r.framesRecovered.toLocaleString() + ` (${r.keyframes.toLocaleString()} keyframes)`], ['Usable data', `${mb(r.bytesUsable)} of ${mb(r.bytesTotal)}`], ['Empty data', mb(r.bytesEmpty)], ['Used a reference video', r.usedReference ? 'Yes' : 'No']];
  $('details').innerHTML = rows.map(([k, v2]) => `<dt>${k}</dt><dd>${v2}</dd>`).join('') + r.warnings.map(w => `<dt>Note</dt><dd>${w.replace(/</g, '&lt;')}</dd>`).join('');
}
$('dl').addEventListener('click', () => { if (!outBlob) return; const a = document.createElement('a'); a.href = outUrl; a.download = outName; a.click(); });
$<HTMLInputElement>('ref2').addEventListener('change', () => { const f = $<HTMLInputElement>('ref2').files?.[0]; if (f && lastFile) { ref = f; start(lastFile); } $<HTMLInputElement>('ref2').value = ''; });
$('again').addEventListener('click', () => { const v = $<HTMLVideoElement>('video'); v.pause(); ref = null; opt.classList.remove('has'); opt.querySelector('.opt-link')!.firstChild!.textContent = '+ Add a good video from the same phone '; show('idle'); });
