import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DeckGL,
  GeoJsonLayer,
  OrbitView,
  OrthographicView,
  ScatterplotLayer,
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
  [26, 152, 80],
  [145, 207, 96],
  [255, 255, 191],
  [252, 141, 89],
  [215, 48, 39],
];
const TERRAIN_GRADIENT = `linear-gradient(90deg, ${TERRAIN_PALETTE.map(
  (color, index) =>
    `rgb(${color.join(" ")}) ${(index / (TERRAIN_PALETTE.length - 1)) * 100}%`,
).join(", ")})`;
const versionedAsset = (path) =>
  `${import.meta.env.BASE_URL}${path}?v=${encodeURIComponent(__BUILD_ID__)}`;
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
const TERRAIN_BASE_HEIGHT = 600;
const TERRAIN_TARGET_RELIEF = 9000;
const TERRAIN_MIN_SCALE = 8;
const TERRAIN_MAX_SCALE = 64;
const TERRAIN_BOUNDARY_LIFT = 36;
const TERRAIN_BOUNDARY_STEP = 512;
const TERRAIN_LABEL_LIFT = 1200;
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
    TERRAIN_BASE_HEIGHT +
      (sampleTerrainHeight(heightmap, point.x, point.z) - metrics.min) *
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
        if (data.schema_version !== 9)
          throw new Error(`需要 Terra Layout v9，实际为 v${data.schema_version}`);
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

