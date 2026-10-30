import type { Progress, RescueResult } from './types';
export function runRescue(file: File, ref: File | null, onProgress: (p: Progress) => void): Promise<RescueResult> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('../../src/worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') onProgress(m.progress);
      else if (m.type === 'result') { w.terminate(); resolve({ output: m.output, report: m.report }); }
      else if (m.type === 'error') { w.terminate(); reject(new Error(m.message)); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'The repair engine failed to start.')); };
    w.postMessage({ type: 'rescue', file, reference: ref ?? undefined });
  });
}
