/** Initial frames follow measured screenshot positions, never a fixed grid.
 * Remove only the outside whitespace above the group; retain its row/column gaps.
 */
export function sourceFigureLayouts(regions, imageWidth) {
  if (!Number.isFinite(imageWidth) || imageWidth < 1) throw new Error('原图布局宽度无效。');
  if (!regions.length) return [];
  const imageScale = 980 / imageWidth;
  const boxes = regions.map(region => {
    const coordinates = (region.analysis?.lines || []).flatMap(line => [
      { x: line.x1, y: line.y1 }, { x: line.x2, y: line.y2 },
    ]).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (!coordinates.length) return { left: region.x * imageScale, top: region.y * imageScale, right: (region.x + region.width) * imageScale, bottom: (region.y + region.height) * imageScale };
    const minY = Math.min(...coordinates.map(p => p.y)), maxY = Math.max(...coordinates.map(p => p.y));
    const ink = coordinates.map(p => ({ x: (region.x + p.x) * imageScale, y: (region.y + p.y) * imageScale }));
    // Captions can lie inside the ROI padding. Keep the vertex letters below a
    // baseline, but do not include the lower printed figure number a second time.
    for (const glyph of region.analysis.glyphBoxes || []) {
      if (glyph.y > maxY + 12 || glyph.y + glyph.height < minY - 32) continue;
      const center = { x: glyph.x + glyph.width / 2, y: glyph.y + glyph.height / 2 };
      const vertex = (region.analysis.vertices?.length ? region.analysis.vertices : coordinates).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y))
        .reduce((best, p) => !best || Math.hypot(p.x - center.x, p.y - center.y) < Math.hypot(best.x - center.x, best.y - center.y) ? p : best, null);
      // Printing uses 22 paper units for point letters. Reserve that typography
      // around the source-scale geometry, so fitting labels does not shrink it.
      const unit = 22 / 17, fontHeight = 22 * .75;
      const x = (region.x + vertex.x) * imageScale + (glyph.x - vertex.x) * unit;
      const y = (region.y + vertex.y) * imageScale + (center.y - vertex.y) * unit;
      const width = Math.max(22 * .7, glyph.width * unit);
      ink.push({ x, y: y - fontHeight }, { x: x + width, y: y + fontHeight });
    }
    return { left: Math.min(...ink.map(p => p.x)), top: Math.min(...ink.map(p => p.y)), right: Math.max(...ink.map(p => p.x)), bottom: Math.max(...ink.map(p => p.y)) };
  });
  const top = Math.min(...boxes.map(b => b.top)), bottom = Math.max(...boxes.map(b => b.bottom));
  const scale = Math.min(1, 4900 / Math.max(1, bottom - top));
  return boxes.map(box => {
    const width = Math.min(980, Math.max(160, (box.right - box.left) * scale + 28));
    const height = Math.min(4980, Math.max(140, (box.bottom - box.top) * scale + 44));
    const x = Math.max(4, Math.min(996 - width, 10 + box.left * scale - 14));
    const y = Math.max(0, Math.min(5000 - height, 8 + (box.top - top) * scale));
    return Object.fromEntries(Object.entries({ x, y, width, height }).map(([key, value]) => [key, Math.round(value * 1000) / 1000]));
  });
}

