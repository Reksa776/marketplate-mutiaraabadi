import sharp from "sharp";
import { createWorker, OEM } from "tesseract.js";
import { createRequire } from "node:module";
import path from "node:path";

const req = createRequire(path.join(process.cwd(), "noop.js"));
const CORE_DIR = path.dirname(req.resolve("tesseract.js-core/package.json"));
const DIST_WORKER = req.resolve("tesseract.js/dist/worker.min.js");

const svg = `<svg width="900" height="240" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="white"/>
  <text x="20" y="160" font-family="monospace" font-size="120" fill="black">JNE1234567890</text>
  <text x="20" y="40" font-family="monospace" font-size="60" fill="black">ORDER: ORD-1745012345678-abc12345</text>
</svg>`;
const png = await sharp(Buffer.from(svg)).png().toBuffer();
console.log("PNG bytes:", png.length);

async function run(label, options) {
  const t0 = Date.now();
  let worker = null;
  try {
    worker = await createWorker("eng", OEM.LSTM_ONLY, options);
    const { data } = await worker.recognize(png);
    const ms = Date.now() - t0;
    const text = (data.text || "").replace(/\s+/g, " ").trim();
    console.log(`[${label}] OK in ${ms}ms`);
    console.log(`  text: ${text.slice(0, 140)}`);
    console.log(`  has JNE1234567890: ${text.includes("JNE1234567890")}`);
  } catch (e) {
    console.log(`[${label}] FAILED: ${e?.message}`);
  } finally {
    if (worker) { try { await worker.terminate(); } catch {} }
  }
}

console.log("=== TEST A: default node worker ===");
await run("default", {});
console.log("=== TEST B: public dist worker + core dir mode ===");
await run("dist+core", { workerPath: DIST_WORKER, corePath: CORE_DIR });
