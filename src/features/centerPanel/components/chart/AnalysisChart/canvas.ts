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
  const ctx = prepareCanvas2d(canvas, input.width, input.height);
  if (!ctx) return;

  if (input.backdropYDomain) {
    for (const layer of input.backdropSeries) {
      drawCanvasArea(
        ctx,
        layer.points,
        input.xDomain,
        input.backdropYDomain,
        'rgba(245, 248, 252, 0.08)',
      );
    }
    for (const layer of input.backdropSeries) {
      drawCanvasLine(
        ctx,
        layer.points,
        input.xDomain,
        input.backdropYDomain,
        'rgba(245, 248, 252, 0.4)',
        1.15,
      );
    }
  }

  for (const layer of input.seriesLayers) {
    drawCanvasLine(ctx, layer.points, input.xDomain, layer.yDomain, layer.color, layer.lineWidth);
  }
}

function prepareCanvas2d(
  canvas: HTMLCanvasElement | null,
  width: number,
  height: number,
) {
  if (!canvas) return null;

  const cssWidth = Math.max(0, width);
  const cssHeight = Math.max(0, height);
  const dpr = window.devicePixelRatio || 1;

  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.width = Math.max(1, Math.round(cssWidth * dpr));
  canvas.height = Math.max(1, Math.round(cssHeight * dpr));

  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  return ctx;
}

function drawCanvasLine(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  xDomain: AxisDomain,
  yDomain: AxisDomain,
  color: string,
  lineWidth: number,
) {
  if (points.length < 2) return;

  const width = Number(ctx.canvas.style.width.replace('px', '')) || ctx.canvas.width;
  const height = Number(ctx.canvas.style.height.replace('px', '')) || ctx.canvas.height;

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
) {
  if (points.length < 2) return;

  const width = Number(ctx.canvas.style.width.replace('px', '')) || ctx.canvas.width;
  const height = Number(ctx.canvas.style.height.replace('px', '')) || ctx.canvas.height;

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