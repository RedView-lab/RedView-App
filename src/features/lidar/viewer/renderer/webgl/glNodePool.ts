// ============================================
// Résidence GPU des nœuds LOD chargés en flux — WebGL 2
// ============================================
//
// Même modèle que le pool WebGPU (../nodePool.ts) : chaque nœud résident
// possède son buffer de points empaquetés (16 o/point, envoyé tel que lu dans
// le cache LOD) et un buffer de couleurs pré-ombrées (4 o/point). L'ombrage est
// paresseux (époque + masque d'enfants, ré-ombré la prochaine fois que le nœud
// est dessiné) et tourne comme un vertex shader dont la sortie est capturée par
// transform feedback, rastérisation coupée : la forme WebGL 2 de la passe de calcul.
// Les paramètres par nœud vivent dans un seul uniform buffer, un emplacement
// aligné par nœud, lié à chaque draw avec `bindBufferRange` (le décalage
// dynamique du chemin WebGPU) ; le masque d'enfants fait partie de l'enregistrement.
// WebGL interdit qu'un buffer lié au transform feedback soit lié ailleurs en
// même temps : le buffer de couleurs n'est référencé que par le VAO de dessin
// du nœud, jamais laissé sur une liaison générique.

import type { SceneNode } from '../../lod/sceneLod';
import { LOD_POINT_STRIDE } from '../../lod/lodTile';
import { UBO_BINDING } from './glShaders';

/** Octets du bloc `NodeParams` (std140). */
const GL_NODE_UNIFORM_BYTES = 32;
/** Décalage en octets de `childMask` dans l'enregistrement. */
const CHILD_MASK_OFFSET = 24;

interface NodeGl {
  packed: WebGLBuffer;
  shaded: WebGLBuffer;
  /** Sprites instanciés : enregistrement empaqueté (unorm16x4) + couleur ombrée (unorm8x4), une instance par point. */
  drawVao: WebGLVertexArrayObject;
  /** Entrée de l'ombrage : enregistrement empaqueté en quatre mots u32 par sommet. */
  shadeVao: WebGLVertexArrayObject;
  slot: number;
  count: number;
  childMask: number;
  /** Époque d'ombrage pour laquelle les couleurs ont été écrites (−1 : jamais ombré). */
  shadedEpoch: number;
  /** Masque d'enfants pour lequel les couleurs ont été écrites. */
  shadedMask: number;
}

export class GlNodePool {
  private readonly gl: WebGL2RenderingContext;
  private readonly uniformBuffer: WebGLBuffer;
  private readonly feedback: WebGLTransformFeedback;
  /** Pas d'un emplacement : l'enregistrement arrondi à UNIFORM_BUFFER_OFFSET_ALIGNMENT. */
  private readonly stride: number;
  readonly capacity: number;
  private readonly freeSlots: number[] = [];
  private readonly nodes = new Map<number, NodeGl>();
  private readonly record = new ArrayBuffer(GL_NODE_UNIFORM_BYTES);
  private readonly recordF32 = new Float32Array(this.record);
  private readonly recordU32 = new Uint32Array(this.record);
  private readonly maskWord = new Uint32Array(1);
  private shadingEpoch = 0;

  constructor(gl: WebGL2RenderingContext, capacity: number) {
    this.gl = gl;
    this.capacity = capacity;
    const alignment = Math.max(1, Number(gl.getParameter(gl.UNIFORM_BUFFER_OFFSET_ALIGNMENT)) || 256);
    this.stride = Math.ceil(GL_NODE_UNIFORM_BYTES / alignment) * alignment;
    const uniformBuffer = gl.createBuffer();
    const feedback = gl.createTransformFeedback();
    if (!uniformBuffer || !feedback) throw new Error('WebGL node pool allocation failed');
    this.uniformBuffer = uniformBuffer;
    this.feedback = feedback;
    gl.bindBuffer(gl.UNIFORM_BUFFER, uniformBuffer);
    gl.bufferData(gl.UNIFORM_BUFFER, capacity * this.stride, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);
    for (let slot = capacity - 1; slot >= 0; slot--) this.freeSlots.push(slot);
  }

  /** Chaque nœud doit être ré-ombré (changement de mode de couleur, de surcouche, d'éclairage ou de heightmap). */
  invalidateShading(): void {
    this.shadingEpoch++;
  }

