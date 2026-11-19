function enclosedAreaSpans(mask, width, height, x, y) {
  if (x < 0 || y < 0 || x >= width || y >= height || mask[y * width + x]) return { spans: new Int32Array(), open: false };
  const stack = [y * width + x]; const spans = [];
  while (stack.length) {
    const seed = stack.pop(); if (mask[seed]) continue;
    const row = Math.floor(seed / width); let left = seed % width; let right = left + 1;
    while (left > 0 && !mask[row * width + left - 1]) left--;
    while (right < width && !mask[row * width + right]) right++;
    mask.fill(2, row * width + left, row * width + right);
    if (!left || right === width || !row || row === height - 1) return { spans: new Int32Array(), open: true };
    spans.push(row, left, right);
    for (const neighbor of [row - 1, row + 1]) {
      if (neighbor < 0 || neighbor >= height) continue;
      let inRun = false;
      for (let column = left; column < right; column++) {
        if (mask[neighbor * width + column]) inRun = false;
        else if (!inRun) { stack.push(neighbor * width + column); inRun = true; }
      }
    }
  }
  return { spans: Int32Array.from(spans), open: false };
}
function alphaSpans(pixels, width, height) {
  const spans = [];
  for (let row = 0; row < height; row++) {
    let left = -1;
    for (let column = 0; column <= width; column++) {
      const filled = column < width && pixels[(row * width + column) * 4 + 3] > 0;
      if (filled && left < 0) left = column;
      if (!filled && left >= 0) { spans.push(row, left, column); left = -1; }
    }
  }
  return Int32Array.from(spans);
}
if (typeof self !== 'undefined') self.onmessage = ({ data }) => {
  let surface;
  try {
    const { width, height, bitmap, points, x, y } = data;
    surface = new OffscreenCanvas(width, height);
    const context = surface.getContext('2d', { willReadFrequently: true });
    let result;
    if (points) {
      if (points.length < 3) result = { spans: new Int32Array(), open: false };
      else {
        context.beginPath(); context.moveTo(points[0].x, points[0].y);
        for (const point of points.slice(1)) context.lineTo(point.x, point.y);
        context.closePath(); context.fill('evenodd');
        result = { spans: alphaSpans(context.getImageData(0, 0, width, height).data, width, height), open: false };
      }
    } else {
      context.drawImage(bitmap, 0, 0); bitmap.close();
      const pixels = context.getImageData(0, 0, width, height).data;
      const mask = new Uint8Array(width * height);
      for (let index = 0; index < mask.length; index++) mask[index] = pixels[index * 4 + 3] > 0 ? 1 : 0;
      result = enclosedAreaSpans(mask, width, height, x, y);
    }
    self.postMessage(result, [result.spans.buffer]);
  } catch (error) { data.bitmap?.close(); self.postMessage({ failure: error.message }); }
  finally { if (surface) { surface.width = 1; surface.height = 1; } }
};
if (typeof module !== 'undefined') module.exports = { enclosedAreaSpans, alphaSpans };
