import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const [dataValue = "public/data"] = process.argv.slice(2);
const dataDirectory = path.resolve(dataValue);
const overviewPath = path.join(dataDirectory, "terra_layout.json");
const nationDirectory = path.join(dataDirectory, "terra-nations");
const cityDirectory = path.join(dataDirectory, "terra-cities");

if (!fs.existsSync(overviewPath) || !fs.existsSync(nationDirectory)) {
  throw new Error(`找不到待转换的概览或国家详情: ${dataDirectory}`);
}

const overview = JSON.parse(fs.readFileSync(overviewPath, "utf8"));
if (overview.schema_version !== 16 || !overview.nation_detail_files) {
  throw new Error("需要包含 nation_detail_files 的 Terra Layout v16 概览");
}

const temporaryDirectory = `${cityDirectory}.tmp-${process.pid}`;
fs.rmSync(temporaryDirectory, { recursive: true, force: true });
fs.mkdirSync(temporaryDirectory, { recursive: true });

try {
  const cityDetailFiles = {};
  let totalBytes = 0;
  let cityCount = 0;

  for (const nation of overview.nations) {
    const relativePath = overview.nation_detail_files[nation.id];
    if (!relativePath) throw new Error(`缺少国家详情索引: ${nation.id}`);
    const nationPath = path.join(dataDirectory, relativePath);
    const detail = JSON.parse(zlib.gunzipSync(fs.readFileSync(nationPath)));
    if (detail.schema_version !== 16 || detail.nation?.id !== nation.id) {
      throw new Error(`国家详情数据不匹配: ${nation.id}`);
    }

    const targetNationDirectory = path.join(temporaryDirectory, nation.id);
    fs.mkdirSync(targetNationDirectory, { recursive: true });
    cityDetailFiles[nation.id] = {};
    for (const city of detail.nation.cities) {
      const filename = `${city.id}.json.gz`;
      const compressed = zlib.gzipSync(
        JSON.stringify({
          schema_version: detail.schema_version,
          nation_id: nation.id,
          city,
        }),
        { level: 9 },
      );
      fs.writeFileSync(path.join(targetNationDirectory, filename), compressed);
      cityDetailFiles[nation.id][city.id] =
        `terra-cities/${nation.id}/${filename}`;
      totalBytes += compressed.length;
      cityCount += 1;
    }
  }

  fs.rmSync(cityDirectory, { recursive: true, force: true });
  fs.renameSync(temporaryDirectory, cityDirectory);
  const { nation_detail_files: _legacyFiles, ...currentOverview } = overview;
  fs.writeFileSync(
    overviewPath,
    JSON.stringify({ ...currentOverview, city_detail_files: cityDetailFiles }),
  );
  fs.rmSync(nationDirectory, { recursive: true, force: true });
  console.log(
    `Prepared ${cityCount} gzip city files (${(totalBytes / 1048576).toFixed(1)} MiB)`,
  );
} catch (error) {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  throw error;
}
