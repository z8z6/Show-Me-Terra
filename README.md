# Show Me Terra

基于 React 与 deck.gl 的 Minecraft 自定义地图查看器。使用 `OrthographicView` 保持方块坐标的正交关系，以 `TileLayer` 绘制分块底图，并通过 `GeoJsonLayer` 展示国家、城市和城市区域。

地图使用 Terra Layout Schema v9，并采用分级绘制：默认显示国家，放大后依次显示城市、区域、区域连接、移动地块和建筑候选槽位。

页面支持二维规划地图与 TerrainLayer 三维地形切换。三维资源由 `public/data/heightmap.json` 生成：

```bash
npm run terrain:generate
```

```bash
npm install
npm run dev
```

生产构建使用 `npm run build`。页面读取 `public/data/terra_layout.json`，坐标转换规则为 `[x, -z]`，因此 Minecraft 的负 Z 方向位于画面上方。
