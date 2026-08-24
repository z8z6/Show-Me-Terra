import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DeckGL,
  GeoJsonLayer,
  OrbitView,
  OrthographicView,
  SimpleMeshLayer,
  TerrainLayer,
  TextLayer,
  TileLayer,
} from "deck.gl";
import { _TerrainExtension as TerrainExtension } from "@deck.gl/extensions";

const COLORS = [
  [225, 171, 82],
  [73, 166, 149],
  [201, 105, 90],
  [116, 141, 183],
  [163, 120, 166],
  [107, 158, 91],
  [202, 142, 81],
  [86, 142, 157],
  [180, 162, 91],
  [151, 105, 93],
];
const TERRAIN_PALETTE = [
  [24, 112, 196],
  [252, 249, 238],
  [164, 30, 45],
];
const WHITE_TERRAIN_TEXTURE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8////fwAJ+wP9KobjigAAAABJRU5ErkJggg==";
const TERRAIN_GRADIENT = `linear-gradient(90deg, ${TERRAIN_PALETTE.map(
  (color, index) =>
    `rgb(${color.join(" ")}) ${(index / (TERRAIN_PALETTE.length - 1)) * 100}%`,
).join(", ")})`;
const terrainPaletteColor = (height, min, max) => {
  const ratio = Math.max(0, Math.min(1, (height - min) / Math.max(1, max - min)));
  const scaled = ratio * (TERRAIN_PALETTE.length - 1);
  const index = Math.min(Math.floor(scaled), TERRAIN_PALETTE.length - 2);
  const mix = scaled - index;
  return TERRAIN_PALETTE[index].map((channel, channelIndex) =>
    Math.round(
      channel * (1 - mix) + TERRAIN_PALETTE[index + 1][channelIndex] * mix,
    ),
  );
};
const versionedAsset = (path) =>
  `${import.meta.env.BASE_URL}${path}?v=${encodeURIComponent(__BUILD_ID__)}`;
const CITY_DETAIL_CACHE = new Map();
async function readPossiblyGzippedJson(response, path) {
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  if (typeof DecompressionStream === "undefined") {
    throw new Error(`浏览器不支持解压城市详情: ${path}`);
  }
  const stream = new Blob([buffer])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).json();
}
const normalizeCityDetail = (data) => ({
  schema_version: data.schema_version,
  nation_id: data.nation_id,
  city_id: data.city.id,
  regions: data.city.regions.map((region) => {
    const mobileLayers = region.region_layout.mobile_layers;
    const surface = mobileLayers.find((layer) => layer.layer === "surface");
    if (!surface) throw new Error(`Region 缺少 surface 层: ${region.id}`);
    return {
      id: region.id,
      city_id: data.city.id,
      slot_index: region.slot_index,
      mobile_layers: mobileLayers,
      roads: surface.road_graph.edges,
      building_slots: region.building_slots,
    };
  }),
});
async function fetchCityDetail(layout, nationId, cityId, signal) {
  const detailPath = layout.city_detail_files?.[nationId]?.[cityId];
  if (!detailPath) throw new Error(`缺少城市详情文件: ${nationId}/${cityId}`);
  const cached = CITY_DETAIL_CACHE.get(detailPath);
  if (cached) return cached;
  const response = await fetch(versionedAsset(`data/${detailPath}`), { signal });
  if (!response.ok) throw new Error(`${detailPath}: HTTP ${response.status}`);
  const data = await readPossiblyGzippedJson(response, detailPath);
  if (
    data.schema_version !== layout.schema_version ||
    data.nation_id !== nationId ||
    data.city?.id !== cityId
  )
    throw new Error(`城市详情数据不匹配: ${nationId}/${cityId}`);
  const detail = normalizeCityDetail(data);
  CITY_DETAIL_CACHE.set(detailPath, detail);
  return detail;
}
const HOME = { target: [0, 0, 0], zoom: -6.35, minZoom: -8, maxZoom: 2 };
const TERRAIN_HOME = {
  target: [0, 0, 3000],
  zoom: -6.35,
  rotationX: 55,
  rotationOrbit: 25,
  minZoom: -8,
  maxZoom: 2,
};
const SIDE_LAYER_SPACING = 72;
const SIDE_HOME = {
  target: [0, 0, SIDE_LAYER_SPACING * 1.5],
  zoom: -1.5,
  rotationX: 72,
  rotationOrbit: 0,
  minZoom: -8,
  maxZoom: 2,
};
const CITY_LABEL_ZOOM = -5;
const REGION_LABEL_ZOOM = -3.5;
const PLOT_ZOOM = -2.5;
const BUILDING_ZOOM = -2;
const TERRAIN_TARGET_RELIEF = 9000;
const TERRAIN_MIN_SCALE = 8;
const TERRAIN_MAX_SCALE = 64;
const TERRAIN_BOUNDARY_LIFT = 36;
const TERRAIN_BOUNDARY_STEP = 512;
const TERRAIN_LABEL_LIFT = 1200;
const MOBILE_LAYERS = [
  { id: "power", label: "动力" },
  { id: "support", label: "支持" },
  { id: "life", label: "生活" },
  { id: "surface", label: "地表" },
];
const FORMATION_REVEAL_DURATION = 14000;
const FORMATION_NATIONS_END = 0.2;
const FORMATION_CITIES_END = 0.45;
const DEVICE_PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, 1.5);
const FONT = {
  fontFamily: '"Noto Sans SC", "Microsoft YaHei", sans-serif',
  fontSettings: { sdf: true, fontSize: 64, buffer: 4 },
  getTextAnchor: "middle",
  getAlignmentBaseline: "center",
  characterSet: "auto",
};
const ORTHO_VIEW = new OrthographicView({ id: "ortho", flipY: false });
const ORBIT_VIEW = new OrbitView({ id: "terrain", orbitAxis: "Z" });
const CONTROLLER = {
  dragPan: true,
  dragRotate: false,
  scrollZoom: { smooth: false, speed: 0.006 },
  doubleClickZoom: false,
  touchZoom: true,
  touchRotate: false,
};
const GET_CURSOR = ({ isDragging, isHovering }) =>
  isDragging ? "grabbing" : isHovering ? "pointer" : "grab";
