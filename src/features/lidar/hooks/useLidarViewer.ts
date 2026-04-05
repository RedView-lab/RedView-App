import { useEffect, useRef, useState, useCallback } from 'react';
import type { TileCoord } from '../types/geometry';
import type { ProcessedTile } from '../tile-manager/tile-lifecycle';
import { TileStateManager } from '../tile-manager/tile-state';
import { TileSelector } from '../tile-manager/tile-selector';
import { initWebGPU, destroyWebGPU } from '../renderer/webgpu-context';
import type { WebGPUContext } from '../renderer/webgpu-context';
import { createBillboardPipeline, createFxaaPipeline } from '../renderer/pipeline';
import type { BillboardPipeline, FxaaPipeline } from '../renderer/pipeline';
import { createQuadVertexBuffer, createUniformBuffer, writeUniforms } from '../renderer/buffers';
import { createFxaaResources, destroyFxaaResources } from '../renderer/fxaa-pass';
import type { FxaaResources } from '../renderer/fxaa-pass';
import { uploadTile, destroyTileGpu } from '../renderer/tile-renderer';
import type { TileGpuData } from '../renderer/tile-renderer';
import {
  createOrbitCamera,
  orbitCameraPosition,
  orbitViewMatrix,
  perspectiveMatrix,
  multiplyMat4,
  setupOrbitControls,
} from '../renderer/orbit-camera';

const SUN_DIR = [0.4, 0.6, 0.8] as const;

