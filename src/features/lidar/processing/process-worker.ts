import { parseLazFile } from './laz-parser';
import { colorizePointCloud } from './colorizer';
import type { PointCloudData } from '../types/tile';

export type ProcessWorkerInput = {
  buffer: ArrayBuffer;
};

export type ProcessWorkerOutput =
  | { type: 'progress'; percent: number; phase: string }
  | { type: 'result'; data: PointCloudData };

self.onmessage = async (e: MessageEvent<ProcessWorkerInput>) => {
  const { buffer } = e.data;

  const post = (self as unknown as Worker).postMessage.bind(self);

  // Validate LASF magic bytes before attempting parse
  if (buffer.byteLength < 375) {
    throw new Error(`Invalid LAZ file: too small (${buffer.byteLength} bytes)`);
  }
  const magic = new Uint8Array(buffer, 0, 4);
  if (magic[0] !== 0x4C || magic[1] !== 0x41 || magic[2] !== 0x53 || magic[3] !== 0x46) {
    const sig = String.fromCharCode(...magic);
    throw new Error(`Invalid LAZ file: expected LASF signature, got "${sig}" — the downloaded file is not a valid LAS/LAZ`);
  }

  post({ type: 'progress', percent: 5, phase: 'parsing' });

  const raw = await parseLazFile(buffer);
  post({ type: 'progress', percent: 30, phase: 'colorizing' });

  const colorized = await colorizePointCloud(raw, (percent) => {
    post({ type: 'progress', percent: 30 + percent * 0.65, phase: 'colorizing' });
  });

  post(
    { type: 'result', data: colorized } satisfies ProcessWorkerOutput,
    [colorized.positions.buffer, colorized.colors.buffer, colorized.classifications.buffer],
  );
};
