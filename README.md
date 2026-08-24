# Show Me Terra

基于 React 与 deck.gl 的 Minecraft 自定义地图查看器。使用 `OrthographicView` 保持方块坐标的正交关系，以 `TileLayer` 绘制分块底图，并通过 `GeoJsonLayer` 展示国家、城市和城市区域。

地图使用 Terra Layout Schema v16，并采用分级绘制：默认显示国家，放大后依次显示城市、正交 Chunk 地块、城市连接道路、Region 内部主次道路和建筑 Chunk 占地。Region 权威布局来自 `mobile_layers`，包含 `power`、`support`、`life` 和 `surface` 四个独立道路与 Parcel 层。每层使用权威 `road_junctions` 路口掩码，并显示四层对齐的多组楼梯。

二维视图的右侧缩放控件下方提供多层图标，可在动力、支持、生活和地表四层之间切换，每次单独显示当前层的道路与 Parcel。建筑级别不再显示 Region 悬停高亮；双击 Region 会将界面平分，在右侧打开该 Region 的四层侧视图，不改变左侧地图焦点。建筑级别的右下角图例统一说明商店、车站、塔楼、宗教、矿业等建筑类型，地图占地上不再叠加图标。视图支持独立关闭地图文字，并可播放“国家 → 城市 → 区域”的布局形成演示；紧凑时间线位于左下角，支持拖动、暂停、继续播放和逐帧预览。
放大到地块层级后，底图会显示 Minecraft 16 × 16 方块的 Chunk 单位网格；区域名称与左侧国家索引不再显示。

地图数据分为轻量概览 `public/data/terra_layout.json` 和 `public/data/terra-nations/` 下的 gzip 国家详情。默认二维地图不加载 Region 内部道路与建筑；放大到地块层级后，页面根据视口中心判断当前所在国家，只请求并解压该国详情。鼠标移到界面按钮不会卸载建筑。

更新上游 v16 数据时，直接同步官方拆分目录：

```bash
npm run data:sync -- <上游 terra_layout 目录> public/data
```

页面支持二维规划地图、TerrainLayer 三维地形和四层侧视图切换。侧视图以进入时视口中心所在 Region 为对象，同时展开四层街区、窄矩形道路和垂直楼梯。三维资源由 `public/data/heightmap.json` 生成：

三维视图保持简化绘制：每个地表 Region 从城市地表向上绘制 48 方块的基础体块，不展开四层 Parcel 细节。显示高度会跟随地形高程夸张比例。

```bash
npm run terrain:generate
```

```bash
npm install
npm run dev
```

生产构建使用 `npm run build`。页面读取 `public/data/terra_layout.json`，坐标转换规则为 `[x, -z]`，因此 Minecraft 的负 Z 方向位于画面上方。
