/* offscreen.js — PaddleOCR PP-OCRv4 via ONNX Runtime Web */

let detSession = null;
let recSession = null;
let dictionary = null;
let initPromise = null;

/* ---------- Keepalive port ---------- */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "keepalive") {
    port.onDisconnect.addListener(() => {});
  }
});

/* ---------- Message handler ---------- */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") return;

  const handlers = {
    PROCESS_OCR: () => processOcr(message.payload),
    CROP_IMAGE: () => cropImage(message.payload),
    STITCH_IMAGES: () => stitchImages(message.payload),
  };

  const handler = handlers[message.type];
  if (!handler) return;

  handler()
    .then((result) => sendResponse(result))
    .catch((error) => {
      console.error("[OCR offscreen] failed:", error);
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return true;
});

/* ========== Model initialization ========== */

async function ensureModels() {
  if (detSession && recSession && dictionary) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    // Configure ONNX Runtime WASM paths for Chrome extension
    const wasmDir = chrome.runtime.getURL(
      "node_modules/onnxruntime-web/dist/"
    );
    ort.env.wasm.wasmPaths = wasmDir;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;

    console.debug("[OCR] Loading PP-OCRv4 models...");

    const [detBuf, recBuf, dictText] = await Promise.all([
      fetch(chrome.runtime.getURL("models/ch_PP-OCRv4_det.onnx")).then((r) =>
        r.arrayBuffer()
      ),
      fetch(chrome.runtime.getURL("models/ch_PP-OCRv4_rec.onnx")).then((r) =>
        r.arrayBuffer()
      ),
      fetch(chrome.runtime.getURL("models/ppocr_keys_v1.txt")).then((r) =>
        r.text()
      ),
    ]);

    const opts = {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    };

    [detSession, recSession] = await Promise.all([
      ort.InferenceSession.create(detBuf, opts),
      ort.InferenceSession.create(recBuf, opts),
    ]);

    // Dictionary: index 0 = blank (CTC), then one char per line, add space at end
    dictionary = [""].concat(dictText.split("\n").filter(Boolean));
    dictionary.push(" ");

    console.debug(
      "[OCR] Models loaded. Dict size:",
      dictionary.length
    );
  })();

  return initPromise;
}

/* ========== Main OCR pipeline ========== */

async function processOcr(payload) {
  const startedAt = performance.now();
  await ensureModels();

  const bitmap = await loadBitmap(payload.imageDataUrl);
  const { width, height } = bitmap;

  // Step 1: Text detection — find text regions
  const boxes = await detectText(bitmap);

  if (boxes.length === 0) {
    // Fallback: try recognizing the entire image as one text block
    const fallback = await recognizeSingle(bitmap, [0, 0, width, height]);
    return {
      ok: true,
      text: fallback.text || "",
      blocks: fallback.text ? [fallback] : [],
      engine: "ppocr-v4",
      previewImageDataUrl: null,
      meta: {
        width,
        height,
        elapsedMs: Math.round(performance.now() - startedAt),
      },
    };
  }

  // Step 2: Recognize text in each detected region
  const results = await recognizeTexts(bitmap, boxes);

  const fullText = results.map((r) => r.text).join("\n");
  const blocks = results.map((r) => ({
    text: r.text,
    confidence: r.confidence,
    bbox: r.bbox,
  }));

  return {
    ok: true,
    text: fullText,
    blocks,
    engine: "ppocr-v4",
    previewImageDataUrl: null,
    meta: {
      width,
      height,
      elapsedMs: Math.round(performance.now() - startedAt),
    },
  };
}

/* ========== Detection ========== */

async function detectText(bitmap) {
  const { width, height } = bitmap;

  // Resize so longest side ≤ 1280, dimensions multiples of 32
  const maxSide = 1280;
  let scale = 1;
  if (Math.max(width, height) > maxSide) {
    scale = maxSide / Math.max(width, height);
  }
  let newW = Math.max(32, Math.ceil(Math.round(width * scale) / 32) * 32);
  let newH = Math.max(32, Math.ceil(Math.round(height * scale) / 32) * 32);

  const canvas = new OffscreenCanvas(newW, newH);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, newW, newH);
  const imageData = ctx.getImageData(0, 0, newW, newH);

  // Normalize with ImageNet mean/std → CHW float32
  const input = normalizeImageNet(imageData, newW, newH);

  const tensor = new ort.Tensor("float32", input, [1, 3, newH, newW]);
  const feeds = {};
  feeds[detSession.inputNames[0]] = tensor;
  const output = await detSession.run(feeds);
  const probMap = output[detSession.outputNames[0]].data;

  return postProcessDetection(probMap, newW, newH, width, height);
}

function normalizeImageNet(imageData, w, h) {
  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];
  const px = imageData.data;
  const chw = new Float32Array(3 * h * w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4;
      const dst = y * w + x;
      chw[dst] = (px[src] / 255 - mean[0]) / std[0];
      chw[h * w + dst] = (px[src + 1] / 255 - mean[1]) / std[1];
      chw[2 * h * w + dst] = (px[src + 2] / 255 - mean[2]) / std[2];
    }
  }
  return chw;
}

