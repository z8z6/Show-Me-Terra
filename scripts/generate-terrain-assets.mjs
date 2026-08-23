import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const inputPath = path.join(root, 'public', 'data', 'heightmap.json');
const layoutPath = path.join(root, 'public', 'data', 'terra_layout.json');
const outputDir = path.join(root, 'public', 'terrain');
const source = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const layout = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
const outputSize = 256;

if (!Array.isArray(source.heights) || source.width < 2 || source.depth < 2) {
  throw new Error('heightmap.json 至少需要 2 × 2 个采样点');
}

function sample(u, v) {
  const x = u * (source.width - 1);
  const z = v * (source.depth - 1);
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const x1 = Math.min(x0 + 1, source.width - 1);
  const z1 = Math.min(z0 + 1, source.depth - 1);
  const tx = x - x0;
  const tz = z - z0;
  const top = source.heights[z0][x0] * (1 - tx) + source.heights[z0][x1] * tx;
  const bottom = source.heights[z1][x0] * (1 - tx) + source.heights[z1][x1] * tx;
  return top * (1 - tz) + bottom * tz;
}

const terrainExtent = layout.boundary.reduce(
  (extent, point) => ({
    minX: Math.min(extent.minX, point.x),
    minZ: Math.min(extent.minZ, point.z),
    maxX: Math.max(extent.maxX, point.x),
    maxZ: Math.max(extent.maxZ, point.z),
  }),
  {minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity}
);
const sourceSize = source.map_size ?? source.spacing * Math.max(source.width, source.depth);
const sampleTerrain = (u, v) => {
  const worldX = terrainExtent.minX + u * (terrainExtent.maxX - terrainExtent.minX);
  const worldZ = terrainExtent.minZ + v * (terrainExtent.maxZ - terrainExtent.minZ);
  return sample(
    Math.max(0, Math.min(1, (worldX - source.origin_x) / sourceSize)),
    Math.max(0, Math.min(1, (worldZ - source.origin_z) / sourceSize))
  );
};

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

function writePng(filename, pixel) {
  const rows = [];
  for (let y = 0; y < outputSize; y++) {
    const row = Buffer.alloc(1 + outputSize * 4);
    for (let x = 0; x < outputSize; x++) {
      const rgba = pixel(x, y);
      const offset = 1 + x * 4;
      row[offset] = rgba[0];
      row[offset + 1] = rgba[1];
      row[offset + 2] = rgba[2];
      row[offset + 3] = rgba[3] ?? 255;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(outputSize, 0);
  header.writeUInt32BE(outputSize, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), {level: 9})),
    chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(path.join(outputDir, filename), png);
}

let min = Infinity;
let max = -Infinity;
for (let y = 0; y < outputSize; y++) {
  for (let x = 0; x < outputSize; x++) {
    const height = sampleTerrain(x / (outputSize - 1), y / (outputSize - 1));
    min = Math.min(min, height);
    max = Math.max(max, height);
  }
}
const elevationOffset = Math.min(0, Math.floor(source.statistics.minimum_y));
const palette = [
  [24, 112, 196],
  [252, 249, 238],
  [164, 30, 45]
];
const terrainColor = height => {
  const value = Math.max(0, Math.min(1, (height - min) / Math.max(1, max - min)));
  const scaled = value * (palette.length - 1);
  const index = Math.min(Math.floor(scaled), palette.length - 2);
  const mix = scaled - index;
  return palette[index].map((channel, i) => Math.round(channel * (1 - mix) + palette[index + 1][i] * mix));
};

fs.mkdirSync(outputDir, {recursive: true});
writePng('elevation.png', (x, y) => {
  const encodedHeight = Math.max(
    0,
    Math.min(
      65535,
      Math.round(sampleTerrain(x / 255, y / 255) - elevationOffset)
    )
  );
  return [encodedHeight >> 8, encodedHeight & 255, 0, 255];
});
writePng('terrain-texture.png', (x, y) => {
  const u = x / 255;
  const v = y / 255;
  const height = sampleTerrain(u, v);
  const color = terrainColor(height);
  return [...color, 255];
});

console.log(
  `Generated ${outputSize} × ${outputSize} terrain assets for Terra bounds ` +
  `[${terrainExtent.minX}, ${terrainExtent.minZ}]–[${terrainExtent.maxX}, ${terrainExtent.maxZ}] ` +
  `from ${source.width} × ${source.depth} samples ` +
  `(range ${min.toFixed(1)}–${max.toFixed(1)}, baseline 0, ` +
  `elevation offset ${elevationOffset}).`
);
