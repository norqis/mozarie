let source = null;
let sourceId = "";
let sourceCanvas = null;
let sourceContext = null;
let sourcePixels = null;
let sourceWidth = 0;
let sourceHeight = 0;
let maskCanvas = null;
let maskContext = null;
let outputCanvas = null;
let outputContext = null;

function releaseScratch() {
  for (const canvas of [maskCanvas, outputCanvas]) if (canvas) canvas.width = canvas.height = 1;
  maskCanvas = null; maskContext = null; outputCanvas = null; outputContext = null;
}

function releaseSource() {
  source?.close?.();
  source = null; sourceId = "";
  if (sourceCanvas) sourceCanvas.width = sourceCanvas.height = 1;
  sourceCanvas = null; sourceContext = null; sourcePixels = null; sourceWidth = 0; sourceHeight = 0; releaseScratch();
}

function fail(generation, failedSourceId = sourceId) { self.postMessage({ type: "error", code: "mosaic_preview_failed", sourceId: failedSourceId, generation }); }

function render({ mask, width, height, blockSize, generation }) {
  try {
    if (!sourcePixels || !mask || sourceWidth !== width || sourceHeight !== height) throw new Error("invalid render state");
    // Scratch canvases are released after every response, so there is no
    // reusable allocation to resize here.  Allocate the frame-local pair
    // directly; this keeps the worker's memory plateau explicit.
    maskCanvas = new OffscreenCanvas(width, height); maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });
    outputCanvas = new OffscreenCanvas(width, height); outputContext = outputCanvas.getContext("2d");
    if (!maskContext || !outputContext) throw new Error("2d context unavailable");
    const pixels = sourcePixels;
    maskContext.clearRect(0, 0, width, height); maskContext.drawImage(mask, 0, 0);
    const alphaPixels = maskContext.getImageData(0, 0, width, height).data;
    const output = new Uint8ClampedArray(pixels);
    let minX = width; let minY = height; let maxX = -1; let maxY = -1;
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      if (!alphaPixels[(y * width + x) * 4 + 3]) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    if (maxX >= 0) {
      const firstTop = Math.floor(minY / blockSize) * blockSize;
      const firstLeft = Math.floor(minX / blockSize) * blockSize;
      const lastTop = Math.floor(maxY / blockSize) * blockSize;
      const lastLeft = Math.floor(maxX / blockSize) * blockSize;
      for (let top = firstTop; top <= lastTop; top += blockSize) for (let left = firstLeft; left <= lastLeft; left += blockSize) {
      const bottom = Math.min(height, top + blockSize); const right = Math.min(width, left + blockSize);
      let count = 0; let red = 0; let green = 0; let blue = 0; let weight = 0;
      for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
        const pixel = y * width + x; if (!alphaPixels[pixel * 4 + 3]) continue;
        const index = pixel * 4; count += 1; const a = pixels[index + 3];
        red += pixels[index] * a; green += pixels[index + 1] * a; blue += pixels[index + 2] * a; weight += a;
      }
      if (!count) continue;
      const rgb = weight ? [Math.floor((red + Math.floor(weight / 2)) / weight), Math.floor((green + Math.floor(weight / 2)) / weight), Math.floor((blue + Math.floor(weight / 2)) / weight)] : null;
      for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
        const pixel = y * width + x; if (!alphaPixels[pixel * 4 + 3] || !rgb) continue; const index = pixel * 4;
        output[index] = rgb[0]; output[index + 1] = rgb[1]; output[index + 2] = rgb[2];
      }
      }
    }
    outputContext.putImageData(new ImageData(output, width, height), 0, 0);
    const frame = outputCanvas.transferToImageBitmap();
    try { self.postMessage({ type: "frame", sourceId, generation, output: frame }, [frame]); }
    catch { frame.close?.(); fail(generation); }
  } catch { fail(generation); } finally { mask?.close?.(); releaseScratch(); }
}

