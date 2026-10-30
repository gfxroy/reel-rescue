/// <reference lib="webworker" />
// Messages in: {type:'rescue', file: Blob, reference?: Blob}
// Messages out: {type:'progress', progress} | {type:'result', output: Blob|null, report} | {type:'error', message}
import { rescue } from './core/index';
self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m?.type !== 'rescue') return;
  try {
    const r = await rescue(m.file, { reference: m.reference, onProgress: (progress) => (self as any).postMessage({ type: 'progress', progress }) });
    (self as any).postMessage({ type: 'result', output: r.output, report: r.report });
  } catch (err: any) { (self as any).postMessage({ type: 'error', message: String(err?.message ?? err) }); }
};
