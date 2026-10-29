import { normalizeProject, normalizeQuestion, groupQuestions, questionAnswerSpace, normalizeMathText } from './document.js';

export const DOCUMENT_CSS = `
.exam-document{box-sizing:border-box;color:#111;background:#fff;font:12pt/1.6 "SimSun","Noto Sans CJK SC",serif;overflow-wrap:anywhere}
.exam-document *{box-sizing:border-box}.exam-document h1{text-align:center;font:700 19pt/1.4 "Microsoft YaHei",sans-serif;margin:0 0 7mm}
.exam-document .category+.category{margin-top:4mm}.exam-document .category-title{font:700 13pt/1.5 "Microsoft YaHei",sans-serif;margin:0 0 2mm;break-after:avoid}
.exam-document .question{margin:0;break-inside:avoid;page-break-inside:avoid}.exam-document .question+.question{margin-top:2mm}
.exam-document .text-block{margin:0 0 1mm;white-space:pre-wrap;orphans:2;widows:2}.exam-document .heading{break-after:avoid}
.exam-document .question-number{margin-right:.3em}.exam-document .subquestion-label{margin-right:.2em}.exam-document .subquestion{display:block}
.exam-document .options{display:grid;column-gap:6mm;row-gap:1mm;margin:1mm 0}.exam-document .option{min-width:0;white-space:pre-wrap;break-inside:avoid}
.exam-document .answer-space{display:block;min-height:0;break-inside:avoid;border:0}.exam-document .math{white-space:normal}
.exam-document .katex{font-size:1.08em}.exam-document .katex-display{margin:1mm 0;text-align:left}.exam-document .math-error{color:#a43a25;font:10pt sans-serif}
.exam-document .figures{position:relative;margin:1mm 0;break-inside:avoid}.exam-document .figure{position:absolute;margin:0;display:flex;flex-direction:column;min-width:0}
.exam-document .figure-content{min-height:0;flex:1;display:flex;align-items:center;justify-content:center}.exam-document .figure-content>svg{width:100%;height:100%;overflow:visible}
.exam-document figcaption{text-align:center;font-size:11pt;line-height:1.3;padding:.5mm 0;flex:none}.exam-document .figure[data-caption-position="top"] figcaption{order:-1}
.exam-document .figure-missing{color:#777;font:10pt sans-serif}.exam-document .figures.fallback{display:grid;gap:2mm;min-height:35mm}
.exam-document .figures.fallback .figure{position:relative;left:auto!important;top:auto!important;width:auto!important;height:100%!important;min-height:35mm}
@media print{.exam-document{width:170mm;margin:0}.exam-document .question{break-inside:avoid}.exam-document .answer-space{break-inside:avoid}}
`;

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const mathPattern = /(\$\$[\s\S]*?\$\$|\$(?:\\.|[^$])*?\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])/g;

function mathSpan(source, display = false) {
  let rendered = '';
  if (globalThis.katex?.renderToString) {
    try { rendered = globalThis.katex.renderToString(source, { displayMode: display, throwOnError: true, trust: false, strict: 'ignore' }); }
    catch { rendered = '<span class="math-error">公式待校对</span>'; }
  }
  return `<span class="math" data-math="${escape(source)}" data-display="${display}"${rendered ? ' data-math-rendered="true"' : ''}>${rendered || '<span class="math-pending">正在排版公式…</span>'}</span>`;
}

function richText(value) {
  const pieces = normalizeMathText(value).split(mathPattern);
  return pieces.map((piece, index) => {
    if (!(index % 2)) return escape(piece).replace(/\r?\n/g, '<br>');
    const size = piece.startsWith('$$') || piece.startsWith('\\') ? 2 : 1;
    return mathSpan(piece.slice(size, -size), piece.startsWith('$$') || piece.startsWith('\\['));
  }).join('');
}

export function hydrateMath(root = document) {
  if (!globalThis.katex?.renderToString) return false;
  for (const node of root.querySelectorAll('[data-math]:not([data-math-rendered])')) {
    try { node.innerHTML = globalThis.katex.renderToString(node.dataset.math, { displayMode: node.dataset.display === 'true', throwOnError: true, trust: false, strict: 'ignore' }); }
    catch { node.innerHTML = '<span class="math-error">公式待校对</span>'; }
    node.dataset.mathRendered = 'true';
  }
  return true;
}

