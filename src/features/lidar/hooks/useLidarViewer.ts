import { useEffect, useRef, useState, useCallback } from 'react';
import type { TileCoord } from '../types/geometry';
import type { ProcessedTile } from '../tile-manager/tile-lifecycle';
import { TileStateManager } from '../tile-manager/tile-state';
import { TileSelector } from '../tile-manager/tile-selector';
import { initWebGPU, destroyWebGPU } from '../renderer/webgpu-context';
import type { WebGPUContext } from '../renderer/webgpu-context';
import { createBillboardPipeline, createFxaaPipeline, createTerrainPipeline } from '../renderer/pipeline';
import type { BillboardPipeline, FxaaPipeline, TerrainPipeline } from '../renderer/pipeline';
import { createQuadVertexBuffer, createUniformBuffer, writeUniforms, createInstanceBuffer, createTerrainBuffers } from '../renderer/buffers';
import type { TerrainBuffers } from '../renderer/buffers';
import { createFxaaResources, destroyFxaaResources } from '../renderer/fxaa-pass';
import type { FxaaResources } from '../renderer/fxaa-pass';
import {
  createOrbitCamera,
  orbitCameraPosition,
  orbitViewMatrix,
  perspectiveMatrix,
  multiplyMat4,
  setupOrbitControls,
} from '../renderer/orbit-camera';
import { buildOctree } from '../lod/octree';
import type { FlatOctree } from '../lod/types';
import { LodManager } from '../lod/lod-manager';
import type { CameraState } from '../lod/types';
import { buildHeightmapAsync } from '../processing/heightmap-async';

const SUN_DIR = [0.4, 0.6, 0.8] as const;