function renderPatch({ mask, left, top, width, height, blockSize, generation }) {
  try {
    if (!sourcePixels || !mask || left < 0 || top < 0 || left + width > sourceWidth || top + height > sourceHeight) throw new Error("invalid patch render state");
    maskCanvas = new OffscreenCanvas(width, height); maskContext = maskCanvas.getContext("2d", { willReadFrequently: true });
    outputCanvas = new OffscreenCanvas(width, height); outputContext = outputCanvas.getContext("2d");
    if (!maskContext || !outputContext) throw new Error("2d context unavailable");
    maskContext.clearRect(0, 0, width, height); maskContext.drawImage(mask, 0, 0);
    const alphaPixels = maskContext.getImageData(0, 0, width, height).data;
    const output = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      const sourceStart = ((top + y) * sourceWidth + left) * 4;
      output.set(sourcePixels.subarray(sourceStart, sourceStart + width * 4), y * width * 4);
    }
    for (let blockTop = top; blockTop < top + height; blockTop += blockSize) for (let blockLeft = left; blockLeft < left + width; blockLeft += blockSize) {
      const bottom = Math.min(sourceHeight, blockTop + blockSize); const right = Math.min(sourceWidth, blockLeft + blockSize);
      let count = 0; let red = 0; let green = 0; let blue = 0; let weight = 0;
      for (let y = blockTop; y < bottom; y += 1) for (let x = blockLeft; x < right; x += 1) {
        const patchIndex = ((y - top) * width + (x - left)) * 4;
        if (!alphaPixels[patchIndex + 3]) continue;
        const index = (y * sourceWidth + x) * 4; count += 1; const a = sourcePixels[index + 3];
        red += sourcePixels[index] * a; green += sourcePixels[index + 1] * a; blue += sourcePixels[index + 2] * a; weight += a;
      }
      if (!count || !weight) continue;
      const rgb = [Math.floor((red + Math.floor(weight / 2)) / weight), Math.floor((green + Math.floor(weight / 2)) / weight), Math.floor((blue + Math.floor(weight / 2)) / weight)];
      for (let y = blockTop; y < bottom; y += 1) for (let x = blockLeft; x < right; x += 1) {
        const patchIndex = ((y - top) * width + (x - left)) * 4;
        if (!alphaPixels[patchIndex + 3]) continue;
        output[patchIndex] = rgb[0]; output[patchIndex + 1] = rgb[1]; output[patchIndex + 2] = rgb[2];
      }
    }
    outputContext.putImageData(new ImageData(output, width, height), 0, 0);
    const frame = outputCanvas.transferToImageBitmap();
    try { self.postMessage({ type: "frame", sourceId, generation, patch: true, left, top, width, height, output: frame }, [frame]); }
    catch { frame.close?.(); fail(generation); }
  } catch { fail(generation); } finally { mask?.close?.(); releaseScratch(); }
}

self.onmessage = ({ data }) => {
  if (data.type === "release") return releaseSource();
  if (data.type === "source") {
    releaseSource();
    try {
      source = data.source; sourceId = data.sourceId;
      sourceCanvas = new OffscreenCanvas(source.width, source.height);
      sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
      if (!sourceContext) throw new Error("2d context unavailable");
      sourceWidth = source.width; sourceHeight = source.height;
      sourceContext.drawImage(source, 0, 0);
      sourcePixels = sourceContext.getImageData(0, 0, sourceWidth, sourceHeight).data;
      source.close?.(); source = null;
      sourceCanvas.width = sourceCanvas.height = 1;
      sourceCanvas = null; sourceContext = null;
    } catch { releaseSource(); fail(data.generation, data.sourceId); }
    return;
  }
  if (data.type === "render") {
    if (data.sourceId !== sourceId) { data.mask?.close?.(); fail(data.generation, data.sourceId); return; }
    render(data);
  }
  if (data.type === "patch") {
    if (data.sourceId !== sourceId) { data.mask?.close?.(); fail(data.generation, data.sourceId); return; }
    renderPatch(data);
  }
};
