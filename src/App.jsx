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
async function readPossiblyGzippedJson(response, path) {
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  if (typeof DecompressionStream === "undefined") {
    throw new Error(`浏览器不支持解压国家详情: ${path}`);
  }
  const stream = new Blob([buffer])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).json();
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
  doubleClickZoom: true,
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
const number = (value) => Math.round(value).toLocaleString("zh-CN");
const buildingColor = (id) => {
  let hash = 0;
  for (let index = 0; index < id.length; index++)
    hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  return COLORS[hash % COLORS.length];
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
        if (data.schema_version !== 14)
          throw new Error(`需要 Terra Layout v14，实际为 v${data.schema_version}`);
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
  labelMode,
  showLabels,
  formationProgress,
  nationDetail,
  selectedNationId,
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
          coordinates: [
            ring(road.block_area?.corners ?? chunkAreaCorners(road.chunk_area)),
          ],
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
    regionRoads = REGION_ROAD_DATA_CACHE.get(nationDetail);
    if (!regionRoads) {
      regionRoads = nationDetail.regions.flatMap((region) =>
        region.roads.map((road) => ({
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
            coordinates: [ring(chunkAreaCorners(road.chunk_area))],
          },
        })),
      );
      REGION_ROAD_DATA_CACHE.set(nationDetail, regionRoads);
    }
  }
  let buildingSlots = [];
  if (nationDetail && labelMode === "building") {
    buildingSlots = BUILDING_DATA_CACHE.get(nationDetail);
    if (!buildingSlots) {
      buildingSlots = nationDetail.regions.flatMap((region) =>
        region.building_slots.map((slot) => ({
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
        })),
      );
      BUILDING_DATA_CACHE.set(nationDetail, buildingSlots);
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
          : selectedNationId && selectedNationId !== f.properties.id
            ? 18
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
      pickable: labelMode === "region" || labelMode === "plot",
      filled: true,
      stroked: true,
      getFillColor: (f) =>
        hovered?.kind === "region" &&
        hovered.regionKey === f.properties.regionKey
          ? [244, 213, 143, 125]
          : [12, 20, 19, 45],
      getLineColor: (f) => [...f.properties.color, 185],
      getLineWidth: (f) =>
        hovered?.kind === "region" &&
        hovered.regionKey === f.properties.regionKey
          ? 2.2
          : 0.8,
      lineWidthUnits: "pixels",
      lineWidthMinPixels: 1,
      onHover: (info) => onHover(info.object?.properties),
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
  detailPanelOpen,
  toggleDetailPanel,
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
        </div>
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
        {viewMode === "map" && (
          <button
            className={`nation-detail-trigger ${detailPanelOpen ? "active" : ""}`}
            onClick={toggleDetailPanel}
          >
            国家详情
          </button>
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

const NationDetailPanel = memo(function NationDetailPanel({
  layout,
  selectedNationId,
  onSelect,
  onExit,
  onClose,
  detailState,
}) {
  const selectedNation = layout.nations.find(
    (nation) => nation.id === selectedNationId,
  );
  return (
    <aside className="nation-detail-panel panel">
      <div className="nation-detail-heading">
        <div>
          <span className="eyebrow">NATION DETAIL</span>
          <h2>{selectedNation?.zh_cn_name ?? "选择国家"}</h2>
        </div>
        <button className="icon-button" title="关闭" onClick={onClose}>×</button>
      </div>
      {selectedNation && (
        <div className="nation-detail-status">
          <span>{selectedNation.cities.length} 个城市</span>
          <span>
            {selectedNation.cities.reduce(
              (total, city) => total + city.regions.length,
              0,
            )}{" "}
            个 Region
          </span>
          {detailState.loading && <b>正在加载道路与建筑…</b>}
          {detailState.data && <b>道路与建筑已加载</b>}
          {detailState.error && <b className="error-text">加载失败</b>}
          <button onClick={onExit}>退出详情</button>
        </div>
      )}
      <div className="nation-detail-list">
        {layout.nations.map((nation, index) => (
          <button
            key={nation.id}
            className={nation.id === selectedNationId ? "active" : ""}
            onClick={() => onSelect(nation)}
          >
            <i style={{ background: `rgb(${COLORS[index % COLORS.length].join(" ")})` }} />
            <span>
              <strong>{nation.zh_cn_name}</strong>
              <small>{nation.id}</small>
            </span>
            <em>{nation.cities.length}</em>
          </button>
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
  const [detailPanelOpen, setDetailPanelOpen] = useState(false);
  const [selectedNationId, setSelectedNationId] = useState(null);
  const [nationDetailState, setNationDetailState] = useState({
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

  const pauseFormation = useCallback(() => {
    if (formationFrame.current) cancelAnimationFrame(formationFrame.current);
    formationFrame.current = 0;
    setFormationPlaying(false);
  }, []);
  const stopFormation = useCallback(() => {
    pauseFormation();
    setFormationProgress(null);
  }, [pauseFormation]);

  const setMapView = useCallback((target, zoom) => {
    const next = {
      ...liveView.current,
      target: [target[0], target[1], target[2] ?? 0],
      zoom,
      minZoom: HOME.minZoom,
      maxZoom: HOME.maxZoom,
    };
    liveView.current = next;
    if (liveViewMode.current === "map") {
      const nextMode = getLabelMode(zoom);
      if (nextMode !== liveLabelMode.current) {
        liveLabelMode.current = nextMode;
        setLabelMode(nextMode);
      }
    }
    setInitialViewState(next);
    if (coordinatesRef.current) {
      coordinatesRef.current.textContent = `X ${number(next.target[0])} · Z ${number(-next.target[1])}`;
    }
  }, []);
  const switchView = useCallback((mode) => {
    if (mode === liveViewMode.current) return;
    stopFormation();
    liveViewMode.current = mode;
    setViewMode(mode);
    const home = mode === "terrain" ? TERRAIN_HOME : HOME;
    liveView.current = home;
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
  }, [stopFormation]);
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
  const selectNation = useCallback(
    (nation) => {
      stopFormation();
      setSelectedNationId(nation.id);
      setMapView(xy(nation.center), -2.3);
    },
    [setMapView, stopFormation],
  );
  const exitNationDetail = useCallback(() => {
    setSelectedNationId(null);
    hoveredKey.current = "";
    setHovered(null);
  }, []);
  const hoverItem = useCallback((item) => {
    const key = item
      ? `${item.kind}:${item.regionKey ?? item.id}`
      : "";
    if (key === hoveredKey.current) return;
    hoveredKey.current = key;
    setHovered(item ?? null);
  }, []);
  const changeView = useCallback(({ viewState: next }) => {
    liveView.current = {
      ...next,
      minZoom: HOME.minZoom,
      maxZoom: HOME.maxZoom,
    };
    const zoom = Array.isArray(next.zoom) ? next.zoom[0] : next.zoom;
    if (liveViewMode.current === "map") {
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
  }, []);
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
    if (!layout || !selectedNationId) {
      setNationDetailState({ data: null, loading: false, error: null });
      return undefined;
    }
    const detailPath = layout.nation_detail_files?.[selectedNationId];
    if (!detailPath) {
      setNationDetailState({
        data: null,
        loading: false,
        error: new Error(`缺少国家详情文件: ${selectedNationId}`),
      });
      return undefined;
    }

    const controller = new AbortController();
    setNationDetailState({ data: null, loading: true, error: null });
    fetch(versionedAsset(`data/${detailPath}`), { signal: controller.signal })
      .then((response) => {
        if (!response.ok)
          throw new Error(`${detailPath}: HTTP ${response.status}`);
        return readPossiblyGzippedJson(response, detailPath);
      })
      .then((data) => {
        if (
          data.schema_version !== layout.schema_version ||
          data.nation?.id !== selectedNationId
        ) {
          throw new Error(`国家详情数据不匹配: ${selectedNationId}`);
        }
        const nationDetail = {
          schema_version: data.schema_version,
          nation_id: data.nation.id,
          regions: data.nation.cities.flatMap((city) =>
            city.regions.map((region) => ({
              id: region.id,
              city_id: city.id,
              slot_index: region.slot_index,
              roads: region.region_layout.road_graph.edges,
              building_slots: region.building_slots,
            })),
          ),
        };
        setNationDetailState({
          data: nationDetail,
          loading: false,
          error: null,
        });
      })
      .catch((error) => {
        if (error.name !== "AbortError")
          setNationDetailState({ data: null, loading: false, error });
      });
    return () => controller.abort();
  }, [layout, selectedNationId]);

  const visibleNations = layout?.nations ?? [];
  const layers = useMemo(
    () =>
      layout
        ? createLayers(
            layout,
            visibleNations,
            hovered,
            hoverItem,
            labelMode,
            showMapLabels,
            formationProgress,
            nationDetailState.data,
            selectedNationId,
          )
        : [],
    [
      layout,
      visibleNations,
      hovered,
      hoverItem,
      labelMode,
      showMapLabels,
      formationProgress,
      nationDetailState.data,
      selectedNationId,
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
      nationDetailState.data,
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
    nationDetailState.data,
    showTerrainLabels,
    terrainColorized,
    terrainMetrics,
    viewMode,
  ]);
  const zoomBy = (delta) => {
    const current = liveView.current;
    const zoom = Array.isArray(current.zoom) ? current.zoom[0] : current.zoom;
    setMapView(
      current.target ?? HOME.target,
      Math.max(HOME.minZoom, Math.min(HOME.maxZoom, zoom + delta)),
    );
  };
  const resetView = () => {
    const home = viewMode === "terrain" ? TERRAIN_HOME : HOME;
    liveView.current = home;
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
    <div id="app" className={detailPanelOpen ? "detail-open" : ""}>
      <div
        id="map"
        aria-label={viewMode === "terrain" ? "Terra 三维地形" : "Terra 二维地图"}
        onContextMenu={
          viewMode === "terrain" ? (event) => event.preventDefault() : undefined
        }
      >
        <DeckGL
          views={viewMode === "terrain" ? ORBIT_VIEW : ORTHO_VIEW}
          initialViewState={initialViewState}
          onViewStateChange={changeView}
          controller={viewMode === "terrain" ? true : CONTROLLER}
          layers={viewMode === "terrain" ? terrainLayers : layers}
          useDevicePixels={DEVICE_PIXEL_RATIO}
          getCursor={GET_CURSOR}
        />
      </div>
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
        detailPanelOpen={detailPanelOpen}
        toggleDetailPanel={() => setDetailPanelOpen((open) => !open)}
      />
      {viewMode === "map" && detailPanelOpen && (
        <NationDetailPanel
          layout={layout}
          selectedNationId={selectedNationId}
          onSelect={selectNation}
          onExit={exitNationDetail}
          onClose={() => setDetailPanelOpen(false)}
          detailState={nationDetailState}
        />
      )}
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
      <div className="map-tools">
        <button title="放大" onClick={() => zoomBy(0.6)}>
          +
        </button>
        <button title="缩小" onClick={() => zoomBy(-0.6)}>
          −
        </button>
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
            : "拖拽移动 · 滚轮缩放 · 悬停高亮"}
        </span>
      </footer>
    </div>
  );
}
