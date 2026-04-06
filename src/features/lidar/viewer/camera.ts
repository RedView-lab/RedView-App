// ============================================
// Standalone LiDAR HD Viewer — Orbit Camera
// ============================================

export class CameraController {
  canvas: HTMLCanvasElement;

  radius = 500;
  theta = Math.PI / 4;
  phi = Math.PI / 4;
  targetX = 0;
  targetY = 0;
  targetZ = 0;

  private isDragging = false;
  private isPanning = false;
  private lastX = 0;
  private lastY = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  destroy() {
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
  }

  lookAt(cx: number, cy: number, cz: number, extent: number) {
    this.targetX = cx;
    this.targetY = cy;
    this.targetZ = cz;
    this.radius = extent * 1.2;
    this.theta = Math.PI / 4;
    this.phi = Math.PI / 3;
  }

  private onMouseDown = (e: MouseEvent) => {
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (e.button === 0) this.isDragging = true;
    else if (e.button === 1 || e.button === 2) this.isPanning = true;
    if (e.button === 1) e.preventDefault();
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.isDragging && !this.isPanning) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;

    if (this.isDragging) {
      this.theta -= dx * 0.005;
      this.phi -= dy * 0.005;
      this.phi = Math.max(0.05, Math.min(Math.PI - 0.05, this.phi));
    } else if (this.isPanning) {
      const speed = this.radius * 0.002;
      const sinPhi = Math.sin(this.phi);
      const rX = Math.cos(this.theta);
      const rZ = -Math.sin(this.theta);
      const uX = -Math.cos(this.phi) * Math.sin(this.theta);
      const uY = sinPhi;
      const uZ = -Math.cos(this.phi) * Math.cos(this.theta);
      this.targetX += (-dx * rX + dy * uX) * speed;
      this.targetY += dy * uY * speed;
      this.targetZ += (-dx * rZ + dy * uZ) * speed;
    }
  };

  private onMouseUp = () => {
    this.isDragging = false;
    this.isPanning = false;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.radius *= 1 + e.deltaY * 0.001;
    this.radius = Math.max(1, this.radius);
  };

  getEye(): [number, number, number] {
    const x = this.targetX + this.radius * Math.sin(this.phi) * Math.sin(this.theta);
    const y = this.targetY + this.radius * Math.cos(this.phi);
    const z = this.targetZ + this.radius * Math.sin(this.phi) * Math.cos(this.theta);
    return [x, y, z];
  }

  getViewMatrix(): Float32Array {
    const eye = this.getEye();
    const tx = this.targetX, ty = this.targetY, tz = this.targetZ;
    let fx = tx - eye[0], fy = ty - eye[1], fz = tz - eye[2];
    const fLen = Math.hypot(fx, fy, fz);
    fx /= fLen; fy /= fLen; fz /= fLen;
    const upX = 0, upY = 1, upZ = 0;
    let rx = fy * upZ - fz * upY;
    let ry = fz * upX - fx * upZ;
    let rz = fx * upY - fy * upX;
    const rLen = Math.hypot(rx, ry, rz);
    rx /= rLen; ry /= rLen; rz /= rLen;
    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;

    return new Float32Array([
      rx, ux, -fx, 0,
      ry, uy, -fy, 0,
      rz, uz, -fz, 0,
      -(rx * eye[0] + ry * eye[1] + rz * eye[2]),
      -(ux * eye[0] + uy * eye[1] + uz * eye[2]),
      -(-fx * eye[0] + -fy * eye[1] + -fz * eye[2]),
      1,
    ]);
  }

  getProjMatrix(): Float32Array {
    const aspect = this.canvas.width / this.canvas.height;
    const fov = Math.PI / 4;
    const near = 0.5;
    const far = this.radius * 10;
    const f = 1 / Math.tan(fov / 2);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) / (near - far), -1,
      0, 0, (2 * far * near) / (near - far), 0,
    ]);
  }
}
