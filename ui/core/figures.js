import { buildRasterScene } from '../geometry/raster-geometry.js';
import { sourceFigureLayouts } from '../geometry/source-layout.js';
import { applyRecognizedRelations } from '../geometry/relations.js';
import { applyMeasurementLabels } from '../geometry/measurements.js';
import { exportSceneSvg } from '../geometry/board.js';
import { figureLayout, figureStageSize } from '../geometry/layout.js';

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const blankScene = () => ({ points: [], segments: [], lines: [], circles: [], angles: [] });

export function completeFigures(result, raster, sourceId) {
  const questions = structuredClone(result.questions || []), readings = result.figureReadings || [];
  if (!questions.length) throw new Error('未识别到题目，原截图已保留。');
  const covered = new Set(readings.map(reading => reading.regionIndex));
  if (raster.regions.some((region, index) => !covered.has(index))) throw new Error('部分图形尚未识别完整，原截图和已有题目已保留，可以重试。');
  for (let qi = 0; qi < questions.length; qi++) {
    const question = questions[qi]; question.figures ||= []; question.blocks ||= [];
    const owned = readings.filter(reading => reading.questionIndex === qi);
    const regions = owned.map(reading => raster.regions[reading.regionIndex]).filter(Boolean);
    const layouts = sourceFigureLayouts(regions, raster.width), ids = [];
    for (let index = 0; index < owned.length; index++) {
      const reading = owned[index], region = raster.regions[reading.regionIndex]; if (!region) continue;
      if (!Array.isArray(reading.labels) || !reading.labels.length) throw new Error('图形字母未识别完整，截图已保留，不能生成猜测的图形。');
      const { scene } = buildRasterScene({ points: reading.labels.map(label => ({ label })) }, region);
      if (scene.points.length < 2 || !(scene.segments.length || scene.lines.length || scene.circles.length)) throw new Error('图形线条暂未恢复完整，请核对原图或重试。');
      applyMeasurementLabels(scene, region, (reading.lengthLabels || []).map(text => ({ text })));
      const text = question.blocks.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const constrained = applyRecognizedRelations(scene, text);
      const fid = `${sourceId}-figure-${reading.regionIndex + 1}`;
      const caption = /^图[0-9]+$/.test(region.printedCaption || '') ? region.printedCaption : '';
      const layout = layouts[index]; ids.push(fid);
      question.figures.push({ id: fid, caption, name: caption, captionPosition: 'bottom', layout, sourceLayout: { ...layout }, scene: constrained.scene });
    }
    question.blocks = question.blocks.filter(block => block.type !== 'figures');
    if (ids.length) {
      const beforeOptions = question.blocks.findIndex(block => block.type === 'options');
      const at = question.figurePlacement === 'afterOptions' ? question.blocks.length : Number.isInteger(question.figureBlockIndex)
        ? Math.max(0, Math.min(question.blocks.length, question.figureBlockIndex)) : beforeOptions < 0 ? question.blocks.length : beforeOptions;
      question.blocks.splice(at, 0, { id: `${sourceId}-figures-${qi}`, type: 'figures', figureIds: ids });
    }
  }
  return questions;
}

export function figureSvg(figure) {
  const layout = figure.layout || figure.sourceLayout || { width: 420, height: 300 };
  return exportSceneSvg(figure.scene, { width: Math.max(100, layout.width), height: Math.max(80, layout.height - (figure.caption ? 30 : 0)), fontSize: 22, strokeScale: 1 });
}

async function png(svg, width, height) {
  const image = new Image(), url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height); return canvas.toDataURL('image/png').split(',')[1];
  } finally { URL.revokeObjectURL(url); }
}

export async function exportFigureGroups(project) {
  const result = {};
  for (const question of project.questions) for (const block of question.blocks.filter(block => block.type === 'figures')) {
    const figures = block.figureIds.map(id => question.figures.find(figure => figure.id === id)).filter(Boolean);
    const values = figures.map((figure, index) => ({ ...figure, layout: figureLayout(figure, index, figures.length) }));
    const size = figureStageSize(values), height = Math.max(80, Math.ceil(size.height));
    const parts = values.map(figure => {
      const l = figure.layout, innerHeight = Math.max(30, l.height - (figure.caption ? 30 : 0));
      const svg = exportSceneSvg(figure.scene, { width: l.width, height: innerHeight, fontSize: 22, strokeScale: 1 });
      const body = svg.replace(/^<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '');
      const caption = figure.caption ? `<text x="${l.x + l.width / 2}" y="${l.y + l.height - 6}" font-size="22" font-family="SimSun,serif" text-anchor="middle">${escape(figure.caption)}</text>` : '';
      return `<svg x="${l.x}" y="${l.y}" width="${l.width}" height="${innerHeight}" viewBox="0 0 ${l.width} ${innerHeight}">${body}</svg>${caption}`;
    }).join('');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="${height}" viewBox="0 0 1000 ${height}"><rect width="1000" height="${height}" fill="white"/>${parts}</svg>`;
    result[block.id] = { dataBase64: await png(svg, 1500, Math.round(height * 1.5)), widthPx: 1500, heightPx: Math.round(height * 1.5) };
  }
  return result;
}
