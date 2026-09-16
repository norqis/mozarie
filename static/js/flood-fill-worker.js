self.onmessage = ({ data }) => {
  const { pixels, width, height, x, y, tolerance } = data;
  const rgba = new Uint8ClampedArray(pixels); const seedOffset = (y * width + x) * 4;
  const seed = [rgba[seedOffset], rgba[seedOffset + 1], rgba[seedOffset + 2]]; const seen = new Uint8Array(width * height); const spans = [];
  // Canvas color data can retain RGB values where alpha is zero. Those pixels
  // are not part of the visible image and must never connect two visible runs.
  const matches = (index) => { const offset = index * 4; return rgba[offset + 3] > 0 && Math.max(Math.abs(rgba[offset] - seed[0]), Math.abs(rgba[offset + 1] - seed[1]), Math.abs(rgba[offset + 2] - seed[2])) <= tolerance; };
  const claimRun = (row, column) => {
    const start = row * width + column;
    if (seen[start] || !matches(start)) return null;
    let left = column; let right = column;
    while (left > 0 && matches(row * width + left - 1)) left -= 1;
    while (right + 1 < width && matches(row * width + right + 1)) right += 1;
    for (let current = left; current <= right; current += 1) seen[row * width + current] = 1;
    return [row, left, right];
  };
  const stack = []; const initialRun = claimRun(y, x);
  if (initialRun) stack.push(...initialRun);
  while (stack.length) {
    const right = stack.pop(); const left = stack.pop(); const row = stack.pop();
    spans.push(row, left, right + 1);
    for (const neighborRow of [row - 1, row + 1]) {
      if (neighborRow < 0 || neighborRow >= height) continue;
      for (let column = left; column <= right;) {
        const run = claimRun(neighborRow, column);
        if (run) { stack.push(...run); column = run[2] + 1; } else column += 1;
      }
    }
  }
  const result = new Int32Array(spans); self.postMessage({ spans: result }, [result.buffer]);
};
