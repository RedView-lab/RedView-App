// ============================================
// Standalone LiDAR HD Viewer — Orbit CameraTEST
// ============================================

export class CameraController {
  canvas: HTMLCanvasElement;

  radius = 500;
  theta = Math.PI / 4;
  phi = Math.PI / 4;
  targetX = 0;
  targetY = 0;
  targetZ = 0;
  sceneRadius = 500;
  onChange: (() => void) | null = null;

  private isDragging = false;
  private isPanning = false;
  private lastX = 0;
  private lastY = 0;
  public isLocked = false;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setLocked(locked: boolean) {
    this.isLocked = locked;
    if (locked) {
      this.isDragging = false;
      this.isPanning = false;
    }
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
    this.sceneRadius = Math.max(extent, 1);
    this.radius = this.sceneRadius * 1.2;
    this.theta = Math.PI / 4;
    this.phi = Math.PI / 3;
    this.notifyChange();
  }

  private onMouseDown = (e: MouseEvent) => {
    if (this.isLocked) return;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (e.button === 0) {
      if (e.shiftKey) {
        this.isPanning = true;
      } else {
        this.isDragging = true;
      }
    } else if (e.button === 1 || e.button === 2) {
      this.isPanning = true;
    }
    if (e.button === 1 || e.button === 2) e.preventDefault();
  };

  private onMouseMove = (e: MouseEvent) => {
    if (this.isLocked) {
      this.isDragging = false;
      this.isPanning = false;
      return;
    }
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
    this.notifyChange();
  };

  private onMouseUp = () => {
    this.isDragging = false;
    this.isPanning = false;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.radius *= 1 + e.deltaY * 0.001;
    this.radius = Math.max(1, this.radius);
    this.notifyChange();
  };

  private notifyChange() {
    this.onChange?.();
  }

  private _viewMatrix = new Float32Array(16);
  private _projMatrix = new Float32Array(16);
  private _eye: [number, number, number] = [0, 0, 0];

  getEye(): [number, number, number] {
    const x = this.targetX + this.radius * Math.sin(this.phi) * Math.sin(this.theta);
    const y = this.targetY + this.radius * Math.cos(this.phi);
    const z = this.targetZ + this.radius * Math.sin(this.phi) * Math.cos(this.theta);
    this._eye[0] = x;
    this._eye[1] = y;
    this._eye[2] = z;
    return this._eye;
  }

  getViewMatrix(): Float32Array {
    const eye = this.getEye();
    const tx = this.targetX, ty = this.targetY, tz = this.targetZ;
    let fx = tx - eye[0], fy = ty - eye[1], fz = tz - eye[2];
    const fLen = Math.hypot(fx, fy, fz) || 1;
    fx /= fLen; fy /= fLen; fz /= fLen;
    const upX = 0, upY = 1, upZ = 0;
    let rx = fy * upZ - fz * upY;
    let ry = fz * upX - fx * upZ;
    let rz = fx * upY - fy * upX;
    const rLen = Math.hypot(rx, ry, rz) || 1;
    rx /= rLen; ry /= rLen; rz /= rLen;
    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;

    const m = this._viewMatrix;
    m[0] = rx;   m[1] = ux;   m[2] = -fx;  m[3] = 0;
    m[4] = ry;   m[5] = uy;   m[6] = -fy;  m[7] = 0;
    m[8] = rz;   m[9] = uz;   m[10] = -fz; m[11] = 0;
    m[12] = -(rx * eye[0] + ry * eye[1] + rz * eye[2]);
    m[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
    m[14] = -(-fx * eye[0] + -fy * eye[1] + -fz * eye[2]);
    m[15] = 1;

    return m;
  }

  getProjMatrix(): Float32Array {
    const aspect = this.canvas.width / Math.max(this.canvas.height, 1);
    const fov = Math.PI / 4;
    const near = Math.max(0.05, Math.min(2, this.radius * 0.01));
    const far = Math.max(this.radius * 10, this.radius + this.sceneRadius * 4);
    const f = 1 / Math.tan(fov / 2);
    const nf = 1 / (near - far);

    const m = this._projMatrix;
    m[0] = f / aspect; m[1] = 0; m[2] = 0;           m[3] = 0;
    m[4] = 0;          m[5] = f; m[6] = 0;           m[7] = 0;
    m[8] = 0;          m[9] = 0; m[10] = far * nf;   m[11] = -1;
    m[12] = 0;         m[13] = 0; m[14] = far * near * nf; m[15] = 0;

    return m;
  }
}

