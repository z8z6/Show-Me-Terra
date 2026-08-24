import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const [sourceValue, targetValue] = process.argv.slice(2);
if (!sourceValue || !targetValue) {
  throw new Error(
    "用法: node scripts/sync-terra-layout-v16.mjs <upstream-terra-layout-directory> <target-data-directory>",
  );
}

const sourceDirectory = path.resolve(sourceValue);
const targetDirectory = path.resolve(targetValue);
const sourceIndexPath = path.join(sourceDirectory, "index.json.gz");
const sourceNationDirectory = path.join(sourceDirectory, "nations");
const targetCityDirectory = path.join(targetDirectory, "terra-cities");
const legacyTargetNationDirectory = path.join(targetDirectory, "terra-nations");

if (!fs.existsSync(sourceIndexPath) || !fs.existsSync(sourceNationDirectory)) {
  throw new Error(`找不到 Terra Layout v16 拆分资源: ${sourceDirectory}`);
}

const readGzipJson = (filename) =>
  JSON.parse(zlib.gunzipSync(fs.readFileSync(filename)));
const requiredMobileLayers = ["power", "support", "life", "surface"];
const index = readGzipJson(sourceIndexPath);
if (index.schema_version !== 16 || !Array.isArray(index.nation_ids)) {
  throw new Error(`需要 Terra Layout v16，实际为 v${index.schema_version}`);
}

const nationFiles = index.nation_ids.map((nationId) => ({
  nationId,
  sourcePath: path.join(sourceNationDirectory, `${nationId}.json.gz`),
}));
for (const item of nationFiles) {
  if (!fs.existsSync(item.sourcePath))
    throw new Error(`缺少国家数据: ${item.nationId}`);
}

fs.rmSync(targetCityDirectory, { recursive: true, force: true });
fs.mkdirSync(targetCityDirectory, { recursive: true });

const cityDetailFiles = {};
const nations = nationFiles.map(({ nationId, sourcePath }) => {
  const detail = readGzipJson(sourcePath);
  if (detail.schema_version !== 16 || detail.nation?.id !== nationId) {
    throw new Error(`国家详情数据不匹配: ${nationId}`);
  }
  for (const city of detail.nation.cities) {
    for (const region of city.regions) {
      const layerNames = region.region_layout?.mobile_layers?.map(
        (layer) => layer.layer,
      );
      if (
        !layerNames ||
        layerNames.length !== requiredMobileLayers.length ||
        !requiredMobileLayers.every((name) => layerNames.includes(name))
      ) {
        throw new Error(`Region 四层布局不完整: ${city.id}/${region.id}`);
      }
      const expectedStairs = region.region_layout.mobile_layers[0].stair_chunks;
      if (!Array.isArray(expectedStairs) || expectedStairs.length < 4) {
        throw new Error(`Region 楼梯数量不足: ${city.id}/${region.id}`);
      }
      const expectedCoordinates = expectedStairs
        .map(({ chunk_x, chunk_z }) => `${chunk_x}:${chunk_z}`)
        .sort()
        .join(",");
      for (const layer of region.region_layout.mobile_layers) {
        const coordinates = layer.stair_chunks
          ?.map(({ chunk_x, chunk_z }) => `${chunk_x}:${chunk_z}`)
          .sort()
          .join(",");
        if (
          coordinates !== expectedCoordinates ||
          !Array.isArray(layer.road_junctions)
        ) {
          throw new Error(`Region v16 分层数据无效: ${city.id}/${region.id}`);
        }
      }
    }
  }

  const nationCityDirectory = path.join(targetCityDirectory, nationId);
  fs.mkdirSync(nationCityDirectory, { recursive: true });
  cityDetailFiles[nationId] = {};
  for (const city of detail.nation.cities) {
    const filename = `${city.id}.json.gz`;
    const payload = {
      schema_version: detail.schema_version,
      nation_id: nationId,
      city,
    };
    fs.writeFileSync(
      path.join(nationCityDirectory, filename),
      zlib.gzipSync(JSON.stringify(payload), { level: 9 }),
    );
    cityDetailFiles[nationId][city.id] =
      `terra-cities/${nationId}/${filename}`;
  }

  return {
    ...detail.nation,
    cities: detail.nation.cities.map((city) => ({
      ...city,
      regions: city.regions.map(
        ({ region_layout, building_slots, connections, ...region }) => region,
      ),
    })),
  };
});

const overview = {
  ...index,
  city_detail_files: cityDetailFiles,
  nations,
};
const overviewPath = path.join(targetDirectory, "terra_layout.json");
fs.mkdirSync(targetDirectory, { recursive: true });
fs.writeFileSync(overviewPath, JSON.stringify(overview));
fs.rmSync(legacyTargetNationDirectory, { recursive: true, force: true });

const detailBytes = fs
  .readdirSync(targetCityDirectory, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .reduce((total, entry) => total + fs.statSync(path.join(entry.parentPath, entry.name)).size, 0);
const cityCount = Object.values(cityDetailFiles).reduce(
  (total, files) => total + Object.keys(files).length,
  0,
);
console.log(
  `Terra Layout v16 synced: overview ${(fs.statSync(overviewPath).size / 1048576).toFixed(1)} MiB, ` +
    `${cityCount} gzip city files ${(detailBytes / 1048576).toFixed(1)} MiB`,
);
