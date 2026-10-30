export type Stage = 'reading' | 'scanning' | 'rebuilding' | 'done';
/** Byte offsets, for a visual strip */
export interface Segment { start: number; end: number; kind: 'video' | 'audio' | 'empty' | 'unknown'; }
export interface Progress { stage: Stage; bytesDone: number; bytesTotal: number; framesFound: number; segments: Segment[] }
export interface Report {
  ok: boolean; container: string; videoCodec: 'h264' | 'hevc' | 'unknown'; audioCodec: 'aac' | 'pcm' | 'none' | 'unknown';
  width?: number; height?: number; fps?: number;
  recoveredSeconds: number; estimatedTotalSeconds?: number; framesRecovered: number; keyframes: number;
  bytesTotal: number; bytesUsable: number; bytesEmpty: number;
  usedReference: boolean; needsReference?: boolean; warnings: string[]; verdict: 'full' | 'partial' | 'failed'; summary: string;
}
export interface RescueOptions { reference?: Blob; onProgress?: (p: Progress) => void; signal?: AbortSignal }
export interface RescueResult { output: Blob | null; report: Report }