function createLayers(layout, visibleNations, hovered, onHover, labelMode) {
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
          boundary: undefined,
        },
        geometry: { type: "Polygon", coordinates: [ring(region.boundary)] },
      })),
    ),
  );
  const cityLabels = visibleNations.flatMap((nation) => nation.cities);
  const regionLabels = cityLabels.flatMap((city) => city.regions);
  const regionRecords = visibleNations.flatMap((nation) =>
    nation.cities.flatMap((city) =>
      city.regions.map((region) => ({ nation, city, region })),
    ),
  );
  const mobilePlots = regionRecords.map(({ nation, city, region }) => ({
    type: "Feature",
    properties: {
      kind: "plot",
      regionKey: `${city.id}:${region.slot_index}`,
      zh_cn_name: "移动地块",
      color: color(nation),
    },
    geometry: {
      type: "Polygon",
      coordinates: [ring(region.mobile_plot.corners)],
    },
  }));
  const connections = regionRecords.flatMap(({ city, region }) =>
    region.connections.flatMap((connection) => {
      if (region.slot_index >= connection.neighboring_slot_index) return [];
      const neighbor = city.regions.find(
        (item) => item.slot_index === connection.neighboring_slot_index,
      );
      return neighbor
        ? [{
            point: xy(connection.point),
          }]
        : [];
    }),
  );
  const buildingSlots = regionRecords.flatMap(({ region }) =>
    region.building_slots,
  );
    mapData = {
      nations,
      cities,
      regions,
      cityLabels,
      regionLabels,
      mobilePlots,
      plotLabels: regionRecords.map(({ city, region }) => ({
        plotKey: `${city.id}:${region.slot_index}`,
        center: region.mobile_plot.center,
        zh_cn_name: `${region.zh_cn_name} · 移动地块`,
      })),
      connections,
      buildingSlots,
    };
    MAP_DATA_CACHE.set(visibleNations, mapData);
  }
  const {
    nations,
    cities,
    regions,
    cityLabels,
    regionLabels,
    mobilePlots,
    plotLabels,
    connections,
    buildingSlots,
  } = mapData;
  const showRegions = labelMode !== "nation" && labelMode !== "city";
  const showPlots = labelMode === "plot" || labelMode === "building";

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
        const gridStep = 1024;
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
      data: { type: "FeatureCollection", features: nations },
      pickable: labelMode === "nation",
      filled: true,
      stroked: true,
      getFillColor: (f) => [
        ...f.properties.color,
        hovered?.kind === "nation" && hovered.id === f.properties.id ? 105 : 47,
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
      data: { type: "FeatureCollection", features: cities },
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
      data: { type: "FeatureCollection", features: regions },
      pickable: labelMode === "region",
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
          new ScatterplotLayer({
            id: "region-connection-points",
            data: connections,
            getPosition: (d) => d.point,
            getFillColor: [128, 220, 200, 230],
            getLineColor: [6, 12, 12, 230],
            getRadius: 2.5,
            radiusUnits: "pixels",
            radiusMinPixels: 2,
            stroked: true,
            lineWidthMinPixels: 0.5,
          }),
          new GeoJsonLayer({
            id: "mobile-plots",
            data: { type: "FeatureCollection", features: mobilePlots },
            pickable: true,
            filled: true,
            stroked: true,
            getFillColor: (feature) =>
              hovered?.kind === "plot" &&
              hovered.regionKey === feature.properties.regionKey
                ? [244, 213, 143, 145]
                : [...feature.properties.color, 32],
            getLineColor: (feature) => [...feature.properties.color, 225],
            getLineWidth: (feature) =>
              hovered?.kind === "plot" &&
              hovered.regionKey === feature.properties.regionKey
                ? 2.8
                : 1.4,
            lineWidthUnits: "pixels",
            lineWidthMinPixels: 1,
            onHover: (info) => onHover(info.object?.properties),
          }),
        ]
      : []),
    ...(labelMode === "building"
      ? [
          new ScatterplotLayer({
            id: "building-slots",
            data: buildingSlots,
            getPosition: (d) => xy(d.center),
            getFillColor: (d) => [...buildingColor(d.building_id), 225],
            getLineColor: [8, 13, 13, 220],
            getRadius: 2.5,
            radiusUnits: "pixels",
            radiusMinPixels: 1.5,
            stroked: true,
            lineWidthMinPixels: 0.5,
          }),
        ]
      : []),
    ...(labelMode === "nation"
      ? [
          new TextLayer({
            id: "nation-labels",
            data: visibleNations,
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
    ...(labelMode === "city"
      ? [
          new TextLayer({
            id: "city-labels",
            data: cityLabels,
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
    ...(labelMode === "region"
      ? [
          new TextLayer({
            id: "region-labels",
            data: regionLabels,
            getPosition: (d) => xy(polygonCenter(d.boundary)),
            getText: (d) => d.zh_cn_name,
            getColor: [224, 226, 211, 235],
            getSize: 10,
            sizeUnits: "pixels",
            fontWeight: 500,
            outlineWidth: 3,
            outlineColor: [5, 10, 10, 240],
            ...FONT,
          }),
        ]
      : []),
    ...(labelMode === "plot"
      ? [
          new TextLayer({
            id: "mobile-plot-labels",
            data: plotLabels,
            getPosition: (d) => xy(d.center),
            getText: (d) => d.zh_cn_name,
            getColor: [244, 221, 169, 240],
            getSize: 10,
            sizeUnits: "pixels",
            fontWeight: 600,
            outlineWidth: 3,
            outlineColor: [5, 10, 10, 240],
            ...FONT,
          }),
        ]
      : []),
  ];
}

const Header = memo(function Header({ layout }) {
  const cities = layout.nations.reduce(
    (sum, nation) => sum + nation.cities.length,
    0,
  );
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" />
        <div>
          <p>TERRA LAYOUT / V9</p>
          <h1>Show Me Terra</h1>
        </div>
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
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [hovered, setHovered] = useState(null);
  const [viewMode, setViewMode] = useState("map");
  const [showTerrainLabels, setShowTerrainLabels] = useState(true);
  const [initialViewState, setInitialViewState] = useState(HOME);
  const [labelMode, setLabelMode] = useState(() => getLabelMode(HOME.zoom));
  const liveView = useRef(HOME);
  const liveViewMode = useRef("map");
  const liveLabelMode = useRef(getLabelMode(HOME.zoom));
  const coordinatesRef = useRef(null);
  const coordinateFrame = useRef(0);
  const hoveredKey = useRef("");

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
    },
    [],
  );

  const visibleNations = useMemo(
    () =>
      layout?.nations.filter(
        (nation) =>
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
              .includes(query)),
      ) ?? [],
    [layout, filter, query],
  );
  const layers = useMemo(
    () =>
      layout
        ? createLayers(layout, visibleNations, hovered, hoverItem, labelMode)
        : [],
    [layout, visibleNations, hovered, hoverItem, labelMode],
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
    return [
      new SimpleMeshLayer({
        id: "terrain-solid-base",
        data: [{}],
        mesh: createTerrainBaseMesh(layout.boundary, heightmap, terrainMetrics),
        _instanced: false,
        getPosition: [0, 0, 0],
        getColor: [190, 193, 193, 255],
        material: {
          ambient: 0.72,
          diffuse: 0.45,
          shininess: 8,
          specularColor: [255, 255, 255],
        },
        pickable: false,
      }),
      new TerrainLayer({
        id: "terra-heightmap",
        operation: "terrain+draw",
        elevationData: versionedAsset("terrain/elevation.png"),
        texture: versionedAsset("terrain/terrain-texture.png"),
        bounds: getTerrainBounds(layout.boundary),
        elevationDecoder: {
          rScaler: 256 * terrainMetrics.scale,
          gScaler: terrainMetrics.scale,
          bScaler: 0,
          offset:
            TERRAIN_BASE_HEIGHT +
            (Math.min(0, Math.floor(heightmap.statistics.minimum_y)) -
              terrainMetrics.min) *
              terrainMetrics.scale,
        },
        meshMaxError: 16,
        color: [210, 213, 213],
        material: {
          ambient: 0.68,
          diffuse: 0.5,
          shininess: 12,
          specularColor: [255, 255, 255],
        },
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
  }, [heightmap, layout, showTerrainLabels, terrainMetrics, viewMode]);
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
    <div id="app">
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
      <Header layout={layout} />
      <div className="view-switch" role="group" aria-label="地图视图">
        <button className={viewMode === "map" ? "active" : ""} onClick={() => switchView("map")}>二维地图</button>
        <button className={viewMode === "terrain" ? "active" : ""} onClick={() => switchView("terrain")}>三维地形</button>
      </div>
      {viewMode === "terrain" && (
        <label className="terrain-label-toggle">
          <input
            type="checkbox"
            checked={showTerrainLabels}
            onChange={(event) => setShowTerrainLabels(event.target.checked)}
          />
          <span>显示国家名称</span>
        </label>
      )}
      {viewMode === "map" && (
        <Explorer
          layout={layout}
          filter={filter}
          setFilter={setFilter}
          query={query}
          setQuery={setQuery}
        />
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