export function useLidarViewer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  tileCoord: TileCoord | null,
) {
  const [status, setStatus] = useState<string>('idle');
  const [progress, setProgress] = useState<number>(0);
  const gpuRef = useRef<{
    ctx: WebGPUContext;
    billboard: BillboardPipeline;
    fxaa: FxaaPipeline;
    fxaaRes: FxaaResources;
    uniformBuffer: GPUBuffer;
    quadBuffer: GPUBuffer;
    tiles: TileGpuData[];
    rafId: number;
  } | null>(null);

  const stateManager = useRef(new TileStateManager());
  const cameraRef = useRef(createOrbitCamera());
  const needsRender = useRef(true);

  const render = useCallback(() => {
    const gpu = gpuRef.current;
    if (!gpu) return;

    const { ctx, billboard, fxaa, fxaaRes, uniformBuffer, quadBuffer, tiles } = gpu;
    const canvas = ctx.canvas;

    if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
      canvas.width = canvas.clientWidth;
      canvas.height = canvas.clientHeight;
      destroyFxaaResources(fxaaRes);
      gpu.fxaaRes = createFxaaResources(ctx, fxaa, canvas.width, canvas.height);
    }

    const cam = cameraRef.current;
    const aspect = canvas.width / canvas.height;
    const proj = perspectiveMatrix(cam.fov, aspect, cam.near, cam.far);
    const view = orbitViewMatrix(cam);
    const projMatrix = multiplyMat4(proj, view);
    const camPos = orbitCameraPosition(cam);

    writeUniforms(ctx.device, uniformBuffer, {
      projMatrix,
      viewportWidth: canvas.width,
      viewportHeight: canvas.height,
      pointSize: Math.max(1, Math.min(6, 800 / cam.distance)),
      opacity: 1.0,
      originX: cam.target[0],
      originY: cam.target[1],
      originZ: cam.target[2],
      sunDirX: SUN_DIR[0],
      sunDirY: SUN_DIR[1],
      sunDirZ: SUN_DIR[2],
      cameraPosX: camPos[0] - cam.target[0],
      cameraPosY: camPos[1] - cam.target[1],
      cameraPosZ: camPos[2] - cam.target[2],
    });

    const bindGroup = ctx.device.createBindGroup({
      layout: billboard.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
    });

    const encoder = ctx.device.createCommandEncoder();

    const res = gpu.fxaaRes;
    const scenePass = encoder.beginRenderPass({
      colorAttachments: [{
        view: res.sceneTextureView,
        clearValue: { r: 0.05, g: 0.05, b: 0.08, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: res.depthTextureView,
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    scenePass.setPipeline(billboard.pipeline);
    scenePass.setBindGroup(0, bindGroup);
    scenePass.setVertexBuffer(0, quadBuffer);

    for (const tile of tiles) {
      scenePass.setVertexBuffer(1, tile.instanceBuffer);
      scenePass.draw(4, tile.pointCount, 0, 0);
    }
    scenePass.end();

    const canvasTexture = ctx.context.getCurrentTexture().createView();
    const fxaaPass = encoder.beginRenderPass({
      colorAttachments: [{
        view: canvasTexture,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    fxaaPass.setPipeline(fxaa.pipeline);
    fxaaPass.setBindGroup(0, res.bindGroup);
    fxaaPass.draw(3, 1, 0, 0);
    fxaaPass.end();

    ctx.device.queue.submit([encoder.finish()]);
  }, []);

  const requestRender = useCallback(() => {
    needsRender.current = true;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let destroyed = false;

    async function init() {
      const ctx = await initWebGPU(canvas!);
      if (destroyed) { destroyWebGPU(ctx); return; }

      canvas!.width = canvas!.clientWidth;
      canvas!.height = canvas!.clientHeight;

      const billboard = createBillboardPipeline(ctx);
      const fxaa = createFxaaPipeline(ctx);
      const fxaaRes = createFxaaResources(ctx, fxaa, canvas!.width, canvas!.height);
      const uniformBuffer = createUniformBuffer(ctx.device);
      const quadBuffer = createQuadVertexBuffer(ctx.device);

      gpuRef.current = {
        ctx, billboard, fxaa, fxaaRes,
        uniformBuffer, quadBuffer,
        tiles: [],
        rafId: 0,
      };

      function loop() {
        if (destroyed) return;
        if (needsRender.current) {
          needsRender.current = false;
          render();
        }
        gpuRef.current!.rafId = requestAnimationFrame(loop);
      }
      loop();
    }

    init().catch((e) => setStatus(`error: ${e.message}`));

    const cleanupOrbit = setupOrbitControls(canvas, cameraRef.current, requestRender);

    return () => {
      destroyed = true;
      cleanupOrbit();
      const gpu = gpuRef.current;
      if (gpu) {
        cancelAnimationFrame(gpu.rafId);
        for (const t of gpu.tiles) destroyTileGpu(t);
        gpu.uniformBuffer.destroy();
        gpu.quadBuffer.destroy();
        destroyFxaaResources(gpu.fxaaRes);
        destroyWebGPU(gpu.ctx);
        gpuRef.current = null;
      }
    };
  }, [canvasRef, render, requestRender]);

  useEffect(() => {
    if (!tileCoord) return;
    const gpu = gpuRef.current;
    if (!gpu) return;

    setStatus('loading');
    setProgress(0);

    const selector = new TileSelector(stateManager.current, (result: ProcessedTile) => {
      const tileGpu = uploadTile(
        gpu.ctx.device,
        `${result.coord.xKm}_${result.coord.yKm}`,
        result.pointCloud.positions,
        result.pointCloud.colors,
        result.normals,
        result.pointCloud.count,
        result.pointCloud.bounds,
      );

      for (const old of gpu.tiles) destroyTileGpu(old);
      gpu.tiles = [tileGpu];

      const b = result.pointCloud.bounds;
      const cam = cameraRef.current;
      cam.target = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2];
      const dx = b.maxX - b.minX;
      const dy = b.maxY - b.minY;
      const dz = b.maxZ - b.minZ;
      cam.distance = Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.8;

      setStatus('ready');
      setProgress(100);
      needsRender.current = true;
    });

    const unsub = stateManager.current.subscribe((event) => {
      if (event.progress?.percent !== undefined) {
        setProgress(event.progress.percent);
      }
      if (event.progress?.phase) {
        setStatus(event.progress.phase);
      }
    });

    selector.enqueue(tileCoord);

    return () => {
      unsub();
      selector.cancelAll();
    };
  }, [tileCoord]);

  return { status, progress, requestRender };
}
