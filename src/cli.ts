#!/usr/bin/env node

import { openAsBlob, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { rescue } from './core/index.js';
import type { Report } from './core/types.js';

interface CliArgs {
  brokenPath?: string;
  referencePath?: string;
  outputPath?: string;
  help?: boolean;
}

function parseArgs(args: string[]): CliArgs {
  const result: CliArgs = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      result.help = true;
    } else if (arg === '-r' || arg === '--reference') {
      result.referencePath = args[++i];
    } else if (arg === '-o' || arg === '--output') {
      result.outputPath = args[++i];
    } else if (!arg.startsWith('-') && !result.brokenPath) {
      result.brokenPath = arg;
    }
  }
  return result;
}

function printUsage(): void {
  console.log(`Usage: reel-rescue broken.mp4 [-r good.mp4] [-o out.mp4]

Repairs MP4/MOV videos whose moov atom is missing or truncated.

Arguments:
  broken.mp4              Path to the broken/truncated MP4 or MOV file

Options:
  -r, --reference <file>  Optional reference video file from same device/settings
  -o, --output <file>     Output file path (default: out.mp4)
  -h, --help              Show this help message`);
}

async function loadAsBlob(filePath: string): Promise<Blob> {
  if (typeof openAsBlob === 'function') {
    try {
      return (await openAsBlob(filePath)) as unknown as Blob;
    } catch {
      // Fallback below
    }
  }
  const buffer = await readFile(filePath);
  return new globalThis.Blob([buffer]) as unknown as Blob;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function printReport(report: Report, outputPath?: string): void {
  console.log('\n================ Reel Rescue Report ================');
  console.log(`Status:            ${report.ok ? 'SUCCESS' : 'FAILED'} (Verdict: ${report.verdict.toUpperCase()})`);
  console.log(`Summary:           ${report.summary}`);
  console.log(`Container:         ${report.container}`);
  const resStr = report.width && report.height ? ` (${report.width}x${report.height}${report.fps ? ` @ ${report.fps.toFixed(1)}fps` : ''})` : '';
  console.log(`Video Codec:       ${report.videoCodec}${resStr}`);
  console.log(`Audio Codec:       ${report.audioCodec}`);
  const estStr = report.estimatedTotalSeconds ? ` (estimated total: ${report.estimatedTotalSeconds.toFixed(2)}s)` : '';
  console.log(`Duration:          ${report.recoveredSeconds.toFixed(2)}s${estStr}`);
  console.log(`Frames Recovered:  ${report.framesRecovered} (Keyframes: ${report.keyframes})`);
  const usablePercent = report.bytesTotal > 0 ? ((report.bytesUsable / report.bytesTotal) * 100).toFixed(1) : '0';
  console.log(`Data Recovered:    ${formatBytes(report.bytesUsable)} / ${formatBytes(report.bytesTotal)} (${usablePercent}%)`);
  if (report.bytesEmpty > 0) {
    console.log(`Empty/Padded:      ${formatBytes(report.bytesEmpty)}`);
  }
  console.log(`Reference Used:    ${report.usedReference ? 'yes' : 'no'}`);
  if (report.warnings && report.warnings.length > 0) {
    console.log('Warnings:');
    for (const w of report.warnings) {
      console.log(`  - ${w}`);
    }
  }
  if (outputPath) {
    console.log(`Output File:       ${outputPath}`);
  }
  console.log('====================================================\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.brokenPath) {
    printUsage();
    if (!args.help && !args.brokenPath) {
      process.exitCode = 1;
    }
    return;
  }

  const outputPath = args.outputPath ?? 'out.mp4';

  console.log(`Loading broken video: ${args.brokenPath}`);
  let brokenBlob: Blob;
  try {
    brokenBlob = await loadAsBlob(args.brokenPath);
  } catch (err: any) {
    console.error(`Error reading broken file "${args.brokenPath}": ${err?.message ?? err}`);
    process.exitCode = 1;
    return;
  }

  let refBlob: Blob | undefined;
  if (args.referencePath) {
    console.log(`Loading reference video: ${args.referencePath}`);
    try {
      refBlob = await loadAsBlob(args.referencePath);
    } catch (err: any) {
      console.error(`Error reading reference file "${args.referencePath}": ${err?.message ?? err}`);
      process.exitCode = 1;
      return;
    }
  }

  console.log('Rescuing video...');
  const result = await rescue(brokenBlob, {
    reference: refBlob,
    onProgress: (p) => {
      const pct = p.bytesTotal > 0 ? ((p.bytesDone / p.bytesTotal) * 100).toFixed(0) : '0';
      process.stdout.write(`\r[${p.stage}] ${pct}% (${p.framesFound} frames found)`);
    },
  });

  printReport(result.report, result.output ? outputPath : undefined);

  if (result.output) {
    const arrayBuffer = await result.output.arrayBuffer();
    writeFileSync(outputPath, Buffer.from(arrayBuffer));
    console.log(`Successfully saved repaired video to: ${outputPath}`);
  } else {
    console.error('Failed to repair video: no output was generated.');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exitCode = 1;
});