const xy = ({ x, z }) => [x, -z];
const ring = (points) => [...points.map(xy), xy(points[0])];
const chunkAreaCorners = ({
  min_chunk_x,
  min_chunk_z,
  width_chunks,
  length_chunks,
}) => {
  const minX = min_chunk_x * 16;
  const minZ = min_chunk_z * 16;
  const maxX = minX + width_chunks * 16;
  const maxZ = minZ + length_chunks * 16;
  return [
    { x: minX, z: minZ },
    { x: maxX, z: minZ },
    { x: maxX, z: maxZ },
    { x: minX, z: maxZ },
  ];
};
const narrowRoadCorners = (
  { min_chunk_x, min_chunk_z, width_chunks, length_chunks },
  ratio = 0.36,
) => {
  let minX = min_chunk_x * 16;
  let minZ = min_chunk_z * 16;
  let maxX = minX + width_chunks * 16;
  let maxZ = minZ + length_chunks * 16;
  const width = maxX - minX;
  const depth = maxZ - minZ;
  if (width > depth) {
    const inset = (depth * (1 - ratio)) / 2;
    minZ += inset;
    maxZ -= inset;
  } else if (depth > width) {
    const inset = (width * (1 - ratio)) / 2;
    minX += inset;
    maxX -= inset;
  } else {
    const insetX = (width * (1 - ratio)) / 2;
    const insetZ = (depth * (1 - ratio)) / 2;
    minX += insetX;
    maxX -= insetX;
    minZ += insetZ;
    maxZ -= insetZ;
  }
  return [
    { x: minX, z: minZ },
    { x: maxX, z: minZ },
    { x: maxX, z: maxZ },
    { x: minX, z: maxZ },
  ];
};
const ROAD_NODE_CACHE = new WeakMap();
const roadNodes = (roadGraph) => {
  let nodes = ROAD_NODE_CACHE.get(roadGraph);
  if (!nodes) {
    nodes = new Map(roadGraph.nodes.map((node) => [node.id, node]));
    ROAD_NODE_CACHE.set(roadGraph, nodes);
  }
  return nodes;
};
const roadEdgeCorners = (edge, roadGraph, ratio = 0.36) => {
  const nodes = roadNodes(roadGraph);
  const from = nodes.get(edge.from_node_id)?.point;
  const to = nodes.get(edge.to_node_id)?.point;
  if (!from || !to) return narrowRoadCorners(edge.chunk_area, ratio);
  const fromX = (from.chunk_x + 0.5) * 16;
  const fromZ = (from.chunk_z + 0.5) * 16;
  const toX = (to.chunk_x + 0.5) * 16;
  const toZ = (to.chunk_z + 0.5) * 16;
  const halfWidth =
    Math.min(edge.chunk_area.width_chunks, edge.chunk_area.length_chunks) *
    8 *
    ratio;
  const horizontal = Math.abs(toX - fromX) >= Math.abs(toZ - fromZ);
  const minX = horizontal ? Math.min(fromX, toX) : fromX - halfWidth;
  const maxX = horizontal ? Math.max(fromX, toX) : fromX + halfWidth;
  const minZ = horizontal ? fromZ - halfWidth : Math.min(fromZ, toZ);
  const maxZ = horizontal ? fromZ + halfWidth : Math.max(fromZ, toZ);
  return [
    { x: minX, z: minZ },
    { x: maxX, z: minZ },
    { x: maxX, z: maxZ },
    { x: minX, z: maxZ },
  ];
};
const roadJunctionParts = (chunkX, chunkZ, halfWidth, connectionMask) => {
  const centerX = (chunkX + 0.5) * 16;
  const centerZ = (chunkZ + 0.5) * 16;
  const minX = chunkX * 16;
  const minZ = chunkZ * 16;
  const maxX = minX + 16;
  const maxZ = minZ + 16;
  const rectangle = (left, top, right, bottom) => [
    { x: left, z: top },
    { x: right, z: top },
    { x: right, z: bottom },
    { x: left, z: bottom },
  ];
  const parts = [
    rectangle(
      centerX - halfWidth,
      centerZ - halfWidth,
      centerX + halfWidth,
      centerZ + halfWidth,
    ),
  ];
  if (connectionMask & 1)
    parts.push(
      rectangle(centerX - halfWidth, minZ, centerX + halfWidth, centerZ),
    );
  if (connectionMask & 2)
    parts.push(
      rectangle(centerX, centerZ - halfWidth, maxX, centerZ + halfWidth),
    );
  if (connectionMask & 4)
    parts.push(
      rectangle(centerX - halfWidth, centerZ, centerX + halfWidth, maxZ),
    );
  if (connectionMask & 8)
    parts.push(
      rectangle(minX, centerZ - halfWidth, centerX, centerZ + halfWidth),
    );
  return parts;
};
const roadJunctionPatches = (layer, ratio = 0.36) => {
  const roadGraph = layer.road_graph;
  const nodes = roadNodes(roadGraph);
  const incidents = new Map();
  roadGraph.edges.forEach((edge) => {
    for (const [nodeId, neighborId] of [
      [edge.from_node_id, edge.to_node_id],
      [edge.to_node_id, edge.from_node_id],
    ]) {
      const connected = incidents.get(nodeId) ?? [];
      connected.push({ edge, neighborId });
      incidents.set(nodeId, connected);
    }
  });
  if (Array.isArray(layer.road_junctions)) {
    const nodeByChunk = new Map(
      roadGraph.nodes.map((node) => [
        `${node.point.chunk_x}:${node.point.chunk_z}`,
        node.id,
      ]),
    );
    return layer.road_junctions.map((junction) => {
      const nodeId = nodeByChunk.get(`${junction.chunk_x}:${junction.chunk_z}`);
      const connected = incidents.get(nodeId) ?? [];
      const widestEdge = Math.max(
        ...connected.map(({ edge }) => edge.width_chunks ?? 1),
        1,
      );
      const halfWidth = widestEdge * 8 * ratio;
      return {
        nodeId: nodeId ?? `${junction.chunk_x}-${junction.chunk_z}`,
        type: junction.type,
        rotation: junction.rotation,
        connectionMask: junction.connection_mask,
        roadClass: connected.some(({ edge }) => edge.road_class === "primary")
          ? "primary"
          : "service",
        parts: roadJunctionParts(
          junction.chunk_x,
          junction.chunk_z,
          halfWidth,
          junction.connection_mask,
        ),
      };
    });
  }
  return roadGraph.nodes.flatMap((node) => {
    const connected = incidents.get(node.id) ?? [];
    const directions = new Set();
    connected.forEach(({ neighborId }) => {
      const neighbor = nodes.get(neighborId)?.point;
      if (!neighbor) return;
      const dx = neighbor.chunk_x - node.point.chunk_x;
      const dz = neighbor.chunk_z - node.point.chunk_z;
      directions.add(
        Math.abs(dx) >= Math.abs(dz)
          ? dx < 0
            ? "west"
            : "east"
          : dz < 0
            ? "north"
            : "south",
      );
    });
    const turns =
      (directions.has("west") || directions.has("east")) &&
      (directions.has("north") || directions.has("south"));
    if (!turns) return [];
    const widestEdge = Math.max(
      ...connected.map(({ edge }) =>
        Math.min(edge.chunk_area.width_chunks, edge.chunk_area.length_chunks),
      ),
      1,
    );
    const halfWidth = widestEdge * 8 * ratio;
    const centerX = (node.point.chunk_x + 0.5) * 16;
    const centerZ = (node.point.chunk_z + 0.5) * 16;
    return [
      {
        nodeId: node.id,
        roadClass: connected.some(({ edge }) => edge.road_class === "primary")
          ? "primary"
          : "service",
        parts: [[
          { x: centerX - halfWidth, z: centerZ - halfWidth },
          { x: centerX + halfWidth, z: centerZ - halfWidth },
          { x: centerX + halfWidth, z: centerZ + halfWidth },
          { x: centerX - halfWidth, z: centerZ + halfWidth },
        ]],
      },
    ];
  });
};
const stairChunkArea = ({ chunk_x, chunk_z }) => ({
  min_chunk_x: chunk_x,
  min_chunk_z: chunk_z,
  width_chunks: 1,
  length_chunks: 1,
});
const stairPattern = ({ chunk_x, chunk_z }) => {
  const minX = chunk_x * 16;
  const minY = -(chunk_z * 16);
  return [
    [minX + 2, minY - 3],
    [minX + 6, minY - 3],
    [minX + 6, minY - 7],
    [minX + 10, minY - 7],
    [minX + 10, minY - 11],
    [minX + 14, minY - 11],
    [minX + 14, minY - 14],
  ];
};
const number = (value) => Math.round(value).toLocaleString("zh-CN");
const pointInBoundary = (target, boundary) => {
  const x = target[0];
  const z = -target[1];
  let inside = false;
  for (let index = 0, previous = boundary.length - 1; index < boundary.length; previous = index++) {
    const a = boundary[index];
    const b = boundary[previous];
    if (
      (a.z > z) !== (b.z > z) &&
      x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x
    )
      inside = !inside;
  }
  return inside;
};
const locationAtTarget = (layout, target) => {
  const nation = layout?.nations.find((item) =>
    pointInBoundary(target, item.boundary),
  );
  const city = nation?.cities.find((item) =>
    pointInBoundary(target, item.boundary),
  );
  return { nationId: nation?.id ?? null, cityId: city?.id ?? null };
};
const buildingColor = (id) => {
  let hash = 0;
  for (let index = 0; index < id.length; index++)
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  const hue = hash % 360;
  const saturation = 0.5 + ((hash >>> 9) % 18) / 100;
  const lightness = 0.52 + ((hash >>> 17) % 12) / 100;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const section = hue / 60;
  const second = chroma * (1 - Math.abs((section % 2) - 1));
  const [red, green, blue] =
    section < 1
      ? [chroma, second, 0]
      : section < 2
        ? [second, chroma, 0]
        : section < 3
          ? [0, chroma, second]
          : section < 4
            ? [0, second, chroma]
            : section < 5
              ? [second, 0, chroma]
              : [chroma, 0, second];
  const match = lightness - chroma / 2;
  return [red, green, blue].map((channel) =>
    Math.round((channel + match) * 255),
  );
};
const getLabelMode = (zoom) =>
  zoom >= BUILDING_ZOOM
    ? "building"
    : zoom >= PLOT_ZOOM
      ? "plot"
      : zoom >= REGION_LABEL_ZOOM
        ? "region"
    : zoom >= CITY_LABEL_ZOOM
      ? "city"
      : "nation";
const POLYGON_CENTER_CACHE = new WeakMap();
const MAP_DATA_CACHE = new WeakMap();
const BUILDING_DATA_CACHE = new WeakMap();
const REGION_ROAD_DATA_CACHE = new WeakMap();
const STAIR_DATA_CACHE = new WeakMap();
const SIDE_STRUCTURE_CACHE = new WeakMap();
const UNIT_BOX_MESH = {
  attributes: {
    POSITION: {
      size: 3,
      value: new Float32Array([
        -0.5, -0.5, -0.5,
         0.5, -0.5, -0.5,
         0.5,  0.5, -0.5,
        -0.5,  0.5, -0.5,
        -0.5, -0.5,  0.5,
         0.5, -0.5,  0.5,
         0.5,  0.5,  0.5,
        -0.5,  0.5,  0.5,
      ]),
    },
  },
  indices: {
    size: 1,
    value: new Uint16Array([
      0, 2, 1, 0, 3, 2,
      4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4,
      1, 2, 6, 1, 6, 5,
      2, 3, 7, 2, 7, 6,
      3, 0, 4, 3, 4, 7,
    ]),
  },
};
function polygonCenter(points) {
  if (!points?.length) return { x: 0, z: 0 };
  const cached = POLYGON_CENTER_CACHE.get(points);
  if (cached) return cached;
  let twiceArea = 0,
    x = 0,
    z = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const cross = points[j].x * points[i].z - points[i].x * points[j].z;
    twiceArea += cross;
    x += (points[j].x + points[i].x) * cross;
    z += (points[j].z + points[i].z) * cross;
  }
  if (Math.abs(twiceArea) < 1e-8) {
    const center = points.reduce(
      (sum, p) => ({
        x: sum.x + p.x / points.length,
        z: sum.z + p.z / points.length,
      }),
      { x: 0, z: 0 },
    );
    POLYGON_CENTER_CACHE.set(points, center);
    return center;
  }
  const center = { x: x / (3 * twiceArea), z: z / (3 * twiceArea) };
  POLYGON_CENTER_CACHE.set(points, center);
  return center;
}

function createTerrainBoundaries(layout) {
  const features = [
    {
      type: "Feature",
      properties: { kind: "terra" },
      geometry: { type: "LineString", coordinates: terrainRing(layout.boundary) },
    },
  ];
  layout.nations.filter((nation) => !nation.underground).forEach((nation) => {
    const addBoundary = (boundary, kind) => {
      if (!boundary?.length) return;
      features.push({
        type: "Feature",
        properties: { kind },
        geometry: { type: "LineString", coordinates: terrainRing(boundary) },
      });
    };

    addBoundary(nation.boundary, "nation");
    nation.cities.forEach((city) => {
      addBoundary(city.boundary, "city");
      city.regions.forEach((region) => {
        addBoundary(region.boundary, "region");
      });
    });
  });
  return { type: "FeatureCollection", features };
}

function terrainRing(points) {
  const positions = [];
  for (let index = 0; index < points.length; index++) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const distance = Math.hypot(end.x - start.x, end.z - start.z);
    const steps = Math.max(1, Math.ceil(distance / TERRAIN_BOUNDARY_STEP));
    for (let step = 0; step < steps; step++) {
      const ratio = step / steps;
      positions.push([
        start.x + (end.x - start.x) * ratio,
        -(start.z + (end.z - start.z) * ratio),
        TERRAIN_BOUNDARY_LIFT,
      ]);
    }
  }
  positions.push([...positions[0]]);
  return positions;
}