function safeSvg(value) {
  if (typeof value !== 'string' || value.length > 2 * 1024 * 1024 || !/^\s*<svg\b/i.test(value) || !/<\/svg>\s*$/i.test(value)) return '';
  if (/<[!?]|\bon\w+\s*=|(?:^|\s)(?:href|xlink:href|src|style)\s*=|url\s*\(|@import|javascript:|data:/i.test(value)) return '';
  const allowed = new Set(['svg', 'g', 'path', 'line', 'circle', 'ellipse', 'polyline', 'polygon', 'rect', 'text', 'tspan', 'title', 'desc', 'defs', 'clippath', 'marker']);
  for (const match of value.matchAll(/<\/?([\w:-]+)\b/g)) if (!allowed.has(match[1].toLowerCase())) return '';
  return value;
}

function figureMarkup(question, block, figureSvgById) {
  const figures = block.figureIds.map(fid => question.figures.find(f => f.id === fid)).filter(Boolean);
  const layouts = figures.map(f => f.layout ?? f.sourceLayout);
  const positioned = layouts.every(l => l && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(l[k])) && l.x >= 0 && l.y >= 0 && l.width > 0 && l.height > 0 && l.x + l.width <= 1000 && l.y + l.height <= 5000);
  const bottom = positioned ? Math.max(1, ...layouts.map(l => l.y + l.height)) : 0;
  return `<div class="figures${positioned ? '' : ' fallback'}"${positioned ? ` style="aspect-ratio:1000/${bottom}"` : ` style="grid-template-columns:repeat(${Math.max(1, figures.length)},minmax(0,1fr))"`}>${figures.map((figure, index) => {
    const layout = layouts[index];
    const style = positioned ? ` style="left:${layout.x / 10}%;top:${layout.y / bottom * 100}%;width:${layout.width / 10}%;height:${layout.height / bottom * 100}%"` : '';
    const svg = safeSvg(figureSvgById instanceof Map ? figureSvgById.get(figure.id) : figureSvgById?.[figure.id]);
    return `<figure class="figure" data-figure-id="${escape(figure.id)}" data-caption-position="${figure.captionPosition === 'top' ? 'top' : 'bottom'}"${style}><div class="figure-content">${svg || '<span class="figure-missing">图形待校对</span>'}</div>${figure.caption ? `<figcaption>${escape(figure.caption)}</figcaption>` : ''}</figure>`;
  }).join('')}</div>`;
}

function questionMarkup(question, { number = 1, figureSvgById } = {}) {
  let numbered = false;
  const blocks = question.blocks.map(block => {
    if (block.type === 'text') {
      const prefix = numbered ? '' : `<span class="question-number">${escape(number)}、</span>`;
      numbered = true;
      return `<div class="text-block ${block.role}" data-block-id="${escape(block.id)}">${prefix}${block.label ? `<span class="subquestion-label">${escape(block.label)}</span>` : ''}${richText(block.text)}</div>`;
    }
    if (block.type === 'options') return `<div class="options" data-block-id="${escape(block.id)}" style="grid-template-columns:repeat(${block.columns},minmax(0,1fr))">${block.items.map(item => `<div class="option"><span class="option-label">${escape(item.label)}. </span>${richText(item.text)}</div>`).join('')}</div>`;
    return figureMarkup(question, block, figureSvgById);
  }).join('');
  const space = questionAnswerSpace(question);
  return `<article class="question" data-question-id="${escape(question.id)}" data-category="${escape(question.category)}">${numbered ? '' : `<div class="text-block"><span class="question-number">${escape(number)}、</span></div>`}${blocks}${space ? `<div class="answer-space" style="height:${space}mm" aria-label="答题空白"></div>` : ''}</article>`;
}

export function createQuestionElement(question, { number = 1, figureRenderer } = {}) {
  if (!globalThis.document) throw new Error('创建预览需要浏览器文档。');
  const holder = document.createElement('div');
  holder.innerHTML = questionMarkup(normalizeQuestion(question), { number });
  const element = holder.firstElementChild;
  if (figureRenderer) for (const target of element.querySelectorAll('[data-figure-id] .figure-content')) {
    const figure = question.figures.find(f => f.id === target.parentElement.dataset.figureId);
    const rendered = figureRenderer(figure, question);
    if (typeof rendered === 'string') target.innerHTML = safeSvg(rendered) || '<span class="figure-missing">图形待校对</span>';
    else if (rendered?.nodeType) target.replaceChildren(rendered);
  }
  hydrateMath(element);
  return element;
}

export function renderPrintableDocument(input, { figureSvgById = {}, baseUrl = 'https://paper.local/' } = {}) {
  const project = normalizeProject(input);
  const base = new URL(baseUrl);
  if (!['http:', 'https:', 'file:'].includes(base.protocol)) throw new Error('打印资源地址无效。');
  const vendor = file => escape(new URL(`vendor/${file}`, base).href);
  const content = groupQuestions(project).map(group => `<section class="category" data-category="${escape(group.category)}"><h2 class="category-title">${escape(group.title)}</h2>${group.questions.map(q => questionMarkup(q, { number: q.number, figureSvgById })).join('')}</section>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escape(project.title)}</title><link rel="stylesheet" href="${vendor('katex.min.css')}"><style>@page{size:A4;margin:20mm}html,body{margin:0;padding:0}${DOCUMENT_CSS}</style></head><body><main class="exam-document"><h1>${escape(project.title)}</h1>${content}</main><script>window.__printReady=false;window.__printError=null;</script><script src="${vendor('katex.min.js')}"></script><script>(async()=>{for(const n of document.querySelectorAll('[data-math]')){try{if(!window.katex)throw Error();n.innerHTML=katex.renderToString(n.dataset.math,{displayMode:n.dataset.display==='true',throwOnError:true,trust:false,strict:'ignore'});}catch{n.textContent='公式待校对';n.classList.add('math-error');window.__printError='公式排版失败，请校对后再导出。';}n.dataset.mathRendered='true';}if(document.querySelector('.figure-missing'))window.__printError='有图形尚未完成校对，请完成后再导出。';await document.fonts.ready;window.__printReady=!window.__printError;})();</script></body></html>`;
}
