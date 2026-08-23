# Show Me Terra

基于 React 与 deck.gl 的 Minecraft 自定义地图查看器。使用 `OrthographicView` 保持方块坐标的正交关系，以 `TileLayer` 绘制分块底图，并通过 `GeoJsonLayer` 展示国家、城市和城市区域。

地图使用 Terra Layout Schema v14，并采用分级绘制：默认显示国家，放大后依次显示城市、正交 Chunk 地块、城市连接道路、Region 内部主次道路和建筑 Chunk 占地。数据同时包含建筑类型目录、城市地形参数、RegionLayout、移动地块三层结构、街区、Parcel 和建筑名称及朝向。

二维视图支持独立关闭地图文字，并可播放“国家 → 城市 → 区域”的布局形成演示；时间线支持拖动、暂停、继续播放和逐帧预览。
放大到地块层级后，底图会显示 Minecraft 16 × 16 方块的 Chunk 单位网格；区域名称与左侧国家索引不再显示。

地图数据分为轻量概览 `public/data/terra_layout.json` 和 `public/data/terra-nations/` 下的 gzip 国家详情。默认二维地图不会加载或绘制 Region 内部道路与建筑；从顶部“国家详情”选择国家后，页面才请求并解压对应详情文件。

更新上游 v14 数据时，直接同步官方拆分目录：

```bash
npm run data:sync -- <上游 terra_layout 目录> public/data
```

页面支持二维规划地图与 TerrainLayer 三维地形切换。三维资源由 `public/data/heightmap.json` 生成：

三维视图把每个地表 Region 绘制为从城市地表向上 48 方块的基础层；已加载国家详情时，建筑占用 Chunk 会在基础层顶部再增加 16 方块。显示高度会跟随地形高程夸张比例。

```bash
npm run terrain:generate
```

```bash
npm install
npm run dev
```

生产构建使用 `npm run build`。页面读取 `public/data/terra_layout.json`，坐标转换规则为 `[x, -z]`，因此 Minecraft 的负 Z 方向位于画面上方。