function getTerrainBounds(boundary) {
  const positions = boundary.map(xy);
  const xs = positions.map((position) => position[0]);
  const ys = positions.map((position) => position[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function sampleTerrainHeight(heightmap, worldX, worldZ) {
  const sourceSize =
    heightmap.map_size ??
    heightmap.spacing * Math.max(heightmap.width, heightmap.depth);
  const u = Math.max(0, Math.min(1, (worldX - heightmap.origin_x) / sourceSize));
  const v = Math.max(0, Math.min(1, (worldZ - heightmap.origin_z) / sourceSize));
  const x = u * (heightmap.width - 1);
  const z = v * (heightmap.depth - 1);
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const x1 = Math.min(x0 + 1, heightmap.width - 1);
  const z1 = Math.min(z0 + 1, heightmap.depth - 1);
  const tx = x - x0;
  const tz = z - z0;
  const top =
    heightmap.heights[z0][x0] * (1 - tx) +
    heightmap.heights[z0][x1] * tx;
  const bottom =
    heightmap.heights[z1][x0] * (1 - tx) +
    heightmap.heights[z1][x1] * tx;
  return top * (1 - tz) + bottom * tz;
}

function calculateTerrainMetrics(boundary, heightmap) {
  const bounds = boundary.reduce(
    (result, point) => ({
      minX: Math.min(result.minX, point.x),
      minZ: Math.min(result.minZ, point.z),
      maxX: Math.max(result.maxX, point.x),
      maxZ: Math.max(result.maxZ, point.z),
    }),
    { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity },
  );
  let min = Infinity;
  let max = -Infinity;
  const sampleCount = 256;
  for (let row = 0; row < sampleCount; row++) {
    const z = bounds.minZ +
      (row / (sampleCount - 1)) * (bounds.maxZ - bounds.minZ);
    for (let column = 0; column < sampleCount; column++) {
      const x = bounds.minX +
        (column / (sampleCount - 1)) * (bounds.maxX - bounds.minX);
      const height = sampleTerrainHeight(heightmap, x, z);
      min = Math.min(min, height);
      max = Math.max(max, height);
    }
  }
  const range = Math.max(1, max - min);
  const scale = Math.max(
    TERRAIN_MIN_SCALE,
    Math.min(TERRAIN_MAX_SCALE, TERRAIN_TARGET_RELIEF / range),
  );
  return { min, max, range, scale };
}

function createTerrainBaseMesh(boundary, heightmap, metrics) {
  const top = boundary.map((point) => [
    point.x,
    -point.z,
    Math.max(0, sampleTerrainHeight(heightmap, point.x, point.z)) *
      metrics.scale,
  ]);
  const positions = [
    ...top.flat(),
    ...top.flatMap(([x, y]) => [x, y, 0]),
  ];
  const indices = [];
  const count = top.length;

  for (let index = 0; index < count; index++) {
    const next = (index + 1) % count;
    indices.push(index, next, count + next, index, count + next, count + index);
  }
  for (let index = 1; index < count - 1; index++) {
    indices.push(count, count + index + 1, count + index);
  }

  return {
    attributes: {
      POSITION: { size: 3, value: new Float32Array(positions) },
    },
    indices: { size: 1, value: new Uint32Array(indices) },
  };
}

function getRegionGroundY(region, heightmap) {
  const plot = region.mobile_plot;
  const samplePoints = [plot.center, ...(plot.corners ?? region.boundary ?? [])];
  return Math.max(
    ...samplePoints.map((point) =>
      sampleTerrainHeight(heightmap, point.x, point.z),
    ),
  );
}

function createTerrainStructures(layout, nationDetail, metrics, heightmap) {
  const cityById = new Map();
  const regionGroundByKey = new Map();
  const foundations = layout.nations
    .filter((nation) => !nation.underground)
    .flatMap((nation) => {
      return nation.cities.flatMap((city) => {
        cityById.set(city.id, city);
        return city.regions.flatMap((region) => {
          const groundY = getRegionGroundY(region, heightmap);
          if (groundY < 0) return [];
          const surface = groundY * metrics.scale;
          const height = 48 * metrics.scale;
          regionGroundByKey.set(`${city.id}:${region.slot_index}`, groundY);
          return [
            {
              position: [
                region.mobile_plot.center.x,
                -region.mobile_plot.center.z,
                surface + height / 2,
              ],
              scale: [
                region.mobile_plot.half_size_x * 2,
                region.mobile_plot.half_size_z * 2,
                height,
              ],
              color: [
                ...terrainPaletteColor(
                  groundY + 24,
                  metrics.min,
                  metrics.max,
                ),
                255,
              ],
            },
          ];
        });
      });
    });

  const buildings = nationDetail
    ? nationDetail.regions.flatMap((region) => {
        const city = cityById.get(region.city_id);
        if (!city || city.terrain_profile?.ground_y < 0) return [];
        const groundY =
          regionGroundByKey.get(`${region.city_id}:${region.slot_index}`) ??
          city.terrain_profile?.ground_y ??
          80;
        if (groundY < 0) return [];
        const surface = groundY * metrics.scale;
        const height = 16 * metrics.scale;
        return region.building_slots.map((slot) => {
          const area = slot.chunk_area;
          const width = area.width_chunks * 16;
          const depth = area.length_chunks * 16;
          return {
            position: [
              area.min_chunk_x * 16 + width / 2,
              -(area.min_chunk_z * 16 + depth / 2),
              surface + 48 * metrics.scale + height / 2,
            ],
            scale: [width, depth, height],
            color: [
              ...terrainPaletteColor(
                groundY + 56,
                metrics.min,
                metrics.max,
              ),
              255,
            ],
          };
        });
      })
    : [];

  return { foundations, buildings };
}

function createSideStructures(nationDetail, target) {
  if (!nationDetail) return { blocks: [], roads: [], stairs: [] };
  const blockX = target[0] / 16;
  const blockZ = -target[1] / 16;
  const contains = (area) =>
    blockX >= area.min_chunk_x &&
    blockX <= area.min_chunk_x + area.width_chunks &&
    blockZ >= area.min_chunk_z &&
    blockZ <= area.min_chunk_z + area.length_chunks;
  const distance = (region) => {
    const area = region.mobile_layers[0].chunk_area;
    const dx = blockX - (area.min_chunk_x + area.width_chunks / 2);
    const dz = blockZ - (area.min_chunk_z + area.length_chunks / 2);
    return dx * dx + dz * dz;
  };
  const selectedRegion =
    nationDetail.regions.find((region) =>
      contains(region.mobile_layers[0].chunk_area),
    ) ?? nationDetail.regions.reduce((best, region) =>
      !best || distance(region) < distance(best) ? region : best,
    null);
  if (!selectedRegion) return { blocks: [], roads: [], stairs: [] };
  const cacheKey = `${selectedRegion.city_id}:${selectedRegion.slot_index}`;
  const detailCache = SIDE_STRUCTURE_CACHE.get(nationDetail) ?? new Map();
  const cached = detailCache.get(cacheKey);
  if (cached) return cached;
  const makeBox = (area, elevation, height, color) => {
    const width = area.width_chunks * 16;
    const depth = area.length_chunks * 16;
    return {
      position: [
        area.min_chunk_x * 16 + width / 2,
        -(area.min_chunk_z * 16 + depth / 2),
        elevation + height / 2,
      ],
      scale: [width, depth, height],
      color,
    };
  };
  const makeRoadBox = (area, elevation, height, color, cornersOverride) => {
    const corners = cornersOverride ?? narrowRoadCorners(area);
    const minX = Math.min(...corners.map((point) => point.x));
    const maxX = Math.max(...corners.map((point) => point.x));
    const minZ = Math.min(...corners.map((point) => point.z));
    const maxZ = Math.max(...corners.map((point) => point.z));
    return {
      position: [
        (minX + maxX) / 2,
        -(minZ + maxZ) / 2,
        elevation + height / 2,
      ],
      scale: [maxX - minX, maxZ - minZ, height],
      color,
    };
  };
  const makeStairColumn = (stair) => {
    const height = SIDE_LAYER_SPACING * (MOBILE_LAYERS.length - 1) + 15;
    return {
      position: [
        stair.chunk_x * 16 + 8,
        -(stair.chunk_z * 16 + 8),
        height / 2,
      ],
      scale: [8, 8, height],
      color: [248, 203, 111, 255],
    };
  };
  const blocks = [];
  const roads = [];
  const stairs = [];
  [selectedRegion].forEach((region) => {
    region.mobile_layers.forEach((layer) => {
      const elevation =
        MOBILE_LAYERS.findIndex((item) => item.id === layer.layer) *
        SIDE_LAYER_SPACING;
      const buildingAreas =
        layer.layer === "surface"
          ? region.building_slots.map((slot) => ({
              area: slot.chunk_area,
              buildingId: slot.building_id,
            }))
          : layer.parcels.map((parcel) => ({
              area: parcel.buildable_area ?? parcel.area,
              buildingId: layer.building_id,
            }));
      buildingAreas.forEach(({ area, buildingId }) =>
        blocks.push(
          makeBox(area, elevation, 12, [...buildingColor(buildingId), 220]),
        ),
      );
      layer.road_graph.edges.forEach((road) =>
        roads.push(
          makeRoadBox(
            road.chunk_area,
            elevation + 12,
            3,
            [211, 205, 183, 235],
            roadEdgeCorners(road, layer.road_graph),
          ),
        ),
      );
      roadJunctionPatches(layer).forEach((junction) =>
        junction.parts.forEach((part) =>
          roads.push(
            makeRoadBox(
              layer.chunk_area,
              elevation + 12,
              3,
              [211, 205, 183, 235],
              part,
            ),
          ),
        ),
      );
    });
    region.mobile_layers[0].stair_chunks.forEach((stair) =>
      stairs.push(makeStairColumn(stair)),
    );
  });
  const structures = { blocks, roads, stairs };
  detailCache.set(cacheKey, structures);
  SIDE_STRUCTURE_CACHE.set(nationDetail, detailCache);
  return structures;
}

function useTerraData() {
  const [state, setState] = useState({ data: null, heightmap: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    const loadJson = (path) =>
      fetch(versionedAsset(path), { signal: controller.signal }).then(
        (response) => {
          if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
          return response.json();
        },
      );
    Promise.all([
      loadJson("data/terra_layout.json"),
      loadJson("data/heightmap.json"),
    ])
      .then(([data, heightmap]) => {
        if (data.schema_version !== 16)
          throw new Error(`需要 Terra Layout v16，实际为 v${data.schema_version}`);
        setState({ data, heightmap, error: null });
      })
      .catch((error) => {
        if (error.name !== "AbortError")
          setState({ data: null, heightmap: null, error });
      });
    return () => controller.abort();
  }, []);
  return state;
}

function createLayers(
  layout,
  visibleNations,
  hovered,
  onHover,
  onRegionDoubleClick,
  labelMode,
  showLabels,
  formationProgress,
  nationDetail,
  selectedMobileLayer,
) {
  let mapData = MAP_DATA_CACHE.get(visibleNations);
  if (!mapData) {
  const color = (nation) =>
    COLORS[layout.nations.indexOf(nation) % COLORS.length];
  const nations = visibleNations.map((nation) => ({
    type: "Feature",
    properties: {
      ...nation,
      kind: "nation",
      nationId: nation.id,
      color: color(nation),
      cityCount: nation.cities.length,
      cities: undefined,
      boundary: undefined,
    },
    geometry: { type: "Polygon", coordinates: [ring(nation.boundary)] },
  }));
  const cities = visibleNations.flatMap((nation) =>
    nation.cities.map((city) => ({
      type: "Feature",
      properties: {
        ...city,
        kind: "city",
        nationId: nation.id,
        nationName: nation.zh_cn_name,
        color: color(nation),
        boundary: undefined,
        regions: undefined,
      },
      geometry: { type: "Polygon", coordinates: [ring(city.boundary)] },
    })),
  );
  const regions = visibleNations.flatMap((nation) =>
    nation.cities.flatMap((city) =>
      city.regions.map((region) => ({
        type: "Feature",
        properties: {
          ...region,
          kind: "region",
          regionKey: `${city.id}:${region.slot_index}`,
          cityId: city.id,
          cityName: city.zh_cn_name,
          nationId: nation.id,
          nationName: nation.zh_cn_name,
          color: color(nation),
          formationOrder: (region.slot_index + 1) / city.regions.length,
          boundary: undefined,
        },
        geometry: { type: "Polygon", coordinates: [ring(region.boundary)] },
      })),
    ),
  );
  const cityLabels = visibleNations.flatMap((nation) => nation.cities);
  const roads = visibleNations.flatMap((nation) =>
    nation.cities.flatMap((city) =>
      city.roads.map((road) => ({
        type: "Feature",
        properties: {
          kind: "road",
          roadKey: `${city.id}:${road.from_plot_id}:${road.to_plot_id}`,
          cityId: city.id,
          fromPlotId: road.from_plot_id,
          toPlotId: road.to_plot_id,
          formationOrder:
            (Math.max(road.from_plot_id, road.to_plot_id) + 1) /
            city.regions.length,
        },
        geometry: {
          type: "Polygon",
          coordinates: [ring(narrowRoadCorners(road.chunk_area, 0.42))],
        },
      })),
    ),
  );
    mapData = {
      nations,
      cities,
      regions,
      cityLabels,
      roads,
    };
    MAP_DATA_CACHE.set(visibleNations, mapData);
  }
  const {
    nations,
    cities,
    regions,
    cityLabels,
    roads,
  } = mapData;
  const formationActive = formationProgress !== null;
  const phaseProgress = (start, end) =>
    Math.max(0, Math.min(1, (formationProgress - start) / (end - start)));
  const nationProgress = formationActive
    ? phaseProgress(0, FORMATION_NATIONS_END)
    : 1;
  const cityProgress = formationActive
    ? phaseProgress(FORMATION_NATIONS_END, FORMATION_CITIES_END)
    : 1;
  const regionProgress = formationActive
    ? phaseProgress(FORMATION_CITIES_END, 1)
    : 1;
  const formedNations = formationActive
    ? nations.slice(0, Math.ceil(nations.length * nationProgress))
    : nations;
  const formedCities = formationActive
    ? cities.slice(0, Math.ceil(cities.length * cityProgress))
    : cities;
  const formedRegions = formationActive
    ? regions.filter(
        (feature) => feature.properties.formationOrder <= regionProgress,
      )
    : regions;
  const formedRoads = formationActive
    ? roads.filter(
        (feature) => feature.properties.formationOrder <= regionProgress,
      )
    : roads;
  const formedNationLabels = formationActive
    ? visibleNations.slice(
        0,
        Math.ceil(visibleNations.length * nationProgress),
      )
    : visibleNations;
  const formedCityLabels = formationActive
    ? cityLabels.slice(0, Math.ceil(cityLabels.length * cityProgress))
    : cityLabels;
  const showRegions = formationActive
    ? regionProgress > 0
    : labelMode !== "nation" && labelMode !== "city";
  const showPlots = formationActive
    ? regionProgress > 0
    : labelMode === "plot" || labelMode === "building";
  const showRegionRoads =
    Boolean(nationDetail) &&
    (labelMode === "plot" || labelMode === "building");
  let regionRoads = [];
  if (showRegionRoads) {
    const cachedRoadLayers = REGION_ROAD_DATA_CACHE.get(nationDetail);
    regionRoads = cachedRoadLayers?.get(selectedMobileLayer);
    if (!regionRoads) {
      regionRoads = nationDetail.regions.flatMap((region) => {
        const layer = region.mobile_layers.find(
          (item) => item.layer === selectedMobileLayer,
        );
        const edges = layer.road_graph.edges.map((road) => ({
          type: "Feature",
          properties: {
            kind: "region-road",
            cityId: region.city_id,
            regionId: region.id,
            roadId: road.id,
            roadClass: road.road_class,
          },
          geometry: {
            type: "Polygon",
            coordinates: [ring(roadEdgeCorners(road, layer.road_graph))],
          },
        }));
        const junctions = roadJunctionPatches(layer).map(
          (junction) => ({
            type: "Feature",
            properties: {
              kind: "region-road-junction",
              cityId: region.city_id,
              regionId: region.id,
              roadId: `junction-${junction.nodeId}`,
              roadClass: junction.roadClass,
              roadShape: junction.type,
              rotation: junction.rotation,
              connectionMask: junction.connectionMask,
            },
            geometry: {
              type: "MultiPolygon",
              coordinates: junction.parts.map((part) => [ring(part)]),
            },
          }),
        );
        return [...edges, ...junctions];
      });
      const roadLayers = cachedRoadLayers ?? new Map();
      roadLayers.set(selectedMobileLayer, regionRoads);
      REGION_ROAD_DATA_CACHE.set(nationDetail, roadLayers);
    }
  }
  let buildingSlots = [];
  if (nationDetail && labelMode === "building") {
    const cachedBuildingLayers = BUILDING_DATA_CACHE.get(nationDetail);
    buildingSlots = cachedBuildingLayers?.get(selectedMobileLayer);
    if (!buildingSlots) {
      buildingSlots = nationDetail.regions.flatMap((region) => {
        const layer = region.mobile_layers.find(
          (item) => item.layer === selectedMobileLayer,
        );
        const parcels =
          selectedMobileLayer === "surface"
            ? region.building_slots
            : layer.parcels.map((parcel) => ({
                ...parcel,
                building_id: layer.building_id,
                chunk_area: parcel.buildable_area ?? parcel.area,
              }));
        return parcels.map((slot) => ({
          type: "Feature",
          properties: {
            ...slot,
            cityId: region.city_id,
            regionId: region.id,
          },
          geometry: {
            type: "Polygon",
            coordinates: [ring(chunkAreaCorners(slot.chunk_area))],
          },
        }));
      });
      const buildingLayers = cachedBuildingLayers ?? new Map();
      buildingLayers.set(selectedMobileLayer, buildingSlots);
      BUILDING_DATA_CACHE.set(nationDetail, buildingLayers);
    }
  }
  let stairChunks = [];
  if (showRegionRoads) {
    const cachedStairLayers = STAIR_DATA_CACHE.get(nationDetail);
    stairChunks = cachedStairLayers?.get(selectedMobileLayer);
    if (!stairChunks) {
      stairChunks = nationDetail.regions.flatMap((region) => {
        const layer = region.mobile_layers.find(
          (item) => item.layer === selectedMobileLayer,
        );
        return layer.stair_chunks.map((stair) => ({ region, stair }));
      });
      const stairLayers = cachedStairLayers ?? new Map();
      stairLayers.set(selectedMobileLayer, stairChunks);
      STAIR_DATA_CACHE.set(nationDetail, stairLayers);
    }
  }

  return [
    new TileLayer({
      id: "minecraft-tile-grid",
      extent: [-40000, -25000, 40000, 25000],
      minZoom: 0,
      maxZoom: 8,
      tileSize: 8192,
      maxCacheSize: 128,
      getTileData: (tile) => tile,
      renderSubLayers: (props) => {
        const b = props.tile.bbox,
          left = "west" in b ? b.west : b.left,
          right = "east" in b ? b.east : b.right,
          bottom = "south" in b ? b.south : b.bottom,
          top = "north" in b ? b.north : b.top;
        const minX = Math.min(left, right),
          maxX = Math.max(left, right),
          minY = Math.min(bottom, top),
          maxY = Math.max(bottom, top);
        const coordinates = [
          [
            [minX, minY],
            [maxX, minY],
            [maxX, maxY],
            [minX, maxY],
            [minX, minY],
          ],
        ];
        const features = [
          { type: "Feature", geometry: { type: "Polygon", coordinates } },
        ];
        // Minecraft 的一个 Chunk 是 16 × 16 方块；远景使用稀疏网格，
        // 放大到地块层级后显示完整 Chunk 单位网格。
        const gridStep =
          labelMode === "plot" || labelMode === "building" ? 16 : 1024;
        for (
          let x = Math.ceil(minX / gridStep) * gridStep;
          x < maxX;
          x += gridStep
        ) {
          if (x > minX)
            features.push({
              type: "Feature",
              geometry: { type: "LineString", coordinates: [[x, minY], [x, maxY]] },
            });
        }
        for (
          let y = Math.ceil(minY / gridStep) * gridStep;
          y < maxY;
          y += gridStep
        ) {
          if (y > minY)
            features.push({
              type: "Feature",
              geometry: { type: "LineString", coordinates: [[minX, y], [maxX, y]] },
            });
        }
        return new GeoJsonLayer(props, {
          id: `${props.id}-geojson`,
          data: { type: "FeatureCollection", features },
          filled: true,
          stroked: true,
          getFillColor: [10, 18, 18, 70],
          getLineColor: [113, 151, 139, 28],
          getLineWidth: 1,
          lineWidthUnits: "pixels",
        });
      },
    }),
    new GeoJsonLayer({
      id: "world-boundary",
      data: {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ring(layout.boundary)] },
      },
      filled: false,
      stroked: true,
      getLineColor: [178, 199, 187, 110],
      getLineWidth: 1,
      lineWidthUnits: "pixels",
    }),
    new GeoJsonLayer({
      id: "nations",
      data: { type: "FeatureCollection", features: formedNations },
      pickable: labelMode === "nation",
      filled: true,
      stroked: true,
      getFillColor: (f) => [
        ...f.properties.color,
        hovered?.kind === "nation" && hovered.id === f.properties.id
          ? 105
          : 47,
      ],
      getLineColor: (f) =>
        f.properties.underground
          ? [183, 148, 199, 220]
          : [...f.properties.color, 215],
      getLineWidth: (f) =>
        hovered?.kind === "nation" && hovered.id === f.properties.id ? 3 : 1.3,
      lineWidthUnits: "pixels",
      lineWidthMinPixels: 1,
      onHover: (info) => onHover(info.object?.properties),
    }),
    new GeoJsonLayer({
      id: "cities",
      data: { type: "FeatureCollection", features: formedCities },
      pickable: labelMode === "city",
      filled: true,
      stroked: true,
      getFillColor: (f) =>
        hovered?.kind === "city" && hovered.id === f.properties.id
          ? [248, 224, 165, 145]
          : [218, 224, 210, 62],
      getLineColor: (f) => [...f.properties.color, 225],
      getLineWidth: (f) =>
        hovered?.kind === "city" && hovered.id === f.properties.id
          ? 2.5
          : 1,
      lineWidthUnits: "pixels",
      lineWidthMinPixels: 1,
      onHover: (info) => onHover(info.object?.properties),
    }),
    new GeoJsonLayer({
      id: "city-regions",
      visible: showRegions,
      data: { type: "FeatureCollection", features: formedRegions },
      pickable:
        labelMode === "region" ||
        labelMode === "plot" ||
        labelMode === "building",
      filled: true,
      stroked: true,
      getFillColor: (f) =>
        labelMode !== "building" &&
        hovered?.kind === "region" &&
        hovered.regionKey === f.properties.regionKey
          ? [244, 213, 143, 125]
          : [12, 20, 19, 45],
      getLineColor: (f) => [...f.properties.color, 185],
      getLineWidth: (f) =>
        labelMode !== "building" &&
        hovered?.kind === "region" &&
        hovered.regionKey === f.properties.regionKey
          ? 2.2
          : 0.8,
      lineWidthUnits: "pixels",
      lineWidthMinPixels: 1,
      onHover:
        labelMode === "building"
          ? undefined
          : (info) => onHover(info.object?.properties),
      onClick: (info, event) => {
        if (
          info.object &&
          (event.tapCount === 2 || event.srcEvent?.detail === 2)
        )
          onRegionDoubleClick(info.object.properties);
      },
    }),
    ...(showPlots
      ? [
          new GeoJsonLayer({
            id: "urban-roads",
            data: { type: "FeatureCollection", features: formedRoads },
            pickable: false,
            filled: true,
            stroked: true,
            getFillColor: [164, 151, 124, 135],
            getLineColor: [211, 197, 165, 190],
            getLineWidth: 0.8,
            lineWidthUnits: "pixels",
            lineWidthMinPixels: 0.5,
          }),
          new GeoJsonLayer({
            id: "region-roads",
            data: { type: "FeatureCollection", features: regionRoads },
            visible: showRegionRoads,
            pickable: false,
            filled: true,
            stroked: true,
            getFillColor: (feature) =>
              feature.properties.roadClass === "primary"
                ? [202, 183, 142, 205]
                : [126, 145, 137, 185],
            getLineColor: (feature) =>
              feature.properties.roadClass === "primary"
                ? [237, 215, 167, 225]
                : [172, 190, 179, 205],
            getLineWidth: 0.7,
            lineWidthUnits: "pixels",
            lineWidthMinPixels: 0.4,
          }),
          new GeoJsonLayer({
            id: "region-stair-chunks",
            data: {
              type: "FeatureCollection",
              features: stairChunks.map(({ region, stair }) => ({
                type: "Feature",
                properties: {
                  kind: "stair",
                  regionId: region.id,
                  layer: selectedMobileLayer,
                },
                geometry: {
                  type: "Polygon",
                  coordinates: [ring(chunkAreaCorners(stairChunkArea(stair)))],
                },
              })),
            },
            visible: showRegionRoads,
            pickable: false,
            filled: true,
            stroked: true,
            getFillColor: [52, 41, 27, 235],
            getLineColor: [246, 203, 111, 255],
            getLineWidth: 1,
            lineWidthUnits: "pixels",
            lineWidthMinPixels: 0.8,
          }),
          new GeoJsonLayer({
            id: "region-stair-patterns",
            data: {
              type: "FeatureCollection",
              features: stairChunks.map(({ region, stair }) => ({
                type: "Feature",
                properties: {
                  kind: "stair-pattern",
                  regionId: region.id,
                  layer: selectedMobileLayer,
                },
                geometry: {
                  type: "LineString",
                  coordinates: stairPattern(stair),
                },
              })),
            },
            visible: showRegionRoads,
            pickable: false,
            filled: false,
            stroked: true,
            getLineColor: [255, 224, 154, 255],
            getLineWidth: 1.4,
            lineWidthUnits: "pixels",
            lineWidthMinPixels: 1,
          }),
        ]
      : []),
    ...(labelMode === "building"
      ? [
          new GeoJsonLayer({
            id: "building-slots",
            data: { type: "FeatureCollection", features: buildingSlots },
            filled: true,
            stroked: true,
            getFillColor: (feature) => [
              ...buildingColor(feature.properties.building_id),
              205,
            ],
            getLineColor: [8, 13, 13, 220],
            getLineWidth: 0.8,
            lineWidthUnits: "pixels",
            lineWidthMinPixels: 0.5,
          }),
        ]
      : []),
    ...(showLabels && labelMode === "nation"
      ? [
          new TextLayer({
            id: "nation-labels",
            data: formedNationLabels,
            getPosition: (d) => xy(polygonCenter(d.boundary)),
            getText: (d) => d.zh_cn_name,
            getColor: [227, 228, 210, 230],
            getSize: 13,
            sizeUnits: "pixels",
            fontWeight: 600,
            outlineWidth: 3,
            outlineColor: [7, 12, 12, 220],
            ...FONT,
          }),
        ]
      : []),
    ...(showLabels && labelMode === "city"
      ? [
          new TextLayer({
            id: "city-labels",
            data: formedCityLabels,
            getPosition: (d) => xy(polygonCenter(d.boundary)),
            getText: (d) => d.zh_cn_name,
            getColor: [238, 232, 208, 245],
            getSize: 12,
            sizeUnits: "pixels",
            fontWeight: 600,
            outlineWidth: 4,
            outlineColor: [5, 10, 10, 235],
            ...FONT,
          }),
        ]
      : []),
  ];
}

const Header = memo(function Header({
  layout,
  viewMode,
  switchView,
  showMapLabels,
  setShowMapLabels,
  showTerrainLabels,
  setShowTerrainLabels,
  terrainColorized,
  setTerrainColorized,
}) {
  const cities = layout.nations.reduce(
    (sum, nation) => sum + nation.cities.length,
    0,
  );
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" />
        <div>
          <p>TERRA LAYOUT / V{layout.schema_version}</p>
          <h1>Show Me Terra</h1>
        </div>
      </div>
      <div className="topbar-controls">
        <div className="header-view-switch" role="group" aria-label="地图视图">
          <button
            className={viewMode === "map" ? "active" : ""}
            onClick={() => switchView("map")}
          >
            二维地图
          </button>
          <button
            className={viewMode === "terrain" ? "active" : ""}
            onClick={() => switchView("terrain")}
          >
            三维地形
          </button>
          <button
            className={viewMode === "side" ? "active" : ""}
            onClick={() => switchView("side")}
          >
            四层侧视
          </button>
        </div>
        {viewMode !== "side" && (
          <label className="header-label-toggle">
            <input
              type="checkbox"
              checked={viewMode === "map" ? showMapLabels : showTerrainLabels}
              onChange={(event) =>
                viewMode === "map"
                  ? setShowMapLabels(event.target.checked)
                  : setShowTerrainLabels(event.target.checked)
              }
            />
            <span>{viewMode === "map" ? "显示文字" : "显示国家名称"}</span>
          </label>
        )}
        {viewMode === "terrain" && (
          <label className="header-label-toggle">
            <input
              type="checkbox"
              checked={terrainColorized}
              onChange={(event) => setTerrainColorized(event.target.checked)}
            />
            <span>分层设色</span>
          </label>
        )}
      </div>
      <div className="world-meta">
        <span>
          <b>{layout.nations.length}</b> 国家
        </span>
        <span>
          <b>{cities}</b> 城市
        </span>
        <span>
          <b>80K × 50K</b> 方块
        </span>
      </div>
    </header>
  );
});

