import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { constants, brotliCompressSync } from "node:zlib";

// Decision 92 and the page's architecture: what every link downloads before it shows anything.
const SCRIPTS_AT_MOST = 48_000;
// The quality Cloudflare was measured to use.
const BROTLI_QUALITY = 4;
const ASSETS = "dist/page/assets";
// A word only the sample has: it is for building the frame, and it must not reach anyone.
const ONLY_IN_THE_SAMPLE = "Camila";
// A word only the whole contract has: the page takes its light entry, and the whole one would still fit under the limit.
const ONLY_IN_THE_WHOLE_CONTRACT = "reader_refuses";

const squeezed = (data) =>
  brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } }).length;

const files = readdirSync(ASSETS).map((name) => ({ name, data: readFileSync(join(ASSETS, name)) }));
const scripts = files.filter(({ name }) => name.endsWith(".js"));
if (scripts.length === 0) {
  console.error("x  no scripts were built: run npm run build first");
  process.exit(1);
}

for (const { name, data } of files) console.log(`${String(squeezed(data)).padStart(7)}  ${name}`);
const total = scripts.reduce((sum, { data }) => sum + squeezed(data), 0);
console.log(`${String(total).padStart(7)}  scripts, of ${SCRIPTS_AT_MOST}`);

if (scripts.some(({ data }) => data.includes(ONLY_IN_THE_SAMPLE))) {
  console.error("x  the sample document was built into the page");
  process.exit(1);
}
if (scripts.some(({ data }) => data.includes(ONLY_IN_THE_WHOLE_CONTRACT))) {
  console.error("x  the whole contract was built into the page, and not its check entry");
  process.exit(1);
}
if (!existsSync("dist/page/licenses.txt")) {
  console.error("x  DOMPurify's licenses do not go with the page");
  process.exit(1);
}
if (!readFileSync("dist/page/licenses.txt", "utf8").includes("@tisty/contracts")) {
  console.error("x  the contract's license does not go with the page");
  process.exit(1);
}
if (total > SCRIPTS_AT_MOST) {
  console.error(`x  the scripts are ${total} bytes with brotli, past ${SCRIPTS_AT_MOST}`);
  process.exit(1);
}
