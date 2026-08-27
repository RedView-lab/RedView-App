import type { AxisDomain } from '../series';
import { ratioFor } from './math';
import type { CanvasBackdropLayer, CanvasSeriesLayer } from './types';

export function drawAnalysisChartCanvas(
  canvas: HTMLCanvasElement | null,
  input: {
    width: number;
    height: number;
    xDomain: AxisDomain;
    backdropYDomain: AxisDomain | null;
    backdropSeries: CanvasBackdropLayer[];
    seriesLayers: CanvasSeriesLayer[];
  },
) {
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const width = rect.width > 0 ? rect.width : input.width;
  const height = rect.height > 0 ? rect.height : input.height;

  const ctx = prepareCanvas2d(canvas, width, height);
  if (!ctx) return;

  if (input.backdropYDomain) {
    for (const layer of input.backdropSeries) {
      drawCanvasArea(
        ctx,
        layer.points,
        input.xDomain,
        input.backdropYDomain,
        layer.fillColor,
        width,
        height,
      );
    }
    for (const layer of input.backdropSeries) {
      drawCanvasLine(
        ctx,
        layer.points,
        input.xDomain,
        input.backdropYDomain,
        layer.lineColor,
        1.15,
        width,
        height,
      );
    }
  }

  for (const layer of input.seriesLayers) {
    drawCanvasLine(
      ctx,
      layer.points,
      input.xDomain,
      layer.yDomain,
      layer.color,
      layer.lineWidth,
      width,
      height,
    );
  }
}

function prepareCanvas2d(
  canvas: HTMLCanvasElement | null,
  width: number,
  height: number,
) {
  if (!canvas || width <= 0 || height <= 0) return null;

  const dpr = window.devicePixelRatio || 1;
  const targetBufferWidth = Math.max(1, Math.round(width * dpr));
  const targetBufferHeight = Math.max(1, Math.round(height * dpr));

  if (canvas.width !== targetBufferWidth || canvas.height !== targetBufferHeight) {
    canvas.width = targetBufferWidth;
    canvas.height = targetBufferHeight;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

function drawCanvasLine(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  xDomain: AxisDomain,
  yDomain: AxisDomain,
  color: string,
  lineWidth: number,
  width: number,
  height: number,
) {
  if (points.length < 2 || width <= 0 || height <= 0) return;

  ctx.save();
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = ratioFor(point.x, xDomain) * width;
    const y = (1 - ratioFor(point.y, yDomain)) * height;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
}

function drawCanvasArea(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  xDomain: AxisDomain,
  yDomain: AxisDomain,
  fill: string,
  width: number,
  height: number,
) {
  if (points.length < 2 || width <= 0 || height <= 0) return;

  ctx.save();
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = ratioFor(point.x, xDomain) * width;
    const y = (1 - ratioFor(point.y, yDomain)) * height;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  const lastX = ratioFor(points[points.length - 1]?.x ?? xDomain.min, xDomain) * width;
  const firstX = ratioFor(points[0]?.x ?? xDomain.min, xDomain) * width;
  ctx.lineTo(lastX, height);
  ctx.lineTo(firstX, height);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}