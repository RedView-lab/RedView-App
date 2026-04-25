import type { TerrainMeshWebGL } from './terrainWorker';

export type TerrainExportFormat = 'gltf' | 'fbx';

interface TerrainExportParams {
  format: TerrainExportFormat;
  mesh: TerrainMeshWebGL;
  orthoBitmap: ImageBitmap;
  baseName: string;
}

interface PackedChunk {
  byteOffset: number;
  byteLength: number;
}

export async function downloadTerrainExport({
  format,
  mesh,
  orthoBitmap,
  baseName,
}: TerrainExportParams): Promise<void> {
  const textureBlob = await bitmapToPngBlob(orthoBitmap);

  if (format === 'gltf') {
    const gltf = buildGltfExport(mesh, baseName);
    triggerDownload(`${baseName}.gltf`, new Blob([JSON.stringify(gltf.document, null, 2)], { type: 'model/gltf+json' }));
    triggerDownload(`${baseName}.bin`, new Blob([gltf.binary], { type: 'application/octet-stream' }));
    triggerDownload(`${baseName}.png`, textureBlob);
    return;
  }

  const fbx = buildFbxExport(mesh, `${baseName}.png`);
  triggerDownload(`${baseName}.fbx`, new Blob([fbx], { type: 'application/octet-stream' }));
  triggerDownload(`${baseName}.png`, textureBlob);
}

async function bitmapToPngBlob(bitmap: ImageBitmap): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error("Canvas 2D indisponible pour l'export");
  ctx.drawImage(bitmap, 0, 0);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((next) => {
      if (next) resolve(next);
      else reject(new Error('Encodage PNG impossible'));
    }, 'image/png');
  });

  return blob;
}

function buildGltfExport(mesh: TerrainMeshWebGL, baseName: string) {
  const split = splitInterleavedVertices(mesh);
  const packed = packBinary([toBytes(split.positions), toBytes(split.normals), toBytes(split.uvs), toBytes(mesh.indices)]);
  const positionMinMax = computePositionMinMax(split.positions);
  const imageName = `${baseName}.png`;

  const document = {
    asset: {
      version: '2.0',
      generator: 'RedView WebGL Exporter',
    },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: baseName }],
    samplers: [
      {
        magFilter: 9729,
        minFilter: 9987,
        wrapS: 33071,
        wrapT: 33071,
      },
    ],
    images: [{ uri: imageName }],
    textures: [{ sampler: 0, source: 0 }],
    materials: [
      {
        name: 'Orthophoto',
        pbrMetallicRoughness: {
          baseColorTexture: { index: 0 },
          metallicFactor: 0,
          roughnessFactor: 1,
        },
        doubleSided: true,
      },
    ],
    buffers: [{ byteLength: packed.totalByteLength, uri: `${baseName}.bin` }],
    bufferViews: [
      { buffer: 0, byteOffset: packed.chunks[0].byteOffset, byteLength: packed.chunks[0].byteLength, target: 34962 },
      { buffer: 0, byteOffset: packed.chunks[1].byteOffset, byteLength: packed.chunks[1].byteLength, target: 34962 },
      { buffer: 0, byteOffset: packed.chunks[2].byteOffset, byteLength: packed.chunks[2].byteLength, target: 34962 },
      { buffer: 0, byteOffset: packed.chunks[3].byteOffset, byteLength: packed.chunks[3].byteLength, target: 34963 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: mesh.vertexCount,
        type: 'VEC3',
        min: positionMinMax.min,
        max: positionMinMax.max,
      },
      {
        bufferView: 1,
        componentType: 5126,
        count: mesh.vertexCount,
        type: 'VEC3',
      },
      {
        bufferView: 2,
        componentType: 5126,
        count: mesh.vertexCount,
        type: 'VEC2',
      },
      {
        bufferView: 3,
        componentType: 5125,
        count: mesh.indexCount,
        type: 'SCALAR',
      },
    ],
    meshes: [
      {
        name: baseName,
        primitives: [
          {
            attributes: {
              POSITION: 0,
              NORMAL: 1,
              TEXCOORD_0: 2,
            },
            indices: 3,
            material: 0,
            mode: 4,
          },
        ],
      },
    ],
  };

  return {
    document,
    binary: packed.buffer,
  };
}

function buildFbxExport(mesh: TerrainMeshWebGL, textureFileName: string): string {
  const split = splitInterleavedVertices(mesh);
  const vertices = numberArrayToFbx(split.positions);
  const polygonVertexIndex = numberArrayToFbx(buildFbxPolygonIndexArray(mesh.indices));
  const normals = numberArrayToFbx(split.normals);
  const uvs = numberArrayToFbx(split.uvs);
  const nodeName = sanitizeObjectName(textureFileName.replace(/\.png$/i, ''));

  return `; FBX 7.4.0 project file
FBXHeaderExtension:  {
  FBXHeaderVersion: 1003
  FBXVersion: 7400
  Creator: "RedView WebGL Exporter"
}
GlobalSettings:  {
  Version: 1000
  Properties70:  {
    P: "UpAxis", "int", "Integer", "",1
    P: "UpAxisSign", "int", "Integer", "",1
    P: "FrontAxis", "int", "Integer", "",2
    P: "FrontAxisSign", "int", "Integer", "",1
    P: "CoordAxis", "int", "Integer", "",0
    P: "CoordAxisSign", "int", "Integer", "",1
    P: "UnitScaleFactor", "double", "Number", "",1
    P: "OriginalUnitScaleFactor", "double", "Number", "",1
  }
}
Definitions:  {
  Version: 100
  Count: 5
  ObjectType: "Geometry" { Count: 1 }
  ObjectType: "Model" { Count: 1 }
  ObjectType: "Material" { Count: 1 }
  ObjectType: "Texture" { Count: 1 }
  ObjectType: "Video" { Count: 1 }
}
Objects:  {
  Geometry: 1000, "Geometry::${nodeName}", "Mesh" {
    Vertices: *${split.positions.length} {
      a: ${vertices}
    }
    PolygonVertexIndex: *${mesh.indexCount} {
      a: ${polygonVertexIndex}
    }
    GeometryVersion: 124
    LayerElementNormal: 0 {
      Version: 101
      Name: "Normals"
      MappingInformationType: "ByVertice"
      ReferenceInformationType: "Direct"
      Normals: *${split.normals.length} {
        a: ${normals}
      }
    }
    LayerElementUV: 0 {
      Version: 101
      Name: "UVChannel_1"
      MappingInformationType: "ByVertice"
      ReferenceInformationType: "Direct"
      UV: *${split.uvs.length} {
        a: ${uvs}
      }
    }
    LayerElementMaterial: 0 {
      Version: 101
      Name: ""
      MappingInformationType: "AllSame"
      ReferenceInformationType: "IndexToDirect"
      Materials: *1 {
        a: 0
      }
    }
    Layer: 0 {
      Version: 100
      LayerElement: {
        Type: "LayerElementNormal"
        TypedIndex: 0
      }
      LayerElement: {
        Type: "LayerElementUV"
        TypedIndex: 0
      }
      LayerElement: {
        Type: "LayerElementMaterial"
        TypedIndex: 0
      }
    }
  }
  Model: 1001, "Model::${nodeName}", "Mesh" {
    Version: 232
    Properties70:  {
      P: "Lcl Translation", "Lcl Translation", "", "A",0,0,0
      P: "Lcl Rotation", "Lcl Rotation", "", "A",0,0,0
      P: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1
    }
    Shading: T
    Culling: "CullingOff"
  }
  Material: 1002, "Material::${nodeName}_Material", "" {
    Version: 102
    ShadingModel: "phong"
    MultiLayer: 0
    Properties70:  {
      P: "DiffuseColor", "Color", "", "A",1,1,1
      P: "SpecularColor", "Color", "", "A",0,0,0
      P: "SpecularFactor", "Number", "", "A",0
      P: "ShininessExponent", "Number", "", "A",2
    }
  }
  Texture: 1003, "Texture::${nodeName}_Texture", "TextureVideoClip" {
    Type: "TextureVideoClip"
    Version: 202
    TextureName: "Texture::${nodeName}_Texture"
    FileName: "${textureFileName}"
    RelativeFilename: "${textureFileName}"
    ModelUVTranslation: 0,0
    ModelUVScaling: 1,1
    Texture_Alpha_Source: "None"
    Cropping: 0,0,0,0
  }
  Video: 1004, "Video::${nodeName}_Video", "Clip" {
    Type: "Clip"
    Properties70:  {
      P: "Path", "KString", "XRefUrl", "", "${textureFileName}"
    }
    UseMipMap: 0
    Filename: "${textureFileName}"
    RelativeFilename: "${textureFileName}"
  }
}
Connections:  {
  C: "OO",1000,1001
  C: "OO",1001,0
  C: "OO",1002,1001
  C: "OO",1003,1002
  C: "OP",1003,1002,"DiffuseColor"
  C: "OO",1004,1003
}
Takes:  {
  Current: ""
}
`;
}

function splitInterleavedVertices(mesh: TerrainMeshWebGL) {
  const positions = new Float32Array(mesh.vertexCount * 3);
  const normals = new Float32Array(mesh.vertexCount * 3);
  const uvs = new Float32Array(mesh.vertexCount * 2);

  for (let vertexIndex = 0; vertexIndex < mesh.vertexCount; vertexIndex++) {
    const src = vertexIndex * 8;
    const pos = vertexIndex * 3;
    const uv = vertexIndex * 2;
    positions[pos] = mesh.vertices[src];
    positions[pos + 1] = mesh.vertices[src + 1];
    positions[pos + 2] = mesh.vertices[src + 2];
    normals[pos] = mesh.vertices[src + 3];
    normals[pos + 1] = mesh.vertices[src + 4];
    normals[pos + 2] = mesh.vertices[src + 5];
    uvs[uv] = mesh.vertices[src + 6];
    uvs[uv + 1] = 1 - mesh.vertices[src + 7];
  }

  return { positions, normals, uvs };
}

function packBinary(parts: Uint8Array[]) {
  const chunks: PackedChunk[] = [];
  let totalByteLength = 0;

  for (const part of parts) {
    totalByteLength = align4(totalByteLength);
    chunks.push({ byteOffset: totalByteLength, byteLength: part.byteLength });
    totalByteLength += part.byteLength;
  }

  const buffer = new Uint8Array(totalByteLength);
  for (let index = 0; index < parts.length; index++) {
    buffer.set(parts[index], chunks[index].byteOffset);
  }

  return { buffer, chunks, totalByteLength };
}

function align4(value: number): number {
  return (value + 3) & ~3;
}

function toBytes(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function computePositionMinMax(positions: Float32Array) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  for (let index = 0; index < positions.length; index += 3) {
    const x = positions[index];
    const y = positions[index + 1];
    const z = positions[index + 2];
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }

  return { min, max };
}

function buildFbxPolygonIndexArray(indices: Uint32Array): Int32Array {
  const polygonVertexIndex = new Int32Array(indices.length);
  for (let index = 0; index < indices.length; index += 3) {
    polygonVertexIndex[index] = indices[index];
    polygonVertexIndex[index + 1] = indices[index + 1];
    polygonVertexIndex[index + 2] = -indices[index + 2] - 1;
  }
  return polygonVertexIndex;
}

function numberArrayToFbx(values: ArrayLike<number>): string {
  const chunks: string[] = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (Number.isInteger(value)) chunks.push(String(value));
    else chunks.push(trimFloat(value));
  }
  return chunks.join(',');
}

function trimFloat(value: number): string {
  const fixed = value.toFixed(6);
  return fixed.includes('.') ? fixed.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1') : fixed;
}

function sanitizeObjectName(value: string): string {
  return value.replace(/[^a-z0-9_-]+/gi, '_');
}

function triggerDownload(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}