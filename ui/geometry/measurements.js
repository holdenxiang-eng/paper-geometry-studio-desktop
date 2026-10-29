// Locate printed scalar annotations using measured glyphs and ink edges. Model
// endpoint guesses are not authoritative: nearby diagonals often confuse them.
export function applyMeasurementLabels(scene, region, reported = []) {
  const warnings = [], boxes = region.analysis?.glyphBoxes || [], used = new Set();
  const points = new Map(scene.points.map(point => [point.id, { x: point.x * 100, y: -point.y * 100 }]));
  for (const point of scene.points) {
    if (!point.labelOffset) continue;
    const x = point.x * 100 + point.labelOffset[0], y = -point.y * 100 - point.labelOffset[1];
    const index = boxes.findIndex(box => Math.abs(box.x - x) < .1 && Math.abs(box.y + box.height / 2 - y) < .1);
    if (index >= 0) used.add(index);
  }
  const candidates = boxes.map((box, index) => ({ box, index })).filter(({ box, index }) => !used.has(index) && box.height >= 5 && box.scores);
  const numeric = box => Array.from({ length: 10 }, (_, value) => ({ text: String(value), score: box.scores[String(value)] ?? 1 })).sort((a, b) => a.score - b.score);
  const locate = ({ box }, text) => {
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const edges = scene.segments.map(edge => {
      const a = points.get(edge.from), b = points.get(edge.to), dx = b.x - a.x, dy = b.y - a.y, square = dx * dx + dy * dy;
      const t = ((center.x - a.x) * dx + (center.y - a.y) * dy) / square;
      const distance = Math.abs(dx * (center.y - a.y) - dy * (center.x - a.x)) / Math.sqrt(square);
      return { edge, t, distance, score: distance + Math.abs(t - .5) * 8 };
    }).filter(value => value.t > .08 && value.t < .92 && value.distance < 24).sort((a, b) => a.score - b.score);
    if (!edges.length) return false;
    if (edges[0].edge.label && edges[0].edge.label !== text) return false;
    edges[0].edge.label = text;
    if (edges[1] && edges[1].score - edges[0].score < 3) warnings.push(`数字 ${text} 靠近多条线段，已按标注中段位置排放，请核对。`);
    return true;
  };
  // Only complete, strongly distinguished digit shapes add an annotation that
  // the model omitted. Short broken glyphs cannot take this path.
  for (const candidate of candidates) {
    const ranking = numeric(candidate.box), first = ranking[0], letter = Math.min(...Object.entries(candidate.box.scores).filter(([key]) => /^[A-Za-z]$/.test(key)).map(([, score]) => score));
    if (candidate.box.height >= 10 && first.score < .04 && ranking[1].score - first.score > .025 && letter - first.score > .02 && locate(candidate, first.text)) used.add(candidate.index);
  }
  for (const report of (Array.isArray(reported) ? reported : []).slice(0, 30)) {
    const text = String(report?.text || '');
    if (!/^[0-9]$/.test(text)) {
      if (text) warnings.push(`长度标注 ${text.slice(0, 20)} 未自动定位，请核对。`);
      continue;
    }
    // An already recovered clear digit need not be placed a second time.
    if (scene.segments.some(edge => edge.label === text)) continue;
    const ranked = candidates.filter(candidate => !used.has(candidate.index) && candidate.box.scores[text] < .13 && candidate.box.scores[text] - numeric(candidate.box)[0].score < .07)
      .sort((a, b) => a.box.scores[text] - b.box.scores[text]);
    let placed = false;
    for (const candidate of ranked) if (locate(candidate, text)) {
      used.add(candidate.index); placed = true;
      if (candidate.box.height < 10 || candidate.box.scores[text] > .08) warnings.push(`数字 ${text} 字形不完整，已结合本机转录定位，请核对。`);
      break;
    }
    if (!placed) warnings.push(`长度标注 ${text} 未找到可靠字形，请核对。`);
  }
  return warnings;
}

