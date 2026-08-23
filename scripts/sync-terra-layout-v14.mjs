import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const [sourceValue, targetValue] = process.argv.slice(2);
if (!sourceValue || !targetValue) {
  throw new Error(
    "用法: node scripts/sync-terra-layout-v14.mjs <upstream-terra-layout-directory> <target-data-directory>",
  );
}

const sourceDirectory = path.resolve(sourceValue);
const targetDirectory = path.resolve(targetValue);
const sourceIndexPath = path.join(sourceDirectory, "index.json.gz");
const sourceNationDirectory = path.join(sourceDirectory, "nations");
const targetNationDirectory = path.join(targetDirectory, "terra-nations");

if (!fs.existsSync(sourceIndexPath) || !fs.existsSync(sourceNationDirectory)) {
  throw new Error(`找不到 Terra Layout v14 拆分资源: ${sourceDirectory}`);
}

const readGzipJson = (filename) =>
  JSON.parse(zlib.gunzipSync(fs.readFileSync(filename)));
const index = readGzipJson(sourceIndexPath);
if (index.schema_version !== 14 || !Array.isArray(index.nation_ids)) {
  throw new Error(`需要 Terra Layout v14，实际为 v${index.schema_version}`);
}

const nationFiles = index.nation_ids.map((nationId) => ({
  nationId,
  sourcePath: path.join(sourceNationDirectory, `${nationId}.json.gz`),
}));
for (const item of nationFiles) {
  if (!fs.existsSync(item.sourcePath))
    throw new Error(`缺少国家数据: ${item.nationId}`);
}

fs.rmSync(targetNationDirectory, { recursive: true, force: true });
fs.mkdirSync(targetNationDirectory, { recursive: true });

const nationDetailFiles = {};
const nations = nationFiles.map(({ nationId, sourcePath }) => {
  const detail = readGzipJson(sourcePath);
  if (detail.schema_version !== 14 || detail.nation?.id !== nationId) {
    throw new Error(`国家详情数据不匹配: ${nationId}`);
  }

  const filename = `${nationId}.json.gz`;
  fs.copyFileSync(sourcePath, path.join(targetNationDirectory, filename));
  nationDetailFiles[nationId] = `terra-nations/${filename}`;

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
  nation_detail_files: nationDetailFiles,
  nations,
};
const overviewPath = path.join(targetDirectory, "terra_layout.json");
fs.mkdirSync(targetDirectory, { recursive: true });
fs.writeFileSync(overviewPath, JSON.stringify(overview));

const detailBytes = fs
  .readdirSync(targetNationDirectory)
  .reduce(
    (total, filename) =>
      total + fs.statSync(path.join(targetNationDirectory, filename)).size,
    0,
  );
console.log(
  `Terra Layout v14 synced: overview ${(fs.statSync(overviewPath).size / 1048576).toFixed(1)} MiB, ` +
    `${nations.length} gzip nation files ${(detailBytes / 1048576).toFixed(1)} MiB`,
);
