// Usage: node scripts/ply-to-spz.mjs <in.ply> <out.spz>
// Stand-in for the future Python preprocessing step.
import fs from "node:fs";
import { transcodeSpz } from "@sparkjsdev/spark";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("Usage: node scripts/ply-to-spz.mjs <in.ply> <out.spz>");
  process.exit(1);
}

const fileBytes = new Uint8Array(fs.readFileSync(input));
const { fileBytes: spz, clippedCount } = await transcodeSpz({
  inputs: [{ fileBytes, pathOrUrl: input }],
  version: 2,
});
fs.writeFileSync(output, spz);
console.log(`${input} -> ${output}: ${(fileBytes.length / 1e6).toFixed(1)} MB -> ${(spz.length / 1e6).toFixed(1)} MB, clipped ${clippedCount}`);