const BuildingLegend = memo(function BuildingLegend({
  buildingTypes,
  selectedMobileLayer,
  showAllLayers = false,
}) {
  const layer = MOBILE_LAYERS.find((item) => item.id === selectedMobileLayer);
  const lowerLayerBuildings = MOBILE_LAYERS.filter(
    (item) => item.id !== "surface",
  ).map((item) => ({
    id: `mobile_plot_${item.id}_layer`,
    zh_cn_name: `${item.label}层建筑`,
  }));
  const entries = showAllLayers
    ? [...lowerLayerBuildings, ...buildingTypes]
    : selectedMobileLayer === "surface"
      ? buildingTypes
      : lowerLayerBuildings.filter(
          (building) => building.id === `mobile_plot_${selectedMobileLayer}_layer`,
        );
  return (
    <aside className="building-icon-legend panel" aria-label="建筑颜色图例">
      <div className="building-legend-heading">
        <span>建筑颜色</span>
        <small>{showAllLayers ? "四层" : `${layer.label}层`}</small>
      </div>
      <div className="building-legend-list">
        {entries.map((building) => (
          <div key={building.id} title={building.en_us_name ?? building.id}>
            <i
              style={{
                background: `rgb(${buildingColor(building.id).join(" ")})`,
              }}
            />
            <span>{building.zh_cn_name}</span>
          </div>
        ))}
      </div>
    </aside>
  );
});