export function useLidarViewer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  tileCoord: TileCoord | null,
) {
  const [status, setStatus] = useState<string>('idle');
  const [progress, setProgress] = useState<number>(0);
  const [gpuReady, setGpuReady] = useState(false);
  const gpuRef = useRef<{
    ctx: WebGPUContext;
    billboard: BillboardPipeline;
    terrain: TerrainPipeline;
    fxaa: FxaaPipeline;
    fxaaRes: FxaaResources;
    uniformBuffer: GPUBuffer;
    quadBuffer: GPUBuffer;
    bindGroup: GPUBindGroup;
    terrainBindGroup: GPUBindGroup;
    /** Full instance buffer containing all octree points (leaves + voxels) */
    instanceBuffer: GPUBuffer | null;
    terrainBuffers: TerrainBuffers | null;
    octree: FlatOctree | null;
    lodManager: LodManager;
    rafId: number;
    lastFrameTime: number;
  } | null>(null);

  const stateManager = useRef(new TileStateManager());
  const cameraRef = useRef(createOrbitCamera());
  const needsRender = useRef(true);

  const render = useCallback(() => {
    const gpu = gpuRef.current;
    if (!gpu) return;
    // Need at least one of: octree (point cloud) or terrain
    if (!gpu.instanceBuffer && !gpu.terrainBuffers) return;

    const { ctx, billboard, fxaa, fxaaRes, uniformBuffer, quadBuffer, octree, lodManager } = gpu;
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

    // LOD selection (only when octree available)
    let visibleNodes: ReturnType<LodManager['selectVisible']> = [];
    if (octree) {
      const cameraState: CameraState = {
        viewProjMatrix: projMatrix,
        cameraPos: [camPos[0], camPos[1], camPos[2]],
        viewportWidth: canvas.width,
        viewportHeight: canvas.height,
      };
      visibleNodes = lodManager.selectVisible(octree.root, cameraState);
    }

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

    // --- Terrain mesh pass ---
    if (gpu.terrainBuffers) {
      scenePass.setPipeline(gpu.terrain.pipeline);
      scenePass.setBindGroup(0, gpu.terrainBindGroup);
      scenePass.setVertexBuffer(0, gpu.terrainBuffers.vertexBuffer);
      scenePass.setVertexBuffer(1, gpu.terrainBuffers.colorBuffer);
      scenePass.setIndexBuffer(gpu.terrainBuffers.indexBuffer, 'uint32');
      scenePass.drawIndexed(gpu.terrainBuffers.indexCount);
    }

    // --- Point cloud pass ---
    if (gpu.instanceBuffer && gpu.octree) {
      scenePass.setPipeline(billboard.pipeline);
      scenePass.setBindGroup(0, gpu.bindGroup);
      scenePass.setVertexBuffer(0, quadBuffer);
      scenePass.setVertexBuffer(1, gpu.instanceBuffer);

      // Draw each visible LOD node as a sub-range of the instance buffer
      for (const { node, useVoxels } of visibleNodes) {
        const start = useVoxels ? node.voxelStart : node.pointStart;
        const count = useVoxels ? node.voxelCount : node.pointCount;
        if (count > 0) {
          scenePass.draw(4, count, 0, start);
        }
      }
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

    // Adaptive budget
    const now = performance.now();
    if (gpu.lastFrameTime > 0) {
      lodManager.adaptBudget(now - gpu.lastFrameTime);
    }
    gpu.lastFrameTime = now;
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
      const terrain = createTerrainPipeline(ctx);
      const fxaa = createFxaaPipeline(ctx);
      const fxaaRes = createFxaaResources(ctx, fxaa, canvas!.width, canvas!.height);
      const uniformBuffer = createUniformBuffer(ctx.device);
      const quadBuffer = createQuadVertexBuffer(ctx.device);
      const bindGroup = ctx.device.createBindGroup({
        layout: billboard.bindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
      });

      const terrainBindGroup = ctx.device.createBindGroup({
        layout: terrain.bindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
      });

      gpuRef.current = {
        ctx, billboard, terrain, fxaa, fxaaRes,
        uniformBuffer, quadBuffer, bindGroup, terrainBindGroup,
        instanceBuffer: null,
        terrainBuffers: null,
        octree: null,
        lodManager: new LodManager(),
        rafId: 0,
        lastFrameTime: 0,
      };

      setGpuReady(true);

      function loop() {
        if (destroyed) return;
        if (needsRender.current) {
          needsRender.current = false;
          render();
          // Keep rendering when data is loaded (LOD needs continuous updates)
          if (gpuRef.current?.octree || gpuRef.current?.terrainBuffers) needsRender.current = true;
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
        gpu.instanceBuffer?.destroy();
        if (gpu.terrainBuffers) {
          gpu.terrainBuffers.vertexBuffer.destroy();
          gpu.terrainBuffers.colorBuffer.destroy();
          gpu.terrainBuffers.indexBuffer.destroy();
        }
        gpu.uniformBuffer.destroy();
        gpu.quadBuffer.destroy();
        destroyFxaaResources(gpu.fxaaRes);
        destroyWebGPU(gpu.ctx);
        gpuRef.current = null;
      }
      setGpuReady(false);
    };
  }, [canvasRef, render, requestRender]);

  useEffect(() => {
    if (!tileCoord || !gpuReady) return;
    const gpu = gpuRef.current;
    if (!gpu) return;

    setStatus('loading');
    setProgress(0);

    const selector = new TileSelector(stateManager.current, (result: ProcessedTile) => {
      // Build octree for LOD
      setStatus('building octree');
      const octree = buildOctree(
        result.pointCloud.positions,
        result.pointCloud.colors,
        result.normals,
        result.pointCloud.count,
      );

      // Upload unified instance buffer (leaves + voxels contiguous)
      const totalPoints = octree.totalLeafPoints + octree.totalVoxelPoints;
      const instanceBuffer = createInstanceBuffer(
        gpu.ctx.device,
        octree.positions,
        octree.colors,
        octree.normals,
        totalPoints,
      );

      // Clean up old buffer
      gpu.instanceBuffer?.destroy();
      gpu.instanceBuffer = instanceBuffer;
      gpu.octree = octree;

      const b = result.pointCloud.bounds;
      const cam = cameraRef.current;
      cam.target = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2];
      const dx = b.maxX - b.minX;
      const dy = b.maxY - b.minY;
      const dz = b.maxZ - b.minZ;
      cam.distance = Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.8;

      setStatus('building terrain');
      // Build heightmap asynchronously and upload terrain buffers
      buildHeightmapAsync(
        result.pointCloud.positions,
        result.pointCloud.colors,
        result.pointCloud.classifications,
        result.pointCloud.count,
      ).then((hm) => {
        if (!gpuRef.current) return;
        // Clean up old terrain buffers
        if (gpu.terrainBuffers) {
          gpu.terrainBuffers.vertexBuffer.destroy();
          gpu.terrainBuffers.colorBuffer.destroy();
          gpu.terrainBuffers.indexBuffer.destroy();
        }
        gpu.terrainBuffers = createTerrainBuffers(
          gpu.ctx.device, hm.vertices, hm.colors, hm.indices, hm.vertexCount,
        );
        needsRender.current = true;
      }).catch((e) => console.warn('heightmap failed:', e));

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
  }, [tileCoord, gpuReady]);

  return { status, progress, requestRender };
}
