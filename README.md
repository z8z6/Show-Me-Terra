# Show Me Terra

基于 React 与 deck.gl 的 Minecraft 自定义地图查看器。使用 `OrthographicView` 保持方块坐标的正交关系，以 `TileLayer` 绘制分块底图，并通过 `GeoJsonLayer` 展示国家、城市和城市区域。

地图采用分级标签：默认仅显示国家名称，放大后显示城市名称，继续放大后显示城市内部区域名称。

```bash
npm install
npm run dev
```

生产构建使用 `npm run build`。页面读取 `public/data/terra_layout.json`，坐标转换规则为 `[x, -z]`，因此 Minecraft 的负 Z 方向位于画面上方。
