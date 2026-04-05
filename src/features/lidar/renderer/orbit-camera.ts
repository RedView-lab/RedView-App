export interface OrbitCamera {
  target: [number, number, number];
  distance: number;
  azimuth: number;
  elevation: number;
  fov: number;
  near: number;
  far: number;
}

export function createOrbitCamera(): OrbitCamera {
  return {
    target: [0, 0, 0],
    distance: 500,
    azimuth: Math.PI * 0.25,
    elevation: Math.PI * 0.3,
    fov: 60,
    near: 0.5,
    far: 10000,
  };
}

export function orbitCameraPosition(cam: OrbitCamera): [number, number, number] {
  const cosEl = Math.cos(cam.elevation);
  return [
    cam.target[0] + cam.distance * cosEl * Math.sin(cam.azimuth),
    cam.target[1] + cam.distance * cosEl * Math.cos(cam.azimuth),
    cam.target[2] + cam.distance * Math.sin(cam.elevation),
  ];
}

export function orbitViewMatrix(cam: OrbitCamera): Float32Array {
  const eye = orbitCameraPosition(cam);
  const [tx, ty, tz] = cam.target;

  let fx = tx - eye[0];
  let fy = ty - eye[1];
  let fz = tz - eye[2];
  const fLen = Math.sqrt(fx * fx + fy * fy + fz * fz);
  fx /= fLen; fy /= fLen; fz /= fLen;

  const ux = 0, uy = 0, uz = 1;

  let sx = fy * uz - fz * uy;
  let sy = fz * ux - fx * uz;
  let sz = fx * uy - fy * ux;
  const sLen = Math.sqrt(sx * sx + sy * sy + sz * sz);
  sx /= sLen; sy /= sLen; sz /= sLen;

  const uux = sy * fz - sz * fy;
  const uuy = sz * fx - sx * fz;
  const uuz = sx * fy - sy * fx;

  return new Float32Array([
    sx, uux, -fx, 0,
    sy, uuy, -fy, 0,
    sz, uuz, -fz, 0,
    -(sx * eye[0] + sy * eye[1] + sz * eye[2]),
    -(uux * eye[0] + uuy * eye[1] + uuz * eye[2]),
    -(-fx * eye[0] + -fy * eye[1] + -fz * eye[2]),
    1,
  ]);
}

export function perspectiveMatrix(
  fovDeg: number,
  aspect: number,
  near: number,
  far: number,
): Float32Array {
  const f = 1 / Math.tan((fovDeg * Math.PI) / 360);
  const rangeInv = 1 / (near - far);

  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far * rangeInv, -1,
    0, 0, near * far * rangeInv, 0,
  ]);
}

export function multiplyMat4(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[j * 4 + i] =
        a[i] * b[j * 4] +
        a[4 + i] * b[j * 4 + 1] +
        a[8 + i] * b[j * 4 + 2] +
        a[12 + i] * b[j * 4 + 3];
    }
  }
  return out;
}

export function setupOrbitControls(
  canvas: HTMLCanvasElement,
  camera: OrbitCamera,
  onUpdate: () => void,
): () => void {
  let isDragging = false;
  let isPanning = false;
  let lastX = 0;
  let lastY = 0;

  const onPointerDown = (e: PointerEvent) => {
    isDragging = true;
    isPanning = e.button === 2 || e.shiftKey;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    if (isPanning) {
      const scale = camera.distance * 0.002;
      const cosAz = Math.cos(camera.azimuth);
      const sinAz = Math.sin(camera.azimuth);
      camera.target[0] -= (dx * cosAz + dy * sinAz * Math.sin(camera.elevation)) * scale;
      camera.target[1] += (dx * sinAz - dy * cosAz * Math.sin(camera.elevation)) * scale;
      camera.target[2] += dy * Math.cos(camera.elevation) * scale;
    } else {
      camera.azimuth -= dx * 0.005;
      camera.elevation = Math.max(
        0.01,
        Math.min(Math.PI * 0.49, camera.elevation + dy * 0.005),
      );
    }
    onUpdate();
  };

  const onPointerUp = (e: PointerEvent) => {
    isDragging = false;
    isPanning = false;
    canvas.releasePointerCapture(e.pointerId);
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.1 : 0.9;
    camera.distance = Math.max(1, Math.min(50000, camera.distance * factor));
    onUpdate();
  };

  const onContext = (e: MouseEvent) => e.preventDefault();

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContext);

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('contextmenu', onContext);
  };
}
