import { CanvasSource, canEncodeVideo, Mp4OutputFormat, Output, Quality, StreamTarget, type StreamTargetChunk } from 'mediabunny';
import { VIDEO_BITRATE_BPS, VIDEO_KEYFRAME_INTERVAL_S } from './config';

/** Octets du début du fichier gardés en mémoire : l'en-tête `mdat` y est réécrit à la fin. */
const HEAD_BYTES = 1 << 16;
const CHUNK_BYTES = 8 << 20;

/**
 * Fichier assemblé en Blobs au fil de l'encodage : le navigateur range les
 * gros Blobs sur disque, une vidéo de plusieurs centaines de Mo ne reste
 * donc pas en mémoire. Le muxeur écrit dans l'ordre, sauf la taille de la
 * boîte `mdat` réécrite à la fin dans les premiers octets (gardés à part).
 */
class BlobFileAssembler {
  private readonly head = new Uint8Array(HEAD_BYTES);
  private headLength = 0;
  private readonly parts: Blob[] = [];
  private end = HEAD_BYTES;

  write(chunk: StreamTargetChunk): void {
    let { data, position } = chunk;
    if (position < HEAD_BYTES) {
      const inHead = Math.min(data.length, HEAD_BYTES - position);
      this.head.set(data.subarray(0, inHead), position);
      this.headLength = Math.max(this.headLength, position + inHead);
      data = data.subarray(inHead);
      position += inHead;
      if (data.length === 0) return;
    }
    if (position !== this.end) {
      throw new Error(`Écriture MP4 non séquentielle (${position}, attendu ${this.end}).`);
    }
    this.parts.push(new Blob([data.slice()]));
    this.end += data.length;
  }

  toBlob(): Blob {
    const head = this.head.slice(0, this.headLength);
    return new Blob(this.parts.length ? [head, ...this.parts] : [head], { type: 'video/mp4' });
  }
}

export interface VideoEncoderSink {
  /** Encode l'état courant du canevas comme image `index`. Attend la contre-pression de l'encodeur. */
  add(index: number): Promise<void>;
  finish(): Promise<Blob>;
  cancel(): Promise<void>;
}

/** Vrai si le navigateur encode du H.264 à cette taille (WebCodecs). */
export async function canEncodeFlyoverVideo(width: number, height: number, fps: number): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false;
  try {
    return await canEncodeVideo('avc', { width, height, frameRate: fps, quality: new Quality({ bitrate: VIDEO_BITRATE_BPS }) });
  } catch {
    return false;
  }
}

/** MP4 H.264 (High, débit variable) des images d'un canevas, à fréquence fixe. */
export async function createVideoEncoderSink(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  fps: number,
): Promise<VideoEncoderSink> {
  const file = new BlobFileAssembler();
  const writable = new WritableStream<StreamTargetChunk>({
    write: (chunk) => file.write(chunk),
  });
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(writable, { chunked: true, chunkSize: CHUNK_BYTES }),
  });
  const source = new CanvasSource(canvas, {
    codec: 'avc',
    quality: new Quality({ bitrate: VIDEO_BITRATE_BPS, bitrateMode: 'variable' }),
    keyFrameInterval: VIDEO_KEYFRAME_INTERVAL_S,
    latencyMode: 'quality',
  });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();
  const frameS = 1 / fps;
  return {
    add: (index) => source.add(index * frameS, frameS),
    async finish() {
      source.close();
      await output.finalize();
      return file.toBlob();
    },
    async cancel() {
      try {
        await output.cancel();
      } catch {
        /* déjà terminée */
      }
    },
  };
}