/* ========== Detection post-processing ========== */

function postProcessDetection(probMap, mapW, mapH, origW, origH) {
  const threshold = 0.3;
  const minBoxArea = 16;
  const scaleX = origW / mapW;
  const scaleY = origH / mapH;

  // Binary threshold
  const N = mapW * mapH;
  const binary = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    binary[i] = probMap[i] > threshold ? 1 : 0;
  }

  // Connected-component labeling (BFS with index queue for speed)
  const labels = new Int32Array(N);
  const queue = new Int32Array(N); // reusable queue
  const rawBoxes = [];

  for (let y = 0; y < mapH; y++) {
    for (let x = 0; x < mapW; x++) {
      const idx = y * mapW + x;
      if (binary[idx] !== 1 || labels[idx] !== 0) continue;

      // BFS flood fill
      let head = 0,
        tail = 0;
      queue[tail++] = idx;
      labels[idx] = rawBoxes.length + 1;
      let minX = x,
        maxX = x,
        minY = y,
        maxY = y;

      while (head < tail) {
        const ci = queue[head++];
        const cx = ci % mapW;
        const cy = (ci - cx) / mapW;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        // 4-connected neighbors
        const neighbors = [ci - 1, ci + 1, ci - mapW, ci + mapW];
        const validX = [cx > 0, cx < mapW - 1, true, true];
        const validY = [true, true, cy > 0, cy < mapH - 1];
        for (let n = 0; n < 4; n++) {
          if (validX[n] && validY[n]) {
            const ni = neighbors[n];
            if (binary[ni] === 1 && labels[ni] === 0) {
              labels[ni] = rawBoxes.length + 1;
              queue[tail++] = ni;
            }
          }
        }
      }

      const boxW = maxX - minX + 1;
      const boxH = maxY - minY + 1;
      if (boxW * boxH >= minBoxArea) {
        // Unclip: expand detected region like PaddleOCR's DBNet post-processing
        // Formula: distance = area * unclip_ratio / perimeter
        const unclipRatio = 1.5;
        const perimeter = 2 * (boxW + boxH);
        const distance = (boxW * boxH * unclipRatio) / perimeter;
        const padX = Math.max(3, Math.round(distance));
        const padY = Math.max(3, Math.round(distance));

        rawBoxes.push([
          Math.max(0, Math.round((minX - padX) * scaleX)),
          Math.max(0, Math.round((minY - padY) * scaleY)),
          Math.min(origW, Math.round((maxX + 1 + padX) * scaleX)),
          Math.min(origH, Math.round((maxY + 1 + padY) * scaleY)),
        ]);
      }
    }
  }

  // Merge overlapping / close boxes on the same line
  const merged = mergeBoxes(rawBoxes);

  // Sort top-to-bottom, then left-to-right
  merged.sort((a, b) => {
    const yDiff = a[1] - b[1];
    if (Math.abs(yDiff) > Math.min((a[3] - a[1]) / 2, (b[3] - b[1]) / 2))
      return yDiff;
    return a[0] - b[0];
  });

  return merged;
}

function mergeBoxes(boxes) {
  if (boxes.length <= 1) return boxes;

  // Sort by Y then X for merging pass
  boxes.sort((a, b) => a[1] - b[1] || a[0] - b[0]);

  const merged = [];
  const used = new Uint8Array(boxes.length);

  for (let i = 0; i < boxes.length; i++) {
    if (used[i]) continue;
    let [x1, y1, x2, y2] = boxes[i];
    used[i] = 1;

    // Try to merge with subsequent boxes that overlap vertically
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = i + 1; j < boxes.length; j++) {
        if (used[j]) continue;
        const [bx1, by1, bx2, by2] = boxes[j];

        // Check vertical overlap
        const overlapY = Math.min(y2, by2) - Math.max(y1, by1);
        const minH = Math.min(y2 - y1, by2 - by1);
        if (overlapY < minH * 0.5) continue;

        // Check horizontal proximity (gap < half of average height)
        const avgH = ((y2 - y1) + (by2 - by1)) / 2;
        const gap = Math.max(0, Math.max(x1, bx1) - Math.min(x2, bx2));
        if (gap > avgH * 0.5) continue;

        // Merge
        x1 = Math.min(x1, bx1);
        y1 = Math.min(y1, by1);
        x2 = Math.max(x2, bx2);
        y2 = Math.max(y2, by2);
        used[j] = 1;
        changed = true;
      }
    }

    merged.push([x1, y1, x2, y2]);
  }

  return merged;
}

/* ========== Recognition ========== */

async function recognizeSingle(bitmap, box) {
  const results = await recognizeTexts(bitmap, [box]);
  return results[0] || { text: "", confidence: 0, bbox: box };
}

