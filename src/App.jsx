import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DeckGL,
  GeoJsonLayer,
  OrthographicView,
  TextLayer,
  TileLayer,
} from "deck.gl";

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
const HOME = { target: [0, 0, 0], zoom: -6.35, minZoom: -8, maxZoom: 2 };
const CITY_LABEL_ZOOM = -5;
const REGION_LABEL_ZOOM = -3;
const DEVICE_PIXEL_RATIO = Math.min(window.devicePixelRatio || 1, 1.5);
const FONT = {
  fontFamily: '"Noto Sans SC", "Microsoft YaHei", sans-serif',
  fontSettings: { sdf: true, fontSize: 64, buffer: 4 },
  getTextAnchor: "middle",
  getAlignmentBaseline: "center",
  characterSet: "auto",
};
const ORTHO_VIEW = new OrthographicView({ id: "ortho", flipY: false });
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
const getLabelMode = (zoom) =>
  zoom >= REGION_LABEL_ZOOM
    ? "region"
    : zoom >= CITY_LABEL_ZOOM
      ? "city"
      : "nation";
const POLYGON_CENTER_CACHE = new WeakMap();
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

function useTerraData() {
  const [state, setState] = useState({ data: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${import.meta.env.BASE_URL}data/terra_layout.json`, {
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => setState({ data, error: null }))
      .catch((error) => {
        if (error.name !== "AbortError") setState({ data: null, error });
      });
    return () => controller.abort();
  }, []);
  return state;
}

function createLayers(layout, visibleNations, hovered, onHover, labelMode) {
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
      visible: labelMode === "region",
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
          <p>TERRA ARCHIVE / 01</p>
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
  const { data: layout, error } = useTerraData();
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [hovered, setHovered] = useState(null);
  const [initialViewState, setInitialViewState] = useState(HOME);
  const [labelMode, setLabelMode] = useState(() => getLabelMode(HOME.zoom));
  const liveView = useRef(HOME);
  const liveLabelMode = useRef(getLabelMode(HOME.zoom));
  const coordinatesRef = useRef(null);
  const coordinateFrame = useRef(0);
  const hoveredKey = useRef("");

  const setMapView = useCallback((target, zoom) => {
    const next = {
      target: [target[0], target[1], target[2] ?? 0],
      zoom,
      minZoom: HOME.minZoom,
      maxZoom: HOME.maxZoom,
    };
    liveView.current = next;
    const nextMode = getLabelMode(zoom);
    if (nextMode !== liveLabelMode.current) {
      liveLabelMode.current = nextMode;
      setLabelMode(nextMode);
    }
    setInitialViewState(next);
    if (coordinatesRef.current) {
      coordinatesRef.current.textContent = `X ${number(next.target[0])} · Z ${number(-next.target[1])}`;
    }
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
    const nextMode = getLabelMode(zoom);
    if (nextMode !== liveLabelMode.current) {
      liveLabelMode.current = nextMode;
      setLabelMode(nextMode);
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
  const zoomBy = (delta) => {
    const current = liveView.current;
    const zoom = Array.isArray(current.zoom) ? current.zoom[0] : current.zoom;
    setMapView(
      current.target ?? HOME.target,
      Math.max(HOME.minZoom, Math.min(HOME.maxZoom, zoom + delta)),
    );
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
      <div id="map" aria-label="Terra 地图">
        <DeckGL
          views={ORTHO_VIEW}
          initialViewState={initialViewState}
          onViewStateChange={changeView}
          controller={CONTROLLER}
          layers={layers}
          useDevicePixels={DEVICE_PIXEL_RATIO}
          getCursor={GET_CURSOR}
        />
      </div>
      <Header layout={layout} />
      <Explorer
        layout={layout}
        filter={filter}
        setFilter={setFilter}
        query={query}
        setQuery={setQuery}
      />
      <div className="map-tools">
        <button title="放大" onClick={() => zoomBy(0.6)}>
          +
        </button>
        <button title="缩小" onClick={() => zoomBy(-0.6)}>
          −
        </button>
        <button
          title="显示完整地图"
          onClick={() => setMapView(HOME.target, HOME.zoom)}
        >
          ⌖
        </button>
      </div>
      <footer className="statusbar">
        <span className="status-dot" />
        <span>MAP ONLINE</span>
        <span className="divider" />
        <span ref={coordinatesRef}>X 0 · Z 0</span>
        <span className="status-help">拖拽移动 · 滚轮缩放 · 悬停高亮</span>
      </footer>
    </div>
  );
}