const Explorer = memo(function Explorer({
  layout,
  filter,
  setFilter,
  query,
  setQuery,
}) {
  const [collapsed, setCollapsed] = useState(false);
  const color = (nation) =>
    COLORS[layout.nations.indexOf(nation) % COLORS.length].join(",");
  const visible = (nation) =>
    !(filter === "surface" && nation.underground) &&
    !(filter === "underground" && !nation.underground) &&
    (!query ||
      [
        nation.zh_cn_name,
        nation.id,
        ...nation.cities.flatMap((c) => [c.zh_cn_name, c.id]),
      ]
        .join(" ")
        .toLowerCase()
        .includes(query));
  const nations = layout.nations.filter(visible);
  useEffect(() => {
    const handler = (event) => {
      if (event.key === "/" && document.activeElement?.tagName !== "INPUT") {
        event.preventDefault();
        document.getElementById("search")?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);
  return (
    <aside className={`explorer panel ${collapsed ? "collapsed" : ""}`}>
      <div className="panel-heading">
        <div>
          <span className="eyebrow">WORLD INDEX</span>
          <h2>泰拉诸国</h2>
        </div>
        <button
          className="icon-button"
          title="收起列表"
          onClick={() => setCollapsed((v) => !v)}
        >
          ‹
        </button>
      </div>
      <label className="search">
        <span>⌕</span>
        <input
          id="search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value.toLowerCase())}
          placeholder="搜索国家或城市…"
          autoComplete="off"
        />
        <kbd>/</kbd>
      </label>
      <div className="filters">
        {[
          ["all", "全部"],
          ["surface", "地表"],
          ["underground", "地下"],
        ].map(([value, label]) => (
          <button
            key={value}
            className={`filter ${filter === value ? "active" : ""}`}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="nation-list">
        {nations.length ? (
          nations.map((nation) => {
            const matches = query
              ? nation.cities.filter((city) =>
                  `${city.zh_cn_name} ${city.id}`.toLowerCase().includes(query),
                )
              : [];
            return (
              <article
                key={nation.id}
                className="nation-item"
                style={{ "--nation-color": color(nation) }}
              >
                <div className="nation-button">
                  <span className="nation-index">
                    {String(layout.nations.indexOf(nation) + 1).padStart(
                      2,
                      "0",
                    )}
                  </span>
                  <span className="nation-name">
                    <strong>{nation.zh_cn_name}</strong>
                    <small>{nation.id.toUpperCase()}</small>
                  </span>
                  <span className="city-count">
                    {nation.cities.length}
                    <small>城市</small>
                  </span>
                </div>
                {matches.length > 0 && (
                  <div className="city-results">
                    {matches.map((city) => (
                      <span key={city.id}>
                        ↳ {city.zh_cn_name}
                      </span>
                    ))}
                  </div>
                )}
              </article>
            );
          })
        ) : (
          <div className="no-results">未找到匹配的地理记录</div>
        )}
      </div>
      <div className="legend">
        <span>
          <i />
          城市区域
        </span>
        <span>
          <i className="underground" />
          地下国家
        </span>
      </div>
    </aside>
  );
});

export default function App() {
  const { data: layout, heightmap, error } = useTerraData();
  const [hovered, setHovered] = useState(null);
  const [viewMode, setViewMode] = useState("map");
  const [showMapLabels, setShowMapLabels] = useState(true);
  const [showTerrainLabels, setShowTerrainLabels] = useState(false);
  const [terrainColorized, setTerrainColorized] = useState(false);
  const [formationProgress, setFormationProgress] = useState(null);
  const [formationPlaying, setFormationPlaying] = useState(false);
  const [selectedMobileLayer, setSelectedMobileLayer] = useState("surface");
  const [layerMenuOpen, setLayerMenuOpen] = useState(false);
  const [activeMapNationId, setActiveMapNationId] = useState(null);
  const [activeMapCityId, setActiveMapCityId] = useState(null);
  const [sideFocusTarget, setSideFocusTarget] = useState(HOME.target);
  const [splitSideRegion, setSplitSideRegion] = useState(null);
  const [cityDetailState, setCityDetailState] = useState({
    data: null,
    loading: false,
    error: null,
  });
  const [splitCityDetailState, setSplitCityDetailState] = useState({
    data: null,
    loading: false,
    error: null,
  });
  const [initialViewState, setInitialViewState] = useState(HOME);
  const [labelMode, setLabelMode] = useState(() => getLabelMode(HOME.zoom));
  const liveView = useRef(HOME);
  const liveViewMode = useRef("map");
  const liveLabelMode = useRef(getLabelMode(HOME.zoom));
  const coordinatesRef = useRef(null);
  const coordinateFrame = useRef(0);
  const formationFrame = useRef(0);
  const hoveredKey = useRef("");
  const activeMapNationIdRef = useRef(null);
  const activeMapCityIdRef = useRef(null);

  const pauseFormation = useCallback(() => {
    if (formationFrame.current) cancelAnimationFrame(formationFrame.current);
    formationFrame.current = 0;
    setFormationPlaying(false);
  }, []);
  const stopFormation = useCallback(() => {
    pauseFormation();
    setFormationProgress(null);
  }, [pauseFormation]);
  const updateActiveMapLocation = useCallback(
    (target) => {
      const { nationId, cityId } = target
        ? locationAtTarget(layout, target)
        : { nationId: null, cityId: null };
      if (
        nationId === activeMapNationIdRef.current &&
        cityId === activeMapCityIdRef.current
      )
        return;
      activeMapNationIdRef.current = nationId;
      activeMapCityIdRef.current = cityId;
      setActiveMapNationId(nationId);
      setActiveMapCityId(cityId);
    },
    [layout],
  );

  const setMapView = useCallback(
    (target, zoom) => {
      const next = {
        ...liveView.current,
        target: [target[0], target[1], target[2] ?? 0],
        zoom,
        minZoom: HOME.minZoom,
        maxZoom: HOME.maxZoom,
      };
      liveView.current = next;
      if (liveViewMode.current === "map") {
        updateActiveMapLocation(next.target);
        const nextMode = getLabelMode(zoom);
        if (nextMode !== liveLabelMode.current) {
          liveLabelMode.current = nextMode;
          setLabelMode(nextMode);
          hoveredKey.current = "";
          setHovered(null);
        }
      }
      setInitialViewState(next);
      if (coordinatesRef.current) {
        coordinatesRef.current.textContent = `X ${number(next.target[0])} · Z ${number(-next.target[1])}`;
      }
    },
    [updateActiveMapLocation],
  );
  const switchView = useCallback((mode) => {
    if (mode === liveViewMode.current) return;
    stopFormation();
    setLayerMenuOpen(false);
    setSplitSideRegion(null);
    const currentTarget = liveView.current.target ?? HOME.target;
    if (mode === "side") setSideFocusTarget(currentTarget);
    liveViewMode.current = mode;
    setViewMode(mode);
    const home =
      mode === "terrain"
        ? TERRAIN_HOME
        : mode === "side"
          ? {
              ...SIDE_HOME,
              target: [currentTarget[0], currentTarget[1], SIDE_HOME.target[2]],
            }
          : HOME;
    liveView.current = home;
    updateActiveMapLocation(mode === "terrain" ? null : home.target);
    if (mode === "map") {
      const nextMode = getLabelMode(home.zoom);
      liveLabelMode.current = nextMode;
      setLabelMode(nextMode);
    }
    hoveredKey.current = "";
    setHovered(null);
    setInitialViewState({ ...home, target: [...home.target] });
    if (coordinatesRef.current)
      coordinatesRef.current.textContent = "X 0 · Z 0";
  }, [stopFormation, updateActiveMapLocation]);
  const playFormation = useCallback(() => {
    pauseFormation();
    if (liveViewMode.current !== "map") switchView("map");
    const startProgress =
      formationProgress === null || formationProgress >= 1
        ? 0
        : formationProgress;
    if (formationProgress === null) {
      setMapView(HOME.target, HOME.zoom);
    }
    setFormationProgress(startProgress);
    setFormationPlaying(true);

    const startedAt =
      performance.now() - startProgress * FORMATION_REVEAL_DURATION;
    let lastUpdate = 0;
    const animate = (now) => {
      const elapsed = now - startedAt;
      if (
        elapsed <= FORMATION_REVEAL_DURATION &&
        (now - lastUpdate >= 50 || elapsed === 0)
      ) {
        lastUpdate = now;
        setFormationProgress(
          Math.min(1, elapsed / FORMATION_REVEAL_DURATION),
        );
      }
      if (elapsed < FORMATION_REVEAL_DURATION) {
        formationFrame.current = requestAnimationFrame(animate);
      } else {
        formationFrame.current = 0;
        setFormationProgress(1);
        setFormationPlaying(false);
      }
    };
    formationFrame.current = requestAnimationFrame(animate);
  }, [formationProgress, pauseFormation, setMapView, switchView]);
  const scrubFormation = useCallback(
    (event) => {
      pauseFormation();
      if (formationProgress === null) {
        setMapView(HOME.target, HOME.zoom);
      }
      setFormationProgress(Number(event.target.value) / 1000);
    },
    [formationProgress, pauseFormation, setMapView],
  );
  const hoverItem = useCallback((item) => {
    const key = item
      ? `${item.kind}:${item.regionKey ?? item.id}`
      : "";
    if (key === hoveredKey.current) return;
    hoveredKey.current = key;
    setHovered(item ?? null);
  }, []);
  const openRegionSide = useCallback((region) => {
    const target = xy(region.center);
    activeMapNationIdRef.current = region.nationId;
    activeMapCityIdRef.current = region.cityId;
    setActiveMapNationId(region.nationId);
    setActiveMapCityId(region.cityId);
    setSideFocusTarget(target);
    setLayerMenuOpen(false);
    setSplitSideRegion({
      key: region.regionKey,
      nationId: region.nationId,
      cityId: region.cityId,
      name: region.zh_cn_name,
      cityName: region.cityName,
    });
  }, []);
  const changeView = useCallback(({ viewState: next }) => {
    liveView.current = {
      ...next,
      minZoom: HOME.minZoom,
      maxZoom: HOME.maxZoom,
    };
    const zoom = Array.isArray(next.zoom) ? next.zoom[0] : next.zoom;
    if (liveViewMode.current === "map") {
      updateActiveMapLocation(next.target ?? HOME.target);
      const nextMode = getLabelMode(zoom);
      if (nextMode !== liveLabelMode.current) {
        liveLabelMode.current = nextMode;
        setLabelMode(nextMode);
        hoveredKey.current = "";
        setHovered(null);
      }
    }
    if (coordinateFrame.current) return;
    coordinateFrame.current = requestAnimationFrame(() => {
      coordinateFrame.current = 0;
      const target = liveView.current.target ?? HOME.target;
      if (coordinatesRef.current) {
        coordinatesRef.current.textContent = `X ${number(target[0])} · Z ${number(-target[1])}`;
      }
    });
  }, [updateActiveMapLocation]);
  useEffect(
    () => () => {
      if (coordinateFrame.current)
        cancelAnimationFrame(coordinateFrame.current);
      if (formationFrame.current)
        cancelAnimationFrame(formationFrame.current);
    },
    [],
  );
  useEffect(() => {
    updateActiveMapLocation(
      liveViewMode.current === "terrain" ? null : liveView.current.target,
    );
  }, [layout, updateActiveMapLocation]);
  const detailNationId =
    viewMode === "side" ||
    (viewMode === "map" &&
      (labelMode === "plot" || labelMode === "building"))
      ? activeMapNationId
      : null;
  const detailCityId = detailNationId ? activeMapCityId : null;
  useEffect(() => {
    if (!layout || !detailNationId || !detailCityId) {
      setCityDetailState({ data: null, loading: false, error: null });
      return undefined;
    }
    const controller = new AbortController();
    setCityDetailState({ data: null, loading: true, error: null });
    fetchCityDetail(layout, detailNationId, detailCityId, controller.signal)
      .then((cityDetail) => {
        setCityDetailState({
          data: cityDetail,
          loading: false,
          error: null,
        });
      })
      .catch((error) => {
        if (error.name !== "AbortError")
          setCityDetailState({ data: null, loading: false, error });
      });
    return () => controller.abort();
  }, [detailCityId, detailNationId, layout]);

  const splitNationId = splitSideRegion?.nationId ?? null;
  const splitCityId = splitSideRegion?.cityId ?? null;
  useEffect(() => {
    if (!layout || !splitNationId || !splitCityId) {
      setSplitCityDetailState({ data: null, loading: false, error: null });
      return undefined;
    }
    if (splitNationId === detailNationId && splitCityId === detailCityId)
      return undefined;
    if (
      cityDetailState.data?.nation_id === splitNationId &&
      cityDetailState.data?.city_id === splitCityId
    ) {
      setSplitCityDetailState({
        data: cityDetailState.data,
        loading: false,
        error: null,
      });
      return undefined;
    }
    if (
      splitCityDetailState.data?.nation_id === splitNationId &&
      splitCityDetailState.data?.city_id === splitCityId
    )
      return undefined;
    const controller = new AbortController();
    setSplitCityDetailState({ data: null, loading: true, error: null });
    fetchCityDetail(layout, splitNationId, splitCityId, controller.signal)
      .then((cityDetail) =>
        setSplitCityDetailState({
          data: cityDetail,
          loading: false,
          error: null,
        }),
      )
      .catch((error) => {
        if (error.name !== "AbortError")
          setSplitCityDetailState({ data: null, loading: false, error });
      });
    return () => controller.abort();
  }, [
    cityDetailState.data,
    layout,
    splitCityDetailState.data,
    splitCityId,
    splitNationId,
    detailCityId,
    detailNationId,
  ]);

  const visibleNations = layout?.nations ?? [];
  const activeNationDetail =
    cityDetailState.data?.nation_id === detailNationId &&
    cityDetailState.data?.city_id === detailCityId
      ? cityDetailState.data
      : null;
  const sideNationDetail = splitNationId
    ? [cityDetailState.data, splitCityDetailState.data].find(
        (detail) =>
          detail?.nation_id === splitNationId &&
          detail?.city_id === splitCityId,
      ) ?? null
    : activeNationDetail;
  const layers = useMemo(
    () =>
      layout
        ? createLayers(
            layout,
            visibleNations,
            hovered,
            hoverItem,
            openRegionSide,
            labelMode,
            showMapLabels,
            formationProgress,
            activeNationDetail,
            selectedMobileLayer,
          )
        : [],
    [
      layout,
      visibleNations,
      hovered,
      hoverItem,
      openRegionSide,
      labelMode,
      showMapLabels,
      formationProgress,
      activeNationDetail,
      selectedMobileLayer,
    ],
  );
  const terrainMetrics = useMemo(
    () =>
      layout && heightmap
        ? calculateTerrainMetrics(layout.boundary, heightmap)
        : null,
    [heightmap, layout],
  );
  const terrainLayers = useMemo(() => {
    if (!layout || !heightmap || !terrainMetrics || viewMode !== "terrain")
      return [];
    const boundaryData = createTerrainBoundaries(layout);
    const structures = createTerrainStructures(
      layout,
      null,
      terrainMetrics,
      heightmap,
    );
    return [
      new SimpleMeshLayer({
        id: "terrain-solid-base",
        data: [{}],
        mesh: createTerrainBaseMesh(layout.boundary, heightmap, terrainMetrics),
        _instanced: false,
        getPosition: [0, 0, 0],
        getColor: terrainColorized
          ? [190, 193, 193, 255]
          : [255, 255, 255, 255],
        material: false,
        pickable: false,
      }),
      new TerrainLayer({
        id: `terra-heightmap-${terrainColorized ? "color" : "plain"}`,
        operation: "terrain+draw",
        elevationData: versionedAsset("terrain/elevation.png"),
        texture: terrainColorized
          ? versionedAsset("terrain/terrain-texture.png")
          : WHITE_TERRAIN_TEXTURE,
        bounds: getTerrainBounds(layout.boundary),
        elevationDecoder: {
          rScaler: 256 * terrainMetrics.scale,
          gScaler: terrainMetrics.scale,
          bScaler: 0,
          offset:
            Math.min(0, Math.floor(heightmap.statistics.minimum_y)) *
            terrainMetrics.scale,
        },
        meshMaxError: 16,
        color: [255, 255, 255],
        material: false,
      }),
      new SimpleMeshLayer({
        id: "terrain-region-foundations",
        data: structures.foundations,
        mesh: UNIT_BOX_MESH,
        getPosition: (item) => item.position,
        getScale: (item) => item.scale,
        getColor: (item) =>
          terrainColorized ? item.color : [255, 255, 255, 255],
        material: false,
        pickable: false,
      }),
      new SimpleMeshLayer({
        id: "terrain-region-buildings",
        data: structures.buildings,
        mesh: UNIT_BOX_MESH,
        getPosition: (item) => item.position,
        getScale: (item) => item.scale,
        getColor: (item) =>
          terrainColorized ? item.color : [255, 255, 255, 255],
        material: false,
        pickable: false,
      }),
      new GeoJsonLayer({
        id: "terrain-boundaries",
        data: boundaryData,
        filled: false,
        stroked: true,
        pickable: false,
        getLineColor: [91, 96, 96, 225],
        getLineWidth: ({ properties }) =>
          properties.kind === "terra"
            ? 2.5
            : properties.kind === "nation"
              ? 1.4
              : properties.kind === "city"
                ? 1.2
                : properties.kind === "region"
                  ? 0.7
                  : 0.45,
        lineWidthUnits: "pixels",
        lineWidthMinPixels: 0.35,
        extensions: [new TerrainExtension()],
        terrainDrawMode: "offset",
      }),
      new TextLayer({
        id: "terrain-nation-labels",
        data: layout.nations.filter((nation) => !nation.underground),
        visible: showTerrainLabels,
        ...FONT,
        billboard: true,
        getPosition: (nation) => [
          nation.center.x,
          -nation.center.z,
          TERRAIN_LABEL_LIFT,
        ],
        getText: (nation) => nation.zh_cn_name,
        getSize: 13,
        sizeUnits: "pixels",
        sizeMinPixels: 8,
        sizeMaxPixels: 17,
        getColor: [5, 5, 5, 255],
        outlineColor: [255, 255, 255, 245],
        outlineWidth: 0.18,
        fontWeight: 700,
        pickable: false,
        extensions: [new TerrainExtension()],
        terrainDrawMode: "offset",
      }),
    ];
  }, [
    heightmap,
    layout,
    showTerrainLabels,
    terrainColorized,
    terrainMetrics,
    viewMode,
  ]);
  const sideLayers = useMemo(() => {
    if (viewMode !== "side" && !splitSideRegion) return [];
    const structures = createSideStructures(sideNationDetail, sideFocusTarget);
    return [
      new SimpleMeshLayer({
        id: "side-layer-blocks",
        data: structures.blocks,
        mesh: UNIT_BOX_MESH,
        getPosition: (item) => item.position,
        getScale: (item) => item.scale,
        getColor: (item) => item.color,
        material: false,
        pickable: false,
      }),
      new SimpleMeshLayer({
        id: "side-layer-roads",
        data: structures.roads,
        mesh: UNIT_BOX_MESH,
        getPosition: (item) => item.position,
        getScale: (item) => item.scale,
        getColor: (item) => item.color,
        material: false,
        pickable: false,
      }),
      new SimpleMeshLayer({
        id: "side-layer-stairs",
        data: structures.stairs,
        mesh: UNIT_BOX_MESH,
        getPosition: (item) => item.position,
        getScale: (item) => item.scale,
        getColor: (item) => item.color,
        material: false,
        pickable: false,
      }),
    ];
  }, [sideFocusTarget, sideNationDetail, splitSideRegion, viewMode]);
  const zoomBy = (delta) => {
    const current = liveView.current;
    const zoom = Array.isArray(current.zoom) ? current.zoom[0] : current.zoom;
    setMapView(
      current.target ?? HOME.target,
      Math.max(HOME.minZoom, Math.min(HOME.maxZoom, zoom + delta)),
    );
  };
  const resetView = () => {
    const activeNation = layout.nations.find(
      (nation) => nation.id === activeMapNationId,
    );
    const activeCity = activeNation?.cities.find(
      (city) => city.id === activeMapCityId,
    );
    const home =
      viewMode === "terrain"
        ? TERRAIN_HOME
        : viewMode === "side"
          ? {
              ...SIDE_HOME,
              target: activeCity
                ? [activeCity.center.x, -activeCity.center.z, SIDE_HOME.target[2]]
                : SIDE_HOME.target,
            }
          : HOME;
    liveView.current = home;
    if (viewMode === "side") setSideFocusTarget(home.target);
    updateActiveMapLocation(viewMode === "terrain" ? null : home.target);
    setInitialViewState({ ...home, target: [...home.target] });
    if (coordinatesRef.current)
      coordinatesRef.current.textContent = "X 0 · Z 0";
  };

  if (error)
    return (
      <div className="error">
        <b>地图数据载入失败</b>
        <span>{error.message}</span>
        <small>请通过 npm run dev 启动项目。</small>
      </div>
    );
  if (!layout)
    return (
      <div className="loading">
        <span className="loader-mark" />
        <p>正在载入泰拉地理档案</p>
      </div>
    );
  return (
    <div id="app" className={splitSideRegion ? "split-side-open" : ""}>
      <div
        id="map"
        aria-label={
          viewMode === "terrain"
            ? "Terra 三维地形"
            : viewMode === "side"
              ? "Terra 四层侧视图"
              : "Terra 二维地图"
        }
        onClick={() => setLayerMenuOpen(false)}
        onPointerLeave={() => hoverItem(null)}
        onContextMenu={
          viewMode !== "map" ? (event) => event.preventDefault() : undefined
        }
      >
        <DeckGL
          views={viewMode === "map" ? ORTHO_VIEW : ORBIT_VIEW}
          initialViewState={initialViewState}
          onViewStateChange={changeView}
          controller={viewMode === "map" ? CONTROLLER : true}
          layers={
            viewMode === "terrain"
              ? terrainLayers
              : viewMode === "side"
                ? sideLayers
                : layers
          }
          useDevicePixels={DEVICE_PIXEL_RATIO}
          getCursor={GET_CURSOR}
        />
      </div>
      {viewMode === "map" && splitSideRegion && (
        <section className="split-side-view" aria-label="Region 四层侧视图">
          <div className="split-side-heading">
            <span>
              <small>{splitSideRegion.cityName}</small>
              <strong>{splitSideRegion.name}</strong>
            </span>
            <button
              title="关闭侧视图"
              aria-label="关闭侧视图"
              onClick={() => setSplitSideRegion(null)}
            >
              ×
            </button>
          </div>
          <div
            className="split-side-canvas"
            onContextMenu={(event) => event.preventDefault()}
          >
            <DeckGL
              key={splitSideRegion.key}
              views={ORBIT_VIEW}
              initialViewState={{
                ...SIDE_HOME,
                target: [
                  sideFocusTarget[0],
                  sideFocusTarget[1],
                  SIDE_HOME.target[2],
                ],
              }}
              controller
              layers={sideLayers}
              useDevicePixels={DEVICE_PIXEL_RATIO}
              getCursor={GET_CURSOR}
            />
          </div>
        </section>
      )}
      <Header
        layout={layout}
        viewMode={viewMode}
        switchView={switchView}
        showMapLabels={showMapLabels}
        setShowMapLabels={setShowMapLabels}
        showTerrainLabels={showTerrainLabels}
        setShowTerrainLabels={setShowTerrainLabels}
        terrainColorized={terrainColorized}
        setTerrainColorized={setTerrainColorized}
      />
      {viewMode === "map" && (
        <div className="map-options">
          <div className="map-option-controls">
            <button
              className={formationPlaying ? "active" : ""}
              onClick={formationPlaying ? pauseFormation : playFormation}
            >
              {formationPlaying
                ? "暂停"
                : formationProgress === null
                  ? "演示形成"
                  : formationProgress >= 1
                    ? "重新播放"
                    : "继续播放"}
            </button>
            {formationProgress !== null && (
              <button onClick={stopFormation}>退出</button>
            )}
          </div>
          <div className="formation-progress" aria-live="polite">
            <span>
              {formationProgress === null
                ? "时间线"
                : formationProgress < FORMATION_NATIONS_END
                  ? "国家形成"
                  : formationProgress < FORMATION_CITIES_END
                    ? "城市形成"
                    : "区域生长"}
            </span>
            <input
              type="range"
              min="0"
              max="1000"
              step="1"
              value={(formationProgress ?? 0) * 1000}
              aria-label="布局形成时间线"
              onPointerDown={pauseFormation}
              onChange={scrubFormation}
            />
            <small>{Math.round((formationProgress ?? 0) * 100)}%</small>
          </div>
        </div>
      )}
      {viewMode === "map" &&
        (labelMode === "building" || splitSideRegion) && (
        <BuildingLegend
          buildingTypes={layout.building_types}
          selectedMobileLayer={selectedMobileLayer}
          showAllLayers={Boolean(splitSideRegion)}
        />
      )}
      {viewMode === "side" && (
        <BuildingLegend
          buildingTypes={layout.building_types}
          selectedMobileLayer="surface"
          showAllLayers
        />
      )}
      <div className="map-tools">
        <button title="放大" onClick={() => zoomBy(0.6)}>
          +
        </button>
        <button title="缩小" onClick={() => zoomBy(-0.6)}>
          −
        </button>
        {viewMode === "map" && (
          <div className="map-layer-control">
            <button
              className={`map-layer-trigger ${layerMenuOpen ? "active" : ""}`}
              title="选择预览层"
              aria-label="选择预览层"
              aria-expanded={layerMenuOpen}
              onClick={() => setLayerMenuOpen((open) => !open)}
            >
              <span className="layers-icon" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </button>
            {layerMenuOpen && (
              <div className="map-layer-menu" role="menu">
                <small>预览层</small>
                {MOBILE_LAYERS.map((layer) => (
                  <button
                    key={layer.id}
                    role="menuitemradio"
                    aria-checked={selectedMobileLayer === layer.id}
                    className={selectedMobileLayer === layer.id ? "active" : ""}
                    onClick={() => {
                      setSelectedMobileLayer(layer.id);
                      setLayerMenuOpen(false);
                    }}
                  >
                    <span>{layer.label}</span>
                    <em>{layer.id}</em>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <button
          title="显示完整地图"
          onClick={resetView}
        >
          ⌖
        </button>
      </div>
      {viewMode === "terrain" && (
        <aside className="terrain-elevation-legend" aria-label="地形高度图例">
          <div className="terrain-legend-title">
            <span>地形高度</span>
            <small>
              Y / 方块 · {terrainMetrics?.scale.toFixed(1)}×
            </small>
          </div>
          <div
            className="terrain-color-scale"
            style={{ background: TERRAIN_GRADIENT }}
          />
          <div className="terrain-height-ticks">
            <span>{Math.round(terrainMetrics?.min ?? 0)}</span>
            <span>
              {Math.round(
                ((terrainMetrics?.min ?? 0) + (terrainMetrics?.max ?? 0)) / 2,
              )}
            </span>
            <span>{Math.round(terrainMetrics?.max ?? 0)}</span>
          </div>
          <div className="terrain-height-caption">
            <span>低</span>
            <span>高</span>
          </div>
        </aside>
      )}
      <footer className="statusbar">
        <span className="status-dot" />
        <span>MAP ONLINE</span>
        <span className="divider" />
        <span ref={coordinatesRef}>X 0 · Z 0</span>
        <span className="status-help">
          {viewMode === "terrain"
            ? `拖拽旋转 · 右键平移 · 滚轮缩放 · 高程夸张 ${terrainMetrics?.scale.toFixed(1)}×`
            : viewMode === "side"
              ? "拖拽旋转 · 右键平移 · 滚轮缩放 · 四层同时显示"
              : "拖拽移动 · 滚轮缩放 · 悬停高亮"}
        </span>
      </footer>
    </div>
  );
}
