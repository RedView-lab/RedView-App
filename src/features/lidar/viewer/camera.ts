// ============================================
// Standalone LiDAR HD Viewer — Camera (orbit + look-around)
// ============================================
//
// Two modes share the matrices every consumer reads (renderer, LOD,
// picking, overlays):
//  - orbit: the camera circles a target (left drag orbits, right/middle
//    drag or Shift pans, wheel zooms);
//  - look: the eye stays at one spot (a person standing on the terrain)
//    and the view turns around it over 360° (drag), the wheel narrows or
//    widens the field of view like binoculars.
// Mouse and wheel input move a goal pose; `update()` (once per rendered
// frame) eases the camera towards it. The motion stays continuous when the
// input arrives unevenly or a frame is late. Matrices and picking use the
// current pose.

/** Orbit pose: angles from the +Z axis (theta) and the vertical (phi), distance to the target. */
export interface CameraPose {
  theta: number;
  phi: number;
  radius: number;
  targetX: number;
  targetY: number;
  targetZ: number;
}

/**
 * Look-around pose: eye position (render frame), heading `yaw` (radians,
 * clockwise from the grid north, −Z), `pitch` above the horizon, and the
 * horizontal field of view `fovX` (radians).
 */
export interface LookPose {
  eyeX: number;
  eyeY: number;
  eyeZ: number;
  yaw: number;
  pitch: number;
  fovX: number;
}

export type CameraMode = 'orbit' | 'look';

/** Time constants (ms) of the easing towards the goal pose. */
const ORBIT_SMOOTHING_MS = 45;
const ZOOM_SMOOTHING_MS = 80;
/** The eye flies to (or back from) a look-around spot over a few hundred ms. */
const FLY_SMOOTHING_MS = 220;
/** The camera snaps to its goal once this close (rad, or share of the radius for distances). */
const SNAP_EPSILON = 1e-4;
/** Frame step assumed when the camera starts moving (no previous frame). */
const DEFAULT_STEP_MS = 1000 / 60;
const MIN_PHI = 0.05;
const MAX_PHI = Math.PI - 0.05;
/** Vertical field of view of the orbit camera. */
const ORBIT_FOV_Y = Math.PI / 4;
const DEG = Math.PI / 180;
/** Look-around limits: no gimbal flip at the zenith/nadir, binoculars to wide angle. */
const LOOK_MAX_PITCH = 85 * DEG;
export const LOOK_MIN_FOV_X = 3 * DEG;
export const LOOK_MAX_FOV_X = 120 * DEG;

/** Zoom per wheel pixel (log scale): ≈ ×1.1 per 100 px notch. */
const WHEEL_ZOOM_PER_PX = 0.001;
/** Pixels of one `DOM_DELTA_LINE` step: Firefox reports mouse wheels in lines (3 per notch). */
const WHEEL_LINE_PX = 40;
/** Largest step taken from one wheel event: a page-mode notch or a fling stays a gentle zoom. */
const WHEEL_MAX_STEP_PX = 300;

/**
 * Vertical wheel delta in pixels, whatever the event's unit: Chrome and
 * Safari send pixels (100–120 per notch, ≈ 53 on Linux X11), Firefox lines
 * (3 per notch, on Linux too), some mice pages.
 */
export function wheelDeltaPixels(event: Pick<WheelEvent, 'deltaY' | 'deltaMode'>, pageHeightPx: number): number {
  const unit = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? Math.max(1, pageHeightPx) : 1;
  const px = event.deltaY * unit;
  if (!Number.isFinite(px)) return 0;
  return Math.max(-WHEEL_MAX_STEP_PX, Math.min(WHEEL_MAX_STEP_PX, px));
}

function wrapAngle(a: number): number {
  return ((a % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
}

function forwardOf(yaw: number, pitch: number): [number, number, number] {
  const c = Math.cos(pitch);
  return [Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c];
}

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
  private mode: CameraMode = 'orbit';
  private readonly look: LookPose = { eyeX: 0, eyeY: 0, eyeZ: 0, yaw: 0, pitch: 0, fovX: 90 * DEG };
  private readonly lookGoal: LookPose = { eyeX: 0, eyeY: 0, eyeZ: 0, yaw: 0, pitch: 0, fovX: 90 * DEG };
  /** Orbit goal to return to when the look-around ends. */
  private savedOrbit: CameraPose | null = null;
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

  getMode(): CameraMode {
    return this.mode;
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

  /** Current look-around pose (meaningful in `look` mode). */
  getLookPose(): LookPose {
    return { ...this.look };
  }

  /** Changes whenever the rendered view changes (projection caches key on it). */
  getViewKey(): number[] {
    const aspect = this.canvas.width / Math.max(this.canvas.height, 1);
    if (this.mode === 'look') {
      const l = this.look;
      return [1, l.eyeX, l.eyeY, l.eyeZ, l.yaw, l.pitch, l.fovX, aspect];
    }
    return [0, this.theta, this.phi, this.radius, this.targetX, this.targetY, this.targetZ, aspect];
  }

  /** Vertical field of view of the current projection (radians). */
  getFovY(): number {
    if (this.mode === 'orbit') return ORBIT_FOV_Y;
    const aspect = this.canvas.width / Math.max(this.canvas.height, 1);
    return 2 * Math.atan(Math.tan(this.look.fovX / 2) / aspect);
  }

  /** Jumps to a pose (current and goal), as for scripted paths and benchmarks. */
  setPose(pose: Partial<CameraPose>): void {
    this.mode = 'orbit';
    this.savedOrbit = null;
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

  /** Eases to an orbit pose (sets the goal only), like a mouse gesture would; ends a look-around. */
  animateTo(pose: Partial<CameraPose>): void {
    if (this.mode === 'look') this.orbitFromLook();
    this.savedOrbit = null;
    const goal = this.goal;
    if (pose.theta !== undefined) goal.theta += wrapAngle(pose.theta - goal.theta);
    if (pose.phi !== undefined) goal.phi = Math.max(MIN_PHI, Math.min(MAX_PHI, pose.phi));
    if (pose.radius !== undefined) goal.radius = Math.max(1, pose.radius);
    if (pose.targetX !== undefined) goal.targetX = pose.targetX;
    if (pose.targetY !== undefined) goal.targetY = pose.targetY;
    if (pose.targetZ !== undefined) goal.targetZ = pose.targetZ;
    this.notifyChange();
  }

  // ── Look-around ─────────────────────────────────────────────────────────────

  /**
   * Flies the eye to `eye` (render frame) and turns into look-around mode.
   * The flight starts from the current view, so the move reads as one.
   */
  enterLook(eye: [number, number, number], pose: { yaw: number; pitch: number; fovX: number }): void {
    if (this.mode === 'orbit') {
      this.savedOrbit = { ...this.goal };
      const from = this.getEye();
      const fx = this.targetX - from[0];
      const fy = this.targetY - from[1];
      const fz = this.targetZ - from[2];
      const len = Math.hypot(fx, fy, fz) || 1;
      const aspect = this.canvas.width / Math.max(this.canvas.height, 1);
      Object.assign(this.look, {
        eyeX: from[0],
        eyeY: from[1],
        eyeZ: from[2],
        yaw: Math.atan2(fx, -fz),
        pitch: Math.asin(Math.max(-1, Math.min(1, fy / len))),
        fovX: 2 * Math.atan(Math.tan(ORBIT_FOV_Y / 2) * aspect),
      });
      this.mode = 'look';
    }
    Object.assign(this.lookGoal, { eyeX: eye[0], eyeY: eye[1], eyeZ: eye[2] });
    this.setLookGoal(pose);
  }

  /** Eases the look-around orientation / field of view (look mode only). */
  setLookGoal(pose: Partial<Pick<LookPose, 'yaw' | 'pitch' | 'fovX'>>): void {
    if (this.mode !== 'look') return;
    const goal = this.lookGoal;
    if (pose.yaw !== undefined) goal.yaw = this.look.yaw + wrapAngle(pose.yaw - this.look.yaw);
    if (pose.pitch !== undefined) goal.pitch = Math.max(-LOOK_MAX_PITCH, Math.min(LOOK_MAX_PITCH, pose.pitch));
    if (pose.fovX !== undefined) goal.fovX = Math.max(LOOK_MIN_FOV_X, Math.min(LOOK_MAX_FOV_X, pose.fovX));
    this.notifyChange();
  }

  /** Target of the look-around (eye, heading, pitch, field of view) once eased. */
  getLookGoal(): LookPose {
    return { ...this.lookGoal };
  }

  /** Ends the look-around and flies back to the orbit view it started from. */
  exitLook(): void {
    if (this.mode !== 'look') return;
    const saved = this.savedOrbit;
    this.orbitFromLook();
    if (saved) Object.assign(this.goal, saved, { theta: this.goal.theta + wrapAngle(saved.theta - this.goal.theta) });
    this.savedOrbit = null;
    this.notifyChange();
  }

  /** Switches to orbit with a pose that reproduces the current look-around view (no jump). */
  private orbitFromLook(): void {
    const l = this.look;
    const [fx, fy, fz] = forwardOf(l.yaw, l.pitch);
    // Orbit around a point ahead, at the distance the saved view had.
    const radius = Math.max(5, this.savedOrbit?.radius ?? 100);
    this.mode = 'orbit';
    this.targetX = l.eyeX + fx * radius;
    this.targetY = l.eyeY + fy * radius;
    this.targetZ = l.eyeZ + fz * radius;
    this.radius = radius;
    this.phi = Math.max(MIN_PHI, Math.min(MAX_PHI, Math.acos(-fy)));
    this.theta = Math.atan2(-fx, -fz);
    Object.assign(this.goal, this.getPose());
  }

  // ── Frame update ────────────────────────────────────────────────────────────

  /**
   * Eases the current pose towards the goal; call once per rendered frame
   * with its timestamp (ms). Returns true while the camera still moves.
   */
  update(now: number): boolean {
    const step = this.lastUpdateTime >= 0 ? Math.min(100, Math.max(0, now - this.lastUpdateTime)) : DEFAULT_STEP_MS;
    const orbit = 1 - Math.exp(-step / ORBIT_SMOOTHING_MS);
    const zoom = 1 - Math.exp(-step / ZOOM_SMOOTHING_MS);
    let moving = false;
    const ease = (current: number, target: number, k: number, epsilon: number): number => {
      if (Math.abs(target - current) <= epsilon) return target;
      moving = true;
      return current + (target - current) * k;
    };
    if (this.mode === 'look') {
      const fly = 1 - Math.exp(-step / FLY_SMOOTHING_MS);
      const l = this.look;
      const g = this.lookGoal;
      l.eyeX = ease(l.eyeX, g.eyeX, fly, 1e-3);
      l.eyeY = ease(l.eyeY, g.eyeY, fly, 1e-3);
      l.eyeZ = ease(l.eyeZ, g.eyeZ, fly, 1e-3);
      l.yaw = ease(l.yaw, g.yaw, orbit, SNAP_EPSILON);
      l.pitch = ease(l.pitch, g.pitch, orbit, SNAP_EPSILON);
      l.fovX = Math.exp(ease(Math.log(l.fovX), Math.log(g.fovX), zoom, SNAP_EPSILON));
    } else {
      const goal = this.goal;
      const panEpsilon = SNAP_EPSILON * Math.max(1, goal.radius);
      this.theta = ease(this.theta, goal.theta, orbit, SNAP_EPSILON);
      this.phi = ease(this.phi, goal.phi, orbit, SNAP_EPSILON);
      this.targetX = ease(this.targetX, goal.targetX, orbit, panEpsilon);
      this.targetY = ease(this.targetY, goal.targetY, orbit, panEpsilon);
      this.targetZ = ease(this.targetZ, goal.targetZ, orbit, panEpsilon);
      // Zoom eases in log space: the same speed per wheel notch at any distance.
      const logRadius = ease(Math.log(this.radius), Math.log(goal.radius), zoom, SNAP_EPSILON);
      this.radius = Math.exp(logRadius);
    }
    this.lastUpdateTime = moving ? now : -1;
    return moving;
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private onMouseDown = (e: MouseEvent) => {
    if (this.isLocked) return;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (this.mode === 'look') {
      // Every button turns the head; there is nothing to pan around.
      this.isDragging = true;
    } else if (e.button === 0) {
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

    if (this.mode === 'look') {
      // The scene follows the cursor: one pixel turns the view by one
      // pixel's worth of field of view, whatever the zoom.
      const g = this.lookGoal;
      const perPixelX = g.fovX / Math.max(1, this.canvas.clientWidth);
      const perPixelY = this.getFovY() / Math.max(1, this.canvas.clientHeight);
      g.yaw -= dx * perPixelX;
      g.pitch = Math.max(-LOOK_MAX_PITCH, Math.min(LOOK_MAX_PITCH, g.pitch + dy * perPixelY));
      this.notifyChange();
      return;
    }

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
    const factor = Math.exp(wheelDeltaPixels(e, this.canvas.clientHeight) * WHEEL_ZOOM_PER_PX);
    if (this.mode === 'look') {
      const g = this.lookGoal;
      g.fovX = Math.max(LOOK_MIN_FOV_X, Math.min(LOOK_MAX_FOV_X, g.fovX * factor));
    } else {
      this.goal.radius = Math.max(1, this.goal.radius * factor);
    }
    this.notifyChange();
  };

  private notifyChange() {
    this.onChange?.();
  }

  // ── Matrices ────────────────────────────────────────────────────────────────

  private _viewMatrix = new Float32Array(16);
  private _projMatrix = new Float32Array(16);
  private _eye: [number, number, number] = [0, 0, 0];

  getEye(): [number, number, number] {
    if (this.mode === 'look') {
      this._eye[0] = this.look.eyeX;
      this._eye[1] = this.look.eyeY;
      this._eye[2] = this.look.eyeZ;
      return this._eye;
    }
    const x = this.targetX + this.radius * Math.sin(this.phi) * Math.sin(this.theta);
    const y = this.targetY + this.radius * Math.cos(this.phi);
    const z = this.targetZ + this.radius * Math.sin(this.phi) * Math.cos(this.theta);
    this._eye[0] = x;
    this._eye[1] = y;
    this._eye[2] = z;
    return this._eye;
  }

  /** Unit view direction. */
  getForward(): [number, number, number] {
    if (this.mode === 'look') return forwardOf(this.look.yaw, this.look.pitch);
    const eye = this.getEye();
    const fx = this.targetX - eye[0];
    const fy = this.targetY - eye[1];
    const fz = this.targetZ - eye[2];
    const len = Math.hypot(fx, fy, fz) || 1;
    return [fx / len, fy / len, fz / len];
  }

  getViewMatrix(): Float32Array {
    const eye = this.getEye();
    const [fx, fy, fz] = this.getForward();
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
    const f = 1 / Math.tan(this.getFovY() / 2);
    const near = 0.05;
    const m = this._renderProjMatrix;
    m.fill(0);
    m[0] = f / aspect;
    m[5] = f;
    m[11] = -1;
    m[14] = near;
    return m;
  }

  /**
   * Near/far planes of the current view: those of `getProjMatrix`, also
   * the depth range of renderers that cannot use the infinite reversed-Z
   * projection (WebGL 2).
   */
  getDepthRange(): { near: number; far: number } {
    if (this.mode === 'look') return { near: 0.05, far: this.sceneRadius * 8 + 1000 };
    return {
      near: Math.max(0.05, Math.min(2, this.radius * 0.01)),
      far: Math.max(this.radius * 10, this.radius + this.sceneRadius * 4),
    };
  }

  getProjMatrix(): Float32Array {
    const aspect = this.canvas.width / Math.max(this.canvas.height, 1);
    const { near, far } = this.getDepthRange();
    const f = 1 / Math.tan(this.getFovY() / 2);
    const nf = 1 / (near - far);

    const m = this._projMatrix;
    m[0] = f / aspect; m[1] = 0; m[2] = 0;           m[3] = 0;
    m[4] = 0;          m[5] = f; m[6] = 0;           m[7] = 0;
    m[8] = 0;          m[9] = 0; m[10] = far * nf;   m[11] = -1;
    m[12] = 0;         m[13] = 0; m[14] = far * near * nf; m[15] = 0;

    return m;
  }
}