  upload(node: SceneNode, block: ArrayBuffer): boolean {
    const gl = this.gl;
    const count = node.entry.count;
    if (count === 0 || block.byteLength < count * LOD_POINT_STRIDE) return false;
    const slot = this.freeSlots.pop();
    if (slot === undefined) return false;

    const packed = gl.createBuffer();
    const shaded = gl.createBuffer();
    const drawVao = gl.createVertexArray();
    const shadeVao = gl.createVertexArray();
    if (!packed || !shaded || !drawVao || !shadeVao) {
      this.freeSlots.push(slot);
      return false;
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, packed);
    gl.bufferData(gl.ARRAY_BUFFER, new Uint8Array(block, 0, count * LOD_POINT_STRIDE), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, shaded);
    gl.bufferData(gl.ARRAY_BUFFER, count * 4, gl.DYNAMIC_COPY);

    gl.bindVertexArray(drawVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, packed);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.UNSIGNED_SHORT, true, LOD_POINT_STRIDE, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, shaded);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.UNSIGNED_BYTE, true, 4, 0);
    gl.vertexAttribDivisor(1, 1);

    gl.bindVertexArray(shadeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, packed);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribIPointer(0, 4, gl.UNSIGNED_INT, LOD_POINT_STRIDE, 0);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this.recordF32[0] = node.originX;
    this.recordF32[1] = node.originY;
    this.recordF32[2] = node.originZ;
    this.recordF32[3] = node.size;
    this.recordF32[4] = node.adaptiveSpacing;
    this.recordU32[5] = count;
    this.recordU32[6] = 0;
    this.recordF32[7] = 0;
    gl.bindBuffer(gl.UNIFORM_BUFFER, this.uniformBuffer);
    gl.bufferSubData(gl.UNIFORM_BUFFER, slot * this.stride, this.recordU32);
    gl.bindBuffer(gl.UNIFORM_BUFFER, null);

    this.nodes.set(node.id, { packed, shaded, drawVao, shadeVao, slot, count, childMask: 0, shadedEpoch: -1, shadedMask: 0 });
    return true;
  }

  release(node: SceneNode): void {
    const entry = this.nodes.get(node.id);
    if (!entry) return;
    this.deleteEntry(entry);
    this.freeSlots.push(entry.slot);
    this.nodes.delete(node.id);
  }

  private deleteEntry(entry: NodeGl): void {
    const gl = this.gl;
    gl.deleteVertexArray(entry.drawVao);
    gl.deleteVertexArray(entry.shadeVao);
    gl.deleteBuffer(entry.packed);
    gl.deleteBuffer(entry.shaded);
  }

  private bindNodeRecord(slot: number): void {
    this.gl.bindBufferRange(this.gl.UNIFORM_BUFFER, UBO_BINDING.node, this.uniformBuffer, slot * this.stride, GL_NODE_UNIFORM_BYTES);
  }

  /**
   * Prépare les nœuds sur le point d'être dessinés : écrit les masques
   * d'enfants qui ont changé et ré-ombre les nœuds dont les couleurs sont
   * périmées. `shadeProgram` doit être courant avec les uniforms et textures de
   * la scène liés ; renvoie le nombre de nœuds ombrés.
   */
  prepareFrame(nodes: readonly SceneNode[], shadeProgram: WebGLProgram): number {
    const gl = this.gl;
    let maskWritten = false;
    for (const node of nodes) {
      const entry = this.nodes.get(node.id);
      if (!entry || entry.childMask === node.childMask) continue;
      if (!maskWritten) {
        gl.bindBuffer(gl.UNIFORM_BUFFER, this.uniformBuffer);
        maskWritten = true;
      }
      entry.childMask = node.childMask;
      this.maskWord[0] = node.childMask >>> 0;
      gl.bufferSubData(gl.UNIFORM_BUFFER, entry.slot * this.stride + CHILD_MASK_OFFSET, this.maskWord);
    }
    if (maskWritten) gl.bindBuffer(gl.UNIFORM_BUFFER, null);

    let shaded = 0;
    for (const node of nodes) {
      const entry = this.nodes.get(node.id);
      if (!entry || (entry.shadedEpoch === this.shadingEpoch && entry.shadedMask === entry.childMask)) continue;
      if (shaded === 0) {
        gl.useProgram(shadeProgram);
        gl.enable(gl.RASTERIZER_DISCARD);
        gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.feedback);
      }
      gl.bindVertexArray(entry.shadeVao);
      this.bindNodeRecord(entry.slot);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, entry.shaded);
      gl.beginTransformFeedback(gl.POINTS);
      gl.drawArrays(gl.POINTS, 0, entry.count);
      gl.endTransformFeedback();
      entry.shadedEpoch = this.shadingEpoch;
      entry.shadedMask = entry.childMask;
      shaded++;
    }
    if (shaded > 0) {
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
      gl.disable(gl.RASTERIZER_DISCARD);
      gl.bindVertexArray(null);
    }
    return shaded;
  }

  /** Dessine les nœuds donnés en sprites instanciés (programme des points courant) ; renvoie le nombre de draws. */
  draw(nodes: readonly SceneNode[]): number {
    const gl = this.gl;
    let draws = 0;
    for (const node of nodes) {
      const entry = this.nodes.get(node.id);
      if (!entry) continue;
      gl.bindVertexArray(entry.drawVao);
      this.bindNodeRecord(entry.slot);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, entry.count);
      draws++;
    }
    gl.bindVertexArray(null);
    return draws;
  }

  destroy(): void {
    for (const entry of this.nodes.values()) this.deleteEntry(entry);
    this.nodes.clear();
    this.gl.deleteBuffer(this.uniformBuffer);
    this.gl.deleteTransformFeedback(this.feedback);
  }
}
