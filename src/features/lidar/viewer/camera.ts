// ============================================
// Standalone LiDAR HD Viewer — Orbit Camera
// ============================================
//
// Mouse and wheel input move a goal pose; `update()` (once per rendered
// frame) eases the camera towards it. The motion stays continuous when the
// input arrives unevenly or a frame is late, and the wheel zooms smoothly
// instead of jumping by notches. Matrices and picking use the current pose.

/** Orbit pose: angles from the +Z axis (theta) and the vertical (phi), distance to the target. */
export interface CameraPose {
  theta: number;
  phi: number;
  radius: number;
  targetX: number;
  targetY: number;
  targetZ: number;
}

/** Time constants (ms) of the easing towards the goal pose. */
const ORBIT_SMOOTHING_MS = 45;
const ZOOM_SMOOTHING_MS = 80;
/** The camera snaps to its goal once this close (rad, or share of the radius for distances). */
const SNAP_EPSILON = 1e-4;
/** Frame step assumed when the camera starts moving (no previous frame). */
const DEFAULT_STEP_MS = 1000 / 60;
const MIN_PHI = 0.05;
const MAX_PHI = Math.PI - 0.05;

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

  /** Pose the input asks for; the current pose eases to it in `update`. */
  private readonly goal: CameraPose = { theta: Math.PI / 4, phi: Math.PI / 4, radius: 500, targetX: 0, targetY: 0, targetZ: 0 };
  private lastUpdateTime = -1;
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
    this.sceneRadius = Math.max(extent, 1);
    this.setPose({
      targetX: cx,
      targetY: cy,
      targetZ: cz,
      radius: this.sceneRadius * 1.2,
      theta: Math.PI / 4,
      phi: Math.PI / 3,
    });
  }

  getPose(): CameraPose {
    return {
      theta: this.theta,
      phi: this.phi,
      radius: this.radius,
      targetX: this.targetX,
      targetY: this.targetY,
      targetZ: this.targetZ,
    };
  }

  /** Jumps to a pose (current and goal), as for scripted paths and benchmarks. */
  setPose(pose: Partial<CameraPose>): void {
    const goal = this.goal;
    if (pose.theta !== undefined) goal.theta = pose.theta;
    if (pose.phi !== undefined) goal.phi = Math.max(MIN_PHI, Math.min(MAX_PHI, pose.phi));
    if (pose.radius !== undefined) goal.radius = Math.max(1, pose.radius);
    if (pose.targetX !== undefined) goal.targetX = pose.targetX;
    if (pose.targetY !== undefined) goal.targetY = pose.targetY;
    if (pose.targetZ !== undefined) goal.targetZ = pose.targetZ;
    this.theta = goal.theta;
    this.phi = goal.phi;
    this.radius = goal.radius;
    this.targetX = goal.targetX;
    this.targetY = goal.targetY;
    this.targetZ = goal.targetZ;
    this.notifyChange();
  }

  /**
   * Eases the current pose towards the goal; call once per rendered frame
   * with its timestamp (ms). Returns true while the camera still moves.
   */
  update(now: number): boolean {
    const step = this.lastUpdateTime >= 0 ? Math.min(100, Math.max(0, now - this.lastUpdateTime)) : DEFAULT_STEP_MS;
    const goal = this.goal;
    const orbit = 1 - Math.exp(-step / ORBIT_SMOOTHING_MS);
    const zoom = 1 - Math.exp(-step / ZOOM_SMOOTHING_MS);
    const panEpsilon = SNAP_EPSILON * Math.max(1, goal.radius);
    let moving = false;
    const ease = (current: number, target: number, k: number, epsilon: number): number => {
      if (Math.abs(target - current) <= epsilon) return target;
      moving = true;
      return current + (target - current) * k;
    };
    this.theta = ease(this.theta, goal.theta, orbit, SNAP_EPSILON);
    this.phi = ease(this.phi, goal.phi, orbit, SNAP_EPSILON);
    this.targetX = ease(this.targetX, goal.targetX, orbit, panEpsilon);
    this.targetY = ease(this.targetY, goal.targetY, orbit, panEpsilon);
    this.targetZ = ease(this.targetZ, goal.targetZ, orbit, panEpsilon);
    // Zoom eases in log space: the same speed per wheel notch at any distance.
    const logRadius = ease(Math.log(this.radius), Math.log(goal.radius), zoom, SNAP_EPSILON);
    this.radius = Math.exp(logRadius);
    this.lastUpdateTime = moving ? now : -1;
    return moving;
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
    const goal = this.goal;

    if (this.isDragging) {
      goal.theta -= dx * 0.005;
      goal.phi = Math.max(MIN_PHI, Math.min(MAX_PHI, goal.phi - dy * 0.005));
    } else if (this.isPanning) {
      const speed = goal.radius * 0.002;
      const sinPhi = Math.sin(goal.phi);
      const rX = Math.cos(goal.theta);
      const rZ = -Math.sin(goal.theta);
      const uX = -Math.cos(goal.phi) * Math.sin(goal.theta);
      const uY = sinPhi;
      const uZ = -Math.cos(goal.phi) * Math.cos(goal.theta);
      goal.targetX += (-dx * rX + dy * uX) * speed;
      goal.targetY += dy * uY * speed;
      goal.targetZ += (-dx * rZ + dy * uZ) * speed;
    }
    this.notifyChange();
  };

  private onMouseUp = () => {
    this.isDragging = false;
    this.isPanning = false;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.goal.radius = Math.max(1, this.goal.radius * (1 + e.deltaY * 0.001));
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

  private _renderProjMatrix = new Float32Array(16);

  /**
   * Projection used for rendering: reversed-Z with an infinite far plane
   * (depth = near / viewDistance, cleared to 0, compared with `greater`).
   * With a depth32float target this keeps precision at every distance, so a
   * tiny near plane no longer causes z-fighting between ground points and
   * the terrain mesh. Picking/overlays keep using `getProjMatrix()`.
   */
  getRenderProjMatrix(): Float32Array {
    const aspect = this.canvas.width / Math.max(this.canvas.height, 1);
    const f = 1 / Math.tan(Math.PI / 8);
    const near = 0.05;
    const m = this._renderProjMatrix;
    m.fill(0);
    m[0] = f / aspect;
    m[5] = f;
    m[11] = -1;
    m[14] = near;
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