async function recognizeTexts(bitmap, boxes) {
  const REC_H = 48;
  const results = [];

  for (const box of boxes) {
    const [x1, y1, x2, y2] = box;
    const bw = x2 - x1;
    const bh = y2 - y1;
    if (bw < 2 || bh < 2) continue;

    // Crop text region
    const cropCanvas = new OffscreenCanvas(bw, bh);
    const cropCtx = cropCanvas.getContext("2d");
    cropCtx.drawImage(bitmap, x1, y1, bw, bh, 0, 0, bw, bh);

    // Resize to height REC_H, keep aspect ratio, pad to min width
    const ratio = REC_H / bh;
    const recW = Math.max(1, Math.round(bw * ratio));
    const padW = Math.max(recW, 48);

    const recCanvas = new OffscreenCanvas(padW, REC_H);
    const recCtx = recCanvas.getContext("2d");
    recCtx.fillStyle = "#fff";
    recCtx.fillRect(0, 0, padW, REC_H);
    recCtx.drawImage(cropCanvas, 0, 0, bw, bh, 0, 0, recW, REC_H);

    const imageData = recCtx.getImageData(0, 0, padW, REC_H);
    const input = normalizeRec(imageData, padW, REC_H);

    const tensor = new ort.Tensor("float32", input, [1, 3, REC_H, padW]);
    const feeds = {};
    feeds[recSession.inputNames[0]] = tensor;
    const output = await recSession.run(feeds);
    const outTensor = output[recSession.outputNames[0]];

    const { text, confidence } = ctcDecode(outTensor.data, outTensor.dims);

    if (text.trim()) {
      results.push({
        text: text.trim(),
        confidence: Math.round(confidence * 100) / 100,
        bbox: box,
      });
    }
  }

  return results;
}

function normalizeRec(imageData, w, h) {
  // PP-OCR rec normalization: (pixel/255 - 0.5) / 0.5
  const px = imageData.data;
  const chw = new Float32Array(3 * h * w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4;
      const dst = y * w + x;
      chw[dst] = (px[src] / 255 - 0.5) / 0.5;
      chw[h * w + dst] = (px[src + 1] / 255 - 0.5) / 0.5;
      chw[2 * h * w + dst] = (px[src + 2] / 255 - 0.5) / 0.5;
    }
  }
  return chw;
}

/* ========== CTC decoding ========== */

function ctcDecode(data, dims) {
  // dims: [1, seqLen, numClasses]  — output is log-softmax or softmax
  const seqLen = dims[1];
  const numClasses = dims[2];

  let text = "";
  let confSum = 0;
  let charCount = 0;
  let lastIdx = 0; // 0 = CTC blank

  for (let t = 0; t < seqLen; t++) {
    const offset = t * numClasses;

    // Find argmax and its value
    let maxIdx = 0;
    let maxVal = data[offset];
    for (let c = 1; c < numClasses; c++) {
      if (data[offset + c] > maxVal) {
        maxVal = data[offset + c];
        maxIdx = c;
      }
    }

    // CTC rule: skip blank (0) and repeated chars
    if (maxIdx !== 0 && maxIdx !== lastIdx) {
      if (maxIdx < dictionary.length) {
        text += dictionary[maxIdx];
        // Softmax confidence (maxVal might be logit or probability)
        const prob = maxVal > 0 && maxVal < 1 ? maxVal : 1 / (1 + Math.exp(-maxVal));
        confSum += prob;
        charCount++;
      }
    }
    lastIdx = maxIdx;
  }

  const confidence = charCount > 0 ? confSum / charCount : 0;
  return { text, confidence };
}

/* ========== Image helpers ========== */

async function loadBitmap(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return createImageBitmap(blob);
}

/* ---------- Crop image for selection mode ---------- */

async function cropImage(payload) {
  const { imageDataUrl, rect, dpr } = payload;
  const bitmap = await loadBitmap(imageDataUrl);

  const sx = Math.round(rect.x * dpr);
  const sy = Math.round(rect.y * dpr);
  const sw = Math.round(rect.width * dpr);
  const sh = Math.round(rect.height * dpr);

  const cw = Math.min(sw, bitmap.width - sx);
  const ch = Math.min(sh, bitmap.height - sy);

  if (cw <= 0 || ch <= 0) {
    return { ok: false, error: "Selected area is empty." };
  }

  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, sx, sy, cw, ch, 0, 0, cw, ch);

  return { ok: true, croppedDataUrl: canvas.toDataURL("image/png") };
}

/* ---------- Stitch images for fullpage mode ---------- */

async function stitchImages(payload) {
  const { segments, totalWidth, totalHeight } = payload;

  const canvas = document.createElement("canvas");
  canvas.width = totalWidth;
  canvas.height = totalHeight;
  const ctx = canvas.getContext("2d");

  for (const seg of segments) {
    const bitmap = await loadBitmap(seg.dataUrl);
    ctx.drawImage(bitmap, 0, seg.yOffset, totalWidth, bitmap.height);
  }

  return { ok: true, stitchedDataUrl: canvas.toDataURL("image/png") };
}
