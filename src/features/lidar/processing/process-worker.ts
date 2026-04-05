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
