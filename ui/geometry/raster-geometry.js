// Pixel measurements only: this module does not infer midpoint, angle, parallel
// or length constraints from the appearance of a drawing.
const THRESHOLD = 128;
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const cross = (ax, ay, bx, by) => ax * by - ay * bx;
const GLYPH_WIDTH = 32, GLYPH_HEIGHT = 40;
const GLYPH_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZl0123456789';
const glyphTemplates = new Map();
const MAX_TEMPLATE_HEIGHTS = 8;
const MAX_REGION_GLYPHS = 128;
const REGION_PADDING = 28;

function rasterCanvas(width, height) {
  const canvas = typeof document === 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  return canvas;
}

async function rasterSource(dataURL) {
  if (typeof Image !== 'undefined') {
    const image = new Image(); image.src = dataURL; await image.decode(); return image;
  }
  return createImageBitmap(await (await fetch(dataURL)).blob());
}

async function rasterDataUrl(canvas) {
  if (typeof canvas.toDataURL === 'function') return canvas.toDataURL('image/png');
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:image/png;base64,${btoa(binary)}`;
}

function normalizedGlyph(context, box) {
  const canvas = rasterCanvas(GLYPH_WIDTH, GLYPH_HEIGHT);
  const target = canvas.getContext('2d', { willReadFrequently: true });
  target.fillStyle = '#fff'; target.fillRect(0, 0, canvas.width, canvas.height); target.imageSmoothingEnabled = false;
  const scale = Math.min((GLYPH_WIDTH - 4) / box.width, (GLYPH_HEIGHT - 4) / box.height);
  const w = box.width * scale, h = box.height * scale;
  target.drawImage(context.canvas, box.x, box.y, box.width, box.height, (GLYPH_WIDTH - w) / 2, (GLYPH_HEIGHT - h) / 2, w, h);
  return blackPixels(target.getImageData(0, 0, GLYPH_WIDTH, GLYPH_HEIGHT));
}

function glyphDistances(mask) {
  const w = GLYPH_WIDTH, h = GLYPH_HEIGHT, result = Float32Array.from(mask, ink => ink ? 0 : 100);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (x) result[i] = Math.min(result[i], result[i - 1] + 1);
    if (y) result[i] = Math.min(result[i], result[i - w] + 1);
    if (x && y) result[i] = Math.min(result[i], result[i - w - 1] + 1.4);
    if (x + 1 < w && y) result[i] = Math.min(result[i], result[i - w + 1] + 1.4);
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x;
    if (x + 1 < w) result[i] = Math.min(result[i], result[i + 1] + 1);
    if (y + 1 < h) result[i] = Math.min(result[i], result[i + w] + 1);
    if (x + 1 < w && y + 1 < h) result[i] = Math.min(result[i], result[i + w + 1] + 1.4);
    if (x && y + 1 < h) result[i] = Math.min(result[i], result[i + w - 1] + 1.4);
  }
  return result;
}

function glyphHoles(mask) {
  const w = GLYPH_WIDTH, h = GLYPH_HEIGHT, seen = new Uint8Array(mask.length);
  let holes = 0;
  for (let seed = 0; seed < mask.length; seed++) {
    if (mask[seed] || seen[seed]) continue;
    const queue = [seed]; seen[seed] = 1; let border = false;
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head], x = i % w, y = Math.floor(i / w);
      if (!x || !y || x === w - 1 || y === h - 1) border = true;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy, next = yy * w + xx;
        if (xx >= 0 && xx < w && yy >= 0 && yy < h && !mask[next] && !seen[next]) { seen[next] = 1; queue.push(next); }
      }
    }
    if (!border && queue.length > 3) holes++;
  }
  return holes;
}

function templatesForGlyphs(height) {
  const key = Math.round(height);
  if (glyphTemplates.has(key)) {
    const cached = glyphTemplates.get(key);
    glyphTemplates.delete(key); glyphTemplates.set(key, cached);
    return cached;
  }
  const templates = [], sizes = [...new Set([64, ...[1.4, 1.5, 1.6].map(scale => Math.max(8, Math.round(height * scale)))])];
  for (const size of sizes) for (const family of ['Times New Roman', 'Cambria', 'Georgia', 'Arial']) for (const style of ['italic', 'normal']) for (const label of GLYPH_ALPHABET) {
    const canvas = rasterCanvas(128, 128);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#fff'; context.fillRect(0, 0, 128, 128); context.fillStyle = '#000'; context.font = `${style} ${size}px "${family}"`; context.fillText(label, 24, 96);
    const pixels = blackPixels(context.getImageData(0, 0, 128, 128));
    let left = 128, top = 128, right = -1, bottom = -1;
    for (let i = 0; i < pixels.length; i++) if (pixels[i]) { const x = i % 128, y = Math.floor(i / 128); left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
    const box = { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }, mask = normalizedGlyph(context, box);
    templates.push({ label, mask, distances: glyphDistances(mask), holes: glyphHoles(mask), aspect: box.width / box.height });
  }
  if (glyphTemplates.size >= MAX_TEMPLATE_HEIGHTS) glyphTemplates.delete(glyphTemplates.keys().next().value);
  glyphTemplates.set(key, templates);
  return templates;
}

function classifyGlyph(context, box) {
  const mask = normalizedGlyph(context, box), distances = glyphDistances(mask), holes = glyphHoles(mask), scores = {};
  for (const template of templatesForGlyphs(box.height)) {
    let forward = 0, backward = 0, countA = 0, countB = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i]) { forward += template.distances[i]; countA++; }
      if (template.mask[i]) { backward += distances[i]; countB++; }
    }
    const score = (forward / Math.max(1, countA) + backward / Math.max(1, countB)) / Math.hypot(GLYPH_WIDTH, GLYPH_HEIGHT)
      + Math.abs(Math.log((box.width / box.height) / template.aspect)) * 0.06 + Math.abs(holes - template.holes) * 0.025;
    scores[template.label] = Math.min(scores[template.label] ?? Infinity, score);
  }
  return scores;
}

// Minimum-cost one-to-one assignment. Dummy columns let uncertain identities
// remain unmatched instead of forcing a letter onto an unrelated glyph.
function minimumAssignment(costs) {
  const n = costs.length, m = costs[0]?.length || 0;
  const u = new Float64Array(n + 1), v = new Float64Array(m + 1), p = new Int32Array(m + 1), way = new Int32Array(m + 1);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let column = 0;
    const min = new Float64Array(m + 1).fill(Infinity), used = new Uint8Array(m + 1);
    do {
      used[column] = 1; const row = p[column]; let delta = Infinity, next = 0;
      for (let j = 1; j <= m; j++) if (!used[j]) {
        const value = costs[row - 1][j - 1] - u[row] - v[j];
        if (value < min[j]) { min[j] = value; way[j] = column; }
        if (min[j] < delta) { delta = min[j]; next = j; }
      }
      for (let j = 0; j <= m; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else min[j] -= delta; }
      column = next;
    } while (p[column]);
    do { const previous = way[column]; p[column] = p[previous]; column = previous; } while (column);
  }
  const assignment = Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) assignment[p[j] - 1] = j - 1;
  return assignment;
}

function matchPrintedGlyphs(labels, analysis) {
  const vertices = (analysis.vertices || []).filter(v => Number.isFinite(v.x) && Number.isFinite(v.y));
  const candidates = (analysis.glyphBoxes || []).map((glyph, index) => {
    const center = { x: glyph.x + glyph.width / 2, y: glyph.y + glyph.height / 2 };
    const rank = vertex => distance(vertex, center) / (1 + 0.6 * Math.max(0, (vertex.support || 1) - 1));
    const vertex = vertices.filter(v => distance(v, center) <= 32).toSorted((a, b) => rank(a) - rank(b))[0];
    return { glyph, index, vertex, gap: vertex ? distance(vertex, center) : Infinity };
  }).filter(item => item.glyph.height >= 5 && item.glyph.scores && item.gap <= 32);
  if (!labels.length || !candidates.length) return new Map();
  const costs = labels.map(label => [
    ...candidates.map(item => Number.isFinite(item.glyph.scores[label]) && item.glyph.scores[label] <= 0.16 ? item.glyph.scores[label] + item.gap * 0.0002 : 1),
    ...labels.map(() => 0.18),
  ]);
  const result = new Map();
  for (const [row, column] of minimumAssignment(costs).entries()) {
    if (column < candidates.length && costs[row][column] < 0.18) result.set(labels[row], candidates[column]);
  }
  return result;
}

function blackPixels(image) {
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || data?.length !== width * height * 4) throw new Error('截图像素数据无效');
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    const alpha = data[i * 4 + 3] / 255;
    const gray = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) * alpha + 255 * (1 - alpha);
    mask[i] = gray < THRESHOLD ? 1 : 0;
  }
  return mask;
}

function components(mask, width, height) {
  const seen = new Uint8Array(mask.length), queue = new Int32Array(mask.length), result = [];
  for (let seed = 0; seed < mask.length; seed++) {
    if (!mask[seed] || seen[seed]) continue;
    let head = 0, tail = 1, left = seed % width, right = left, top = Math.floor(seed / width), bottom = top;
    queue[0] = seed; seen[seed] = 1;
    while (head < tail) {
      const at = queue[head++], x = at % width, y = Math.floor(at / width);
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = ny * width + nx;
        if (mask[next] && !seen[next]) { seen[next] = 1; queue[tail++] = next; }
      }
    }
    const item = { x: left, y: top, width: right - left + 1, height: bottom - top + 1, pixels: tail };
    if (item.width > 60 && item.height > 50 && tail > 120) item.indices = queue.slice(0, tail);
    result.push(item);
  }
  return result;
}

function nearInk(mask, width, height, x, y, radius = 1.6) {
  const cx = Math.round(x), cy = Math.round(y), r = Math.ceil(radius);
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (dx * dx + dy * dy > radius * radius + 0.5) continue;
    const xx = cx + dx, yy = cy + dy;
    if (xx >= 0 && xx < width && yy >= 0 && yy < height && mask[yy * width + xx]) return true;
  }
  return false;
}

function coverage(mask, width, height, a, b, radius = 1.6) {
  const steps = Math.max(2, Math.ceil(distance(a, b) * 1.5));
  let ink = 0, gap = 0, longestGap = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (nearInk(mask, width, height, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, radius)) { ink++; gap = 0; }
    else { gap++; longestGap = Math.max(longestGap, gap); }
  }
  return { ratio: ink / (steps + 1), longestGap: longestGap / steps * distance(a, b) };
}

function fittedLine(points, nx, ny, rho) {
  const selected = points.filter(p => Math.abs(nx * p.x + ny * p.y - rho) <= 1.8);
  if (selected.length < 8) return null;
  const center = selected.reduce((p, q) => ({ x: p.x + q.x / selected.length, y: p.y + q.y / selected.length }), { x: 0, y: 0 });
  let xx = 0, yy = 0, xy = 0;
  for (const p of selected) { const x = p.x - center.x, y = p.y - center.y; xx += x * x; yy += y * y; xy += x * y; }
  const angle = Math.atan2(2 * xy, xx - yy) / 2, dx = Math.cos(angle), dy = Math.sin(angle);
  let low = Infinity, high = -Infinity;
  for (const p of selected) { const t = (p.x - center.x) * dx + (p.y - center.y) * dy; low = Math.min(low, t); high = Math.max(high, t); }
  return { x1: center.x + low * dx, y1: center.y + low * dy, x2: center.x + high * dx, y2: center.y + high * dy, votes: selected.length };
}

function measureLines(mask, width, height) {
  const points = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) points.push({ x: i % width, y: Math.floor(i / width) });
  const diagonal = Math.ceil(Math.hypot(width, height)), bins = diagonal * 2 + 1, angles = 180;
  const votes = new Uint16Array(angles * bins), cos = [], sin = [];
  for (let a = 0; a < angles; a++) { cos.push(Math.cos(a * Math.PI / angles)); sin.push(Math.sin(a * Math.PI / angles)); }
  const stride = Math.max(1, Math.floor(points.length / 9000));
  for (let i = 0; i < points.length; i += stride) {
    const p = points[i];
    for (let a = 0; a < angles; a++) votes[a * bins + Math.round(p.x * cos[a] + p.y * sin[a]) + diagonal]++;
  }
  const peaks = [], minimum = Math.max(12, Math.min(width, height) * 0.12) / stride;
  for (let a = 0; a < angles; a++) for (let r = 0; r < bins; r++) {
    const count = votes[a * bins + r];
    if (count >= minimum) peaks.push({ a, rho: r - diagonal, count });
  }
  peaks.sort((a, b) => b.count - a.count);
  const lines = [], suppressed = [];
  for (const peak of peaks) {
    if (suppressed.some(p => Math.abs(p.a - peak.a) <= 3 && Math.abs(p.rho - peak.rho) <= 4)) continue;
    suppressed.push(peak);
    const line = fittedLine(points, cos[peak.a], sin[peak.a], peak.rho);
    if (!line || Math.hypot(line.x2 - line.x1, line.y2 - line.y1) < Math.max(15, Math.min(width, height) * 0.13)) continue;
    const a = { x: line.x1, y: line.y1 }, b = { x: line.x2, y: line.y2 };
    if (coverage(mask, width, height, a, b).ratio < 0.76) continue;
    const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    if (lines.some(other => {
      const ox = other.x2 - other.x1, oy = other.y2 - other.y1, ol = Math.hypot(ox, oy);
      return Math.abs(cross(dx / length, dy / length, ox / ol, oy / ol)) < 0.055
        && Math.abs(cross(dx / length, dy / length, other.x1 - a.x, other.y1 - a.y)) < 3;
    })) continue;
    lines.push(line);
    if (lines.length >= 36) break;
  }
  return lines;
}

function lineSupport(point, lines) {
  const directions = [];
  for (const line of lines) {
    const dx = line.x2 - line.x1, dy = line.y2 - line.y1, length = Math.hypot(dx, dy);
    const t = ((point.x - line.x1) * dx + (point.y - line.y1) * dy) / (length * length);
    if (t < -10 / length || t > 1 + 10 / length || Math.abs(cross(dx, dy, point.x - line.x1, point.y - line.y1)) / length > 1.9) continue;
    const angle = (Math.atan2(dy, dx) + Math.PI) % Math.PI;
    if (!directions.some(other => Math.min(Math.abs(other - angle), Math.PI - Math.abs(other - angle)) < 0.16)) directions.push(angle);
  }
  return directions.length;
}

// Thinning exposes actual ink branches even when an angled short segment loses
// the global Hough vote. Branches are measured topology, not geometric premises.
function pixelJunctions(mask, width, height) {
  const thin = mask.slice();
  for (let iteration = 0; iteration < 40; iteration++) {
    let removed = 0;
    for (let pass = 0; pass < 2; pass++) {
      const erase = [];
      for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
        const at = y * width + x;
        if (!thin[at]) continue;
        const p = [thin[at - width], thin[at - width + 1], thin[at + 1], thin[at + width + 1], thin[at + width], thin[at + width - 1], thin[at - 1], thin[at - width - 1]];
        const count = p.reduce((sum, value) => sum + value, 0);
        if (count < 2 || count > 6 || p.filter((value, i) => !value && p[(i + 1) % 8]).length !== 1) continue;
        if (pass === 0 ? p[0] * p[2] * p[4] || p[2] * p[4] * p[6] : p[0] * p[2] * p[6] || p[0] * p[4] * p[6]) continue;
        erase.push(at);
      }
      for (const at of erase) thin[at] = 0;
      removed += erase.length;
    }
    if (!removed) break;
  }
  const clusters = [];
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const at = y * width + x;
    if (!thin[at]) continue;
    const p = [thin[at - width], thin[at - width + 1], thin[at + 1], thin[at + width + 1], thin[at + width], thin[at + width - 1], thin[at - 1], thin[at - width - 1]];
    const branches = p.filter((value, i) => !value && p[(i + 1) % 8]).length;
    if (branches < 3) continue;
    const cluster = clusters.find(c => Math.hypot(c.x - x, c.y - y) < 4);
    if (cluster) { cluster.x = (cluster.x * cluster.count + x) / (cluster.count + 1); cluster.y = (cluster.y * cluster.count + y) / (cluster.count + 1); cluster.count++; cluster.support = Math.max(cluster.support, branches); }
    else clusters.push({ x, y, support: branches, count: 1 });
  }
  return clusters;
}

function inkAxisSupport(point, mask, width, height) {
  const active = [];
  for (let angle = 0; angle < 180; angle += 5) {
    const dx = Math.cos(angle * Math.PI / 180), dy = Math.sin(angle * Math.PI / 180);
    let supported = false;
    for (const sign of [-1, 1]) {
      let hits = 0, total = 0;
      // Small right-angle boxes are annotations, not extra vertex branches.
      // Require a continuing straight ray beyond their usual few-pixel arms.
      for (let r = 6; r <= 24; r += 2) { total++; if (nearInk(mask, width, height, point.x + sign * dx * r, point.y + sign * dy * r, 1.6)) hits++; }
      if (hits / total >= 0.8) supported = true;
    }
    active.push(supported);
  }
  return active.every(Boolean) ? 1 : active.filter((value, i) => value && !active[(i + active.length - 1) % active.length]).length;
}

// A printed point on a straight edge has no branch for Hough/thinning to find.
// Its compact solid core survives 3x3 erosion while the surrounding thin stroke
// disappears. Keep only small cores lying on measured line work.
function solidPointCenters(mask, width, height, lines) {
  const core = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    let solid = true;
    for (let dy = -1; dy <= 1 && solid; dy++) for (let dx = -1; dx <= 1; dx++) if (!mask[(y + dy) * width + x + dx]) { solid = false; break; }
    if (solid) core[y * width + x] = 1;
  }
  return components(core, width, height).filter(box => box.width <= 10 && box.height <= 10).map(box => {
    let x = 0, y = 0, count = 0;
    for (let yy = box.y; yy < box.y + box.height; yy++) for (let xx = box.x; xx < box.x + box.width; xx++) if (core[yy * width + xx]) { x += xx; y += yy; count++; }
    return { x: x / count, y: y / count };
  }).filter(point => lineSupport(point, lines) > 0);
}

function lineVertices(lines, mask, width, height) {
  const candidates = lines.flatMap(line => [{ x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 }]);
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const a = lines[i], b = lines[j], ux = a.x2 - a.x1, uy = a.y2 - a.y1, vx = b.x2 - b.x1, vy = b.y2 - b.y1;
    const determinant = cross(ux, uy, vx, vy);
    if (Math.abs(determinant) < 0.06 * Math.hypot(ux, uy) * Math.hypot(vx, vy)) continue;
    const t = cross(b.x1 - a.x1, b.y1 - a.y1, vx, vy) / determinant;
    const s = cross(b.x1 - a.x1, b.y1 - a.y1, ux, uy) / determinant;
    const paddingA = 4 / Math.hypot(ux, uy), paddingB = 4 / Math.hypot(vx, vy);
    if (t >= -paddingA && t <= 1 + paddingA && s >= -paddingB && s <= 1 + paddingB) candidates.push({ x: a.x1 + t * ux, y: a.y1 + t * uy });
  }
  const clusters = [];
  for (const p of candidates) {
    const cluster = clusters.find(c => distance(c, p) < 5);
    if (cluster) { cluster.x = (cluster.x * cluster.count + p.x) / (cluster.count + 1); cluster.y = (cluster.y * cluster.count + p.y) / (cluster.count + 1); cluster.count++; }
    else clusters.push({ ...p, count: 1 });
  }
  const vertices = clusters.map(({ x, y }) => ({ x, y, support: Math.max(1, lineSupport({ x, y }, lines)) }));
  for (const junction of pixelJunctions(mask, width, height)) {
    const existing = vertices.toSorted((a, b) => distance(a, junction) - distance(b, junction))[0];
    if (existing && distance(existing, junction) < 4) existing.support = Math.max(existing.support, junction.support);
    else vertices.push({ x: junction.x, y: junction.y, support: Math.max(junction.support, lineSupport(junction, lines)) });
  }
  for (const point of solidPointCenters(mask, width, height, lines)) {
    if (!vertices.some(vertex => distance(vertex, point) < 4)) vertices.push({ ...point, support: 1 });
  }
  for (const vertex of vertices) vertex.support = Math.max(1, inkAxisSupport(vertex, mask, width, height));
  return vertices;
}

function inkRows(mask, width, height) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const runs = [];
    for (let x = 0; x < width; x++) if (mask[y * width + x]) {
      const start = x;
      while (x + 1 < width && mask[y * width + x + 1]) x++;
      runs.push([start, x]);
    }
    rows.push(runs);
  }
  return rows;
}

function mergeGlyphFragments(input) {
  const boxes = input.map(box => ({ ...box }));
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < boxes.length && !merged; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j], left = Math.min(a.x, b.x), right = Math.max(a.x + a.width, b.x + b.width);
      const top = Math.min(a.y, b.y), bottom = Math.max(a.y + a.height, b.y + b.height);
      const gap = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width));
      const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      const tinyStroke = Math.min(a.height, b.height) <= Math.max(a.height, b.height) * 0.3;
      const maxGap = tinyStroke ? Math.max(5, Math.max(a.height, b.height) * 0.5) : 5;
      if (gap > maxGap || overlap < Math.min(a.height, b.height) * 0.5 || bottom - top > Math.max(a.height, b.height) + 4 || right - left > Math.max(18, Math.max(a.height, b.height) * 1.8)) continue;
      boxes[i] = { x: left, y: top, width: right - left, height: bottom - top };
      boxes.splice(j, 1); merged = true; break;
    }
  }
  return boxes;
}

/** Pure RGBA measurement; every returned analysis value is JSON serializable. */
export function findDiagramRegions(image) {
  const { width, height } = image, mask = blackPixels(image), all = components(mask, width, height);
  const diagrams = all.filter(c => c.indices), rows = [];
  for (const component of diagrams.sort((a, b) => a.y - b.y)) {
    let row = rows.find(r => Math.min(r.bottom, component.y + component.height) - Math.max(r.top, component.y) > Math.min(r.bottom - r.top, component.height) * 0.4);
    if (!row) { row = { top: component.y, bottom: component.y + component.height, items: [] }; rows.push(row); }
    row.items.push(component); row.top = Math.min(row.top, component.y); row.bottom = Math.max(row.bottom, component.y + component.height);
  }
  return rows.sort((a, b) => a.top - b.top).flatMap(row => row.items.sort((a, b) => a.x - b.x)).map(component => {
    const x = Math.max(0, component.x - REGION_PADDING), y = Math.max(0, component.y - REGION_PADDING);
    const w = Math.min(width, component.x + component.width + REGION_PADDING) - x, h = Math.min(height, component.y + component.height + REGION_PADDING) - y;
    const local = new Uint8Array(w * h);
    for (const at of component.indices) local[(Math.floor(at / width) - y) * w + at % width - x] = 1;
    const glyphBoxes = mergeGlyphFragments(all.filter(c => !c.indices && c.pixels >= 3 && c.width <= 40 && c.height <= 40 && c.x >= x && c.y >= y && c.x + c.width <= x + w && c.y + c.height <= y + h)
      .map(c => ({ x: c.x - x, y: c.y - y, width: c.width, height: c.height })));
    const lines = measureLines(local, w, h);
    return { x, y, width: w, height: h, analysis: { lines, vertices: lineVertices(lines, local, w, h), glyphBoxes, inkRows: inkRows(local, w, h) } };
  });
}

// Read only an isolated, clear single-digit caption after a printed square
// frame. Its two vertical strokes can be disconnected at screenshot scale.
// Options and uncertain/multiple captions deliberately leave the name blank.
function readPrintedCaption(context) {
  const { width, height } = context.canvas;
  const mask = blackPixels(context.getImageData(0, 0, width, height));
  const boxes = components(mask, width, height), matches = new Map();
  for (const left of boxes) {
    const h = left.height;
    if (h < 12 || h > 30 || left.width > h * 0.3) continue;
    const columnCoverage = x => {
      let count = 0;
      for (let y = left.y; y < left.y + h; y++) count += mask[y * width + x];
      return count / h;
    };
    if (Math.max(...Array.from({ length: left.width }, (_, i) => columnCoverage(left.x + i))) < 0.75) continue;
    for (let right = left.x + Math.ceil(h * 0.65); right <= Math.min(width - 1, left.x + Math.floor(h * 1.25)); right++) {
      if (columnCoverage(right) < 0.75) continue;
      let inside = 0;
      for (let y = left.y + 2; y < left.y + h - 2; y++) for (let x = left.x + left.width + 1; x < right - 1; x++) inside += mask[y * width + x];
      if (inside < h * 0.5) continue;
      const aligned = boxes.filter(box => box.x > right && box.height >= h * 0.6 && box.height <= h * 1.1 && box.width <= h * 0.75
        && Math.abs(box.y + box.height / 2 - left.y - h / 2) <= h * 0.2).map(box => {
        // A small detached foot (for example the lower bar of 2) belongs to
        // the same printed digit, never to a neighboring full-height digit.
        let digit = { ...box };
        for (const stroke of boxes) {
          if (stroke === box || stroke.x <= right || stroke.height > box.height * 0.35) continue;
          const overlap = Math.min(digit.x + digit.width, stroke.x + stroke.width) - Math.max(digit.x, stroke.x);
          const gap = Math.max(0, Math.max(digit.y, stroke.y) - Math.min(digit.y + digit.height, stroke.y + stroke.height));
          const x = Math.min(digit.x, stroke.x), y = Math.min(digit.y, stroke.y);
          const width = Math.max(digit.x + digit.width, stroke.x + stroke.width) - x;
          const height = Math.max(digit.y + digit.height, stroke.y + stroke.height) - y;
          if (overlap >= Math.min(digit.width, stroke.width) * 0.5 && gap <= 2 && width <= h * 0.75 && height <= h * 1.1) digit = { x, y, width, height };
        }
        return digit;
      });
      const digits = aligned.filter(box => box.x - right - 1 >= 1 && box.x - right - 1 <= h * 0.7);
      if (digits.length !== 1) continue;
      const digit = digits[0];
      if (aligned.some(box => box !== digit && box.x >= digit.x + digit.width && box.x - digit.x - digit.width <= h * 0.35)) continue;
      const ranked = Object.entries(classifyGlyph(context, digit)).filter(([label]) => /^[0-9]$/.test(label)).sort((a, b) => a[1] - b[1]);
      if (ranked[0][1] <= 0.06 && ranked[1][1] - ranked[0][1] >= 0.015) matches.set(`${digit.x},${digit.y}`, `图${ranked[0][0]}`);
    }
  }
  return matches.size === 1 ? matches.values().next().value : '';
}

function glyphNearGeometry(box, analysis) {
  if (box.height < 5) return false;
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  if (analysis.vertices.some(vertex => distance(vertex, center) <= 32)) return true;
  return analysis.lines.some(line => {
    const dx = line.x2 - line.x1, dy = line.y2 - line.y1, lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) return false;
    const t = Math.max(0, Math.min(1, ((center.x - line.x1) * dx + (center.y - line.y1) * dy) / lengthSquared));
    return Math.hypot(center.x - line.x1 - t * dx, center.y - line.y1 - t * dy) <= 32;
  });
}

/** Load and crop a source screenshot locally; no network/model request is made. */
export async function prepareRasterImage(dataURL, { onProgress = () => {} } = {}) {
  if (typeof dataURL !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,/.test(dataURL)) throw new Error('请选择 PNG、JPEG 或 WebP 截图');
  onProgress({ stage: 'decode', message: '正在读取截图' });
  const source = await rasterSource(dataURL);
  const sourceWidth = source.naturalWidth ?? source.width, sourceHeight = source.naturalHeight ?? source.height;
  const scale = Math.min(1, 1800 / Math.max(sourceWidth, sourceHeight));
  const canvas = rasterCanvas(Math.max(1, Math.round(sourceWidth * scale)), Math.max(1, Math.round(sourceHeight * scale)));
  const context = canvas.getContext('2d', { willReadFrequently: true }); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  let textDataUrl;
  // Small type needs enough visual tokens for accurate exponents and fraction
  // arguments. This separate image is only for transcription: keep geometry,
  // source positions and diagram crops in the original measurement canvas.
  if (canvas.width < 640) {
    const textScale = Math.min(640 / canvas.width, 1800 / canvas.height);
    if (textScale > 1) {
      onProgress({ stage: 'text-image', message: '正在放大小字号题文' });
      const textCanvas = rasterCanvas(Math.round(canvas.width * textScale), Math.round(canvas.height * textScale));
      const textContext = textCanvas.getContext('2d');
      textContext.imageSmoothingEnabled = true; textContext.imageSmoothingQuality = 'high';
      textContext.drawImage(canvas, 0, 0, textCanvas.width, textCanvas.height);
      textDataUrl = await rasterDataUrl(textCanvas);
    }
  }
  onProgress({ stage: 'detect', message: '正在定位图形与线条' });
  const regions = findDiagramRegions(context.getImageData(0, 0, canvas.width, canvas.height));
  for (const [regionIndex, region] of regions.entries()) {
    const glyphs = region.analysis.glyphBoxes.filter(box => glyphNearGeometry(box, region.analysis));
    if (glyphs.length > MAX_REGION_GLYPHS) throw new Error('图形附近的文字过多，请裁剪单个图形后重试。');
    const progress = { current: regionIndex + 1, total: regions.length };
    onProgress({ stage: 'glyphs', message: `正在读取第 ${regionIndex + 1}/${regions.length} 个图形的标记`, ...progress });
    region.analysis.glyphBoxes = glyphs.map((box, index) => {
      if (index && index % 16 === 0) onProgress({ stage: 'glyphs', message: `正在读取第 ${regionIndex + 1}/${regions.length} 个图形的标记（${index}/${glyphs.length}）`, ...progress });
      return { ...box, scores: classifyGlyph(context, { ...box, x: region.x + box.x, y: region.y + box.y }) };
    });
    // Tiny source diagrams need more visual tokens for dependable letter
    // localization. Keep all measurements in original pixels; only enlarge
    // the image sent to the local perception model.
    const zoom = Math.max(1, Math.min(4, 640 / Math.max(region.width, region.height)));
    onProgress({ stage: 'crop', message: `正在整理第 ${regionIndex + 1}/${regions.length} 个图形`, ...progress });
    const crop = rasterCanvas(Math.round(region.width * zoom), Math.round(region.height * zoom));
    crop.getContext('2d').drawImage(canvas, region.x, region.y, region.width, region.height, 0, 0, crop.width, crop.height);
    region.cropDataUrl = await rasterDataUrl(crop);
    region.printedCaption = '';
    // Diagram ROIs already include label padding. A nearby caption can start
    // inside that padding, so scan from the measured bottom through 65px below
    // the ROI instead of cutting the first strokes off its printed frame.
    const captionTop = Math.max(region.y, region.y + region.height - REGION_PADDING);
    const captionHeight = Math.min(65 + REGION_PADDING, canvas.height - captionTop);
    if (captionHeight > 0) {
      onProgress({ stage: 'caption', message: `正在核对第 ${regionIndex + 1}/${regions.length} 个图形的图号`, ...progress });
      const caption = rasterCanvas(region.width, captionHeight);
      const captionContext = caption.getContext('2d', { willReadFrequently: true });
      captionContext.drawImage(canvas, region.x, captionTop, region.width, captionHeight, 0, 0, caption.width, caption.height);
      region.printedCaption = readPrintedCaption(captionContext);
    }
  }
  onProgress({ stage: 'complete', message: '图形预处理完成', current: regions.length, total: regions.length });
  return { width: canvas.width, height: canvas.height, regions, ...(textDataUrl ? { textDataUrl } : {}) };
}

/** Snap only point identities supplied by visual perception; recover drawn edges
 * from measured ink, never from the model's proposed segment list. */
export function buildRasterScene(visualJSON, region) {
  const visual = typeof visualJSON === 'string' ? JSON.parse(visualJSON) : visualJSON;
  if (!Array.isArray(visual?.points) || !region?.analysis || !Number.isInteger(region.width) || !Number.isInteger(region.height)) throw new Error('图形识别结果或像素测量无效');
  const { width, height, analysis } = region, warnings = [], locations = [], used = new Set(), usedGlyphs = new Set(), entries = [];
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (const [start, end] of analysis.inkRows?.[y] || []) for (let x = Math.max(0, start); x <= Math.min(width - 1, end); x++) mask[y * width + x] = 1;
  const snapDistance = Math.max(12, Math.hypot(width, height) * 0.1);
  for (const item of visual.points.slice(0, 100)) {
    const label = String(item.label ?? item.id ?? '').trim();
    if (used.has(label)) continue;
    if (!label || label.length > 50 || ['__proto__', 'constructor', 'prototype'].includes(label)) { warnings.push('部分点标记无效，未加入图形。'); continue; }
    if (label === 'l') { warnings.push('小写 l 作为直线标记保留待核对，未当作字母顶点。'); continue; }
    used.add(label);
    entries.push({ label, item });
  }
  const matched = matchPrintedGlyphs(entries.map(entry => entry.label), analysis);
  for (const { label, item } of entries) {
    const identified = matched.get(label);
    if (identified) {
      const score = identified.glyph.scores[label], best = Math.min(...Object.values(identified.glyph.scores));
      if (score > 0.1 || score > best + 0.025) warnings.push(`点 ${label} 的字形匹配较弱，已结合可见字母集合定位，请核对。`);
      locations.push({ id: label, label, x: identified.vertex.x, y: identified.vertex.y, glyphIndex: identified.index });
      continue;
    }
    if (!Number.isFinite(item.x) || !Number.isFinite(item.y) || item.x < 0 || item.x > 1000 || item.y < 0 || item.y > 1000) throw new Error(`点 ${label} 的字形与位置均无法可靠确定，请使用更清晰的截图。`);
    const rough = { x: item.x / 1000 * width, y: item.y / 1000 * height };
    const nearest = (analysis.vertices || []).filter(v => Number.isFinite(v.x) && Number.isFinite(v.y)).sort((a, b) => distance(a, rough) - distance(b, rough))[0];
    const position = nearest && distance(nearest, rough) <= snapDistance ? nearest : rough;
    if (position === rough) warnings.push(`点 ${label} 未找到可靠像素顶点，保留待核对的位置。`);
    locations.push({ id: label, label, x: position.x, y: position.y });
  }
  // A right-angle marker can sit a few pixels from its real corner. Refine
  // nearby measured candidates by the number of actual ink strokes joining
  // the other labeled vertices, rather than choosing the marker's endpoint.
  const joins = (candidate, owner) => {
    let score = 0;
    for (const other of locations) {
      if (other === owner || distance(candidate, other) < 8) continue;
      const dx = other.x - candidate.x, dy = other.y - candidate.y, length = Math.hypot(dx, dy);
      const split = locations.some(p => {
        if (p === owner || p === other) return false;
        const t = ((p.x - candidate.x) * dx + (p.y - candidate.y) * dy) / (length * length);
        return t > 3 / length && t < 1 - 3 / length && Math.abs(cross(dx, dy, p.x - candidate.x, p.y - candidate.y)) / length <= 3;
      });
      if (split) continue;
      const ink = coverage(mask, width, height, candidate, other, 1.8);
      if (ink.ratio >= .86 && ink.longestGap <= Math.max(4, length * .06)) score += 1 + Math.min(length, 200) / 400;
    }
    return score;
  };
  const endpointCandidates = (analysis.lines || []).flatMap(line => [{ x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 }]);
  for (let pass = 0; pass < 2; pass++) for (const location of locations) {
    const initial = { x: location.x, y: location.y };
    let best = initial, bestScore = joins(initial, location);
    for (const candidate of [...(analysis.vertices || []), ...endpointCandidates]) {
      const displacement = distance(candidate, initial);
      if (!Number.isFinite(displacement) || displacement > 8 || locations.some(point => point !== location && distance(point, candidate) < 4)) continue;
      const score = joins(candidate, location) - displacement * .025;
      if (score > bestScore + .12) { best = candidate; bestScore = score; }
    }
    location.x = best.x; location.y = best.y;
  }
  const points = locations.map(point => {
    const measuredGlyph = point.glyphIndex === undefined ? null : { ...analysis.glyphBoxes[point.glyphIndex], index: point.glyphIndex };
    const glyph = measuredGlyph || (analysis.glyphBoxes || []).map((box, index) => ({ ...box, index, distance: Math.hypot(box.x + box.width / 2 - point.x, box.y + box.height / 2 - point.y) }))
      .filter(box => !usedGlyphs.has(box.index) && box.distance <= 32 && box.height >= 5).sort((a, b) => a.distance - b.distance)[0];
    const result = { id: point.id, kind: 'free', x: point.x / 100, y: -point.y / 100 };
    if (glyph) { usedGlyphs.add(glyph.index); result.labelOffset = [glyph.x - point.x, point.y - glyph.y - glyph.height / 2]; }
    else warnings.push(`点 ${point.label} 的标签位置未定位，使用编辑器自动避让，请核对。`);
    return result;
  });
  const segments = [];
  for (let i = 0; i < locations.length; i++) for (let j = i + 1; j < locations.length; j++) {
    const a = locations[i], b = locations[j], length = distance(a, b);
    if (length < 5) { warnings.push(`点 ${a.label} 与 ${b.label} 的像素位置过近，请核对标记。`); continue; }
    const dx = b.x - a.x, dy = b.y - a.y;
    const interrupted = locations.some((p, index) => {
      if (index === i || index === j) return false;
      const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (length * length);
      return t > 3 / length && t < 1 - 3 / length && Math.abs(cross(dx, dy, p.x - a.x, p.y - a.y)) / length <= 3;
    });
    if (interrupted) continue;
    const ink = coverage(mask, width, height, a, b, 1.8);
    if (ink.ratio >= 0.86 && ink.longestGap <= Math.max(4, length * 0.06)) segments.push({ id: `segment-${i}-${j}`, from: a.id, to: b.id, label: false });
  }
  if (!segments.length && points.length > 1) warnings.push('未恢复出可靠直线边，圆弧或断开的笔迹需要人工核对。');
  return { scene: { points, segments, lines: [], circles: [], angles: [] }, warnings };
}

