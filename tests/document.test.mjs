import test from 'node:test';
import assert from 'node:assert/strict';
import katex from 'katex';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeProject, normalizeBlocks, groupQuestions, questionAnswerSpace } from '../ui/core/document.js';
import { renderPrintableDocument, DOCUMENT_CSS } from '../ui/core/render.js';
import { exportSceneSvg } from '../ui/geometry/board.js';

const absolute = String.raw`\left|-5\right|+\left(-2026\right)^{0}-\sqrt{4}`;
const fractions = String.raw`\dfrac{3a}{2a-1}-\dfrac{a+1}{2a-1}`;

test('a legitimate SVG font-style attribute is printable while active style attributes remain blocked', () => {
  const project = { version: 3, title: '标注', sources: [], questions: [{ id: 'svg-q', category: '应用题',
    blocks: [{ id: 'svg-b', type: 'figures', figureIds: ['svg-f'] }], figures: [{ id: 'svg-f', caption: '', scene: {}, layout: { x: 0, y: 0, width: 300, height: 200 } }] }] };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text x="10" y="20" font-style="italic">l</text></svg>';
  const html = renderPrintableDocument(project, { figureSvgById: { 'svg-f': svg } }).split('<script>')[0];
  assert.match(html, /font-style="italic"/);
  assert.doesNotMatch(html, /class="figure-missing"/);
  assert.match(renderPrintableDocument(project, { figureSvgById: { 'svg-f': svg.replace('font-style="italic"', 'style="fill:red"') } }).split('<script>')[0], /class="figure-missing"/);
});
const legacy = stem => ({ version: 2, title: '原图排版', sources: [], questions: [
  { id: 'q1', category: '应用题', stem, figures: [], options: [] },
] });

test('legacy calculation preserves heading and both subquestions as three separate blocks', () => {
  for (const stem of [String.raw`计算：\left(1\right)` + absolute + '\n(2)' + fractions,
    String.raw`计算：\(\left(1\right)` + absolute + String.raw`\)` + '\n(2)' + fractions,
    `计算：\n(1)$${absolute}$\n(2)$${fractions}$`,
    `计算：(1)$${absolute}$\n(2)$${fractions}$`]) {
    const q = normalizeProject(legacy(stem)).questions[0];
    assert.deepEqual(q.blocks.map(({ type, role, label }) => [type, role, label || '']), [
      ['text', 'heading', ''], ['text', 'subquestion', '(1)'], ['text', 'subquestion', '(2)'],
    ]);
    assert.equal(q.blocks[0].text, '计算：');
    assert.ok([`$${absolute}$`, String.raw`\(` + absolute + String.raw`\)`].includes(q.blocks[1].text), JSON.stringify(q.blocks[1].text));
    assert.equal(q.blocks[2].text, `$${fractions}$`);
    assert.equal(normalizeProject(normalizeProject(legacy(stem))).questions[0].blocks.length, 3);
  }
});

test('legacy figure IDs are scoped by question and v3 duplicate IDs cannot overwrite another drawing', () => {
  const input = legacy('图形题');
  input.questions[0].figures = [{ id: 'figure-1', name: '图1', scene: { points: [{ id: 'A', x: 1, y: 1 }] } }];
  input.questions.push({ ...structuredClone(input.questions[0]), id: 'q2' });
  const project = normalizeProject(input);
  assert.notEqual(project.questions[0].figures[0].id, project.questions[1].figures[0].id);
  assert.equal(project.questions[0].blocks[1].figureIds[0], project.questions[0].figures[0].id);
  assert.equal(project.questions[0].figures[0].scene.points[0].id, 'A');
  const duplicate = structuredClone(project);
  duplicate.questions[1].figures[0].id = duplicate.questions[0].figures[0].id;
  duplicate.questions[1].blocks[1].figureIds[0] = duplicate.questions[0].figures[0].id;
  assert.throws(() => normalizeProject(duplicate), /图形.*重复/);
});

test('genuine mathematical (1) and ordinary source newlines are preserved', () => {
  const expression = String.raw`\left(1\right)\left|-5\right|+\sqrt{4}`;
  const q = normalizeProject(legacy('计算：$' + expression + '$')).questions[0];
  assert.equal(q.blocks.length, 1);
  assert.equal(q.blocks[0].role, 'paragraph');
  assert.equal(q.blocks[0].text, '计算：$' + expression + '$');
  const blocks = normalizeBlocks([{ id: 'p', type: 'text', role: 'paragraph', text: '原图第一行\n原图第二行' }]);
  assert.equal(blocks[0].text, '原图第一行\n原图第二行');
});

test('explicit v3 source row blocks keep a genuinely inline first subquestion inline', () => {
  const sourceText = `计算：(1)$${absolute}$`;
  const blocks = normalizeBlocks([
    { id: 'row1', type: 'text', role: 'heading', sourceRowId: 'source-line-1', text: sourceText },
    { id: 'row2', type: 'text', role: 'subquestion', sourceRowId: 'source-line-2', label: '(2)', text: `$${fractions}$` },
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, sourceText);
  assert.equal(blocks[0].sourceRowId, 'source-line-1');
  assert.equal(blocks[1].sourceRowId, 'source-line-2');
});

test('fixed category order skips empty groups, renumbers each group and limits answer room to applications', () => {
  const project = normalizeProject({ version: 3, title: '分类', sources: [], questions: [
    { id: 'a', category: '应用题', blocks: [{ type: 'text', text: '证明' }] },
    { id: 'f', category: '填空题', blocks: [{ type: 'text', text: '____' }] },
    { id: 'c1', category: '选择题', blocks: [{ type: 'text', text: '选择1' }] },
    { id: 'c2', category: '选择题', blocks: [{ type: 'text', text: '选择2' }] },
  ] });
  const groups = groupQuestions(project);
  assert.deepEqual(groups.map(g => g.title), ['一、选择题', '二、填空题', '三、应用题']);
  assert.deepEqual(groups.map(g => g.questions.map(q => q.number)), [[1, 2], [1], [1]]);
  assert.equal(questionAnswerSpace(project.questions[0]), 24);
  assert.equal(questionAnswerSpace(project.questions[1]), 0);
  assert.equal(questionAnswerSpace({ ...project.questions[0], answerSpaceMm: 0 }), 0);
});

test('figure order, geometry metadata, source position and option columns survive v2 import', () => {
  const figure = { id: 'f1', name: '题图', scene: { points: [{ id: 'A', x: 1, y: 2, labelOffset: [-15, -12] }] },
    sourceLayout: { x: 12, y: 8, width: 280, height: 210 }, captionPosition: 'bottom' };
  const input = legacy('如图，选择正确选项。');
  input.questions[0].figures = [figure, { id: 'f2', name: '图2', scene: {} }];
  input.questions[0].options = [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }];
  input.questions[0].presentation = { optionColumns: 2, figurePlacement: 'beforeOptions' };
  let q = normalizeProject(input).questions[0];
  assert.deepEqual(q.blocks.map(b => b.type), ['text', 'figures', 'options']);
  assert.equal(q.blocks[2].columns, 2);
  assert.equal(q.figures[0].caption, '');
  assert.equal(q.figures[1].caption, '图2');
  assert.deepEqual(q.figures[0].scene, figure.scene);
  assert.deepEqual(q.figures[0].sourceLayout, figure.sourceLayout);
  input.questions[0].presentation.figurePlacement = 'afterOptions';
  q = normalizeProject(input).questions[0];
  assert.deepEqual(q.blocks.map(b => b.type), ['text', 'options', 'figures']);
});

test('one shared print layout keeps calculation on its own row and never prints bare formula source', () => {
  const previous = globalThis.katex; globalThis.katex = katex;
  try {
    const project = normalizeProject(legacy(String.raw`计算：\left(1\right)` + absolute + '\n(2)' + fractions));
    const html = renderPrintableDocument(project);
    assert.match(html, /class="text-block heading"[^>]*>[\s\S]*?计算：[\s\S]*?<\/div>\s*<div class="text-block subquestion"/);
    assert.equal((html.match(/class="text-block subquestion"/g) || []).length, 2);
    assert.equal((html.match(/class="katex"/g) || []).length, 2);
    assert.match(html, /class="answer-space" style="height:24mm"/);
    assert.match(html, /https:\/\/paper\.local\/vendor\/katex\.min\.js/);
    assert.match(DOCUMENT_CSS, /\.exam-document/);
  } finally { globalThis.katex = previous; }
});

test('rendering escapes document text and rejects executable SVG content', () => {
  const project = normalizeProject({ version: 3, title: '<img src=x onerror=alert(1)>', sources: [], questions: [
    { id: 'q', category: '应用题', blocks: [{ type: 'text', text: '<script>alert(1)</script>' }, { type: 'figures', figureIds: ['f'] }], figures: [{ id: 'f', caption: '提图', scene: {} }] },
  ] });
  const html = renderPrintableDocument(project, { figureSvgById: { f: '<svg><script>alert(1)</script></svg>' } });
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert/);
  assert.doesNotMatch(html, /<figcaption/);
  assert.throws(() => normalizeProject({ ...project, questions: [{ ...project.questions[0], blocks: [{ type: 'figures', figureIds: ['missing'] }] }] }), /图形/);
  const encodedCss = renderPrintableDocument(project, { figureSvgById: { f: '<svg style="fill:&#117;rl(https://remote.invalid/a)"><path d="M0 0"/></svg>' } });
  assert.doesNotMatch(encodedCss, /<svg style=/);
});

test('real preview and PDF keep the heading and source subquestions on different rows', { timeout: 25000 }, async t => {
  const ui = path.resolve(fileURLToPath(new URL('../ui/', import.meta.url)));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      const file = path.resolve(ui, '.' + url.pathname);
      if (!file.startsWith(ui + path.sep)) throw Error('path');
      res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
      res.end(await readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage();
  const input = legacy(String.raw`计算：\left(1\right)` + absolute + '\n(2)' + fractions);
  await page.setContent(renderPrintableDocument(input, { baseUrl: base }));
  await page.waitForFunction(() => window.__printReady === true);
  const printed = await page.locator('.text-block').evaluateAll(nodes => nodes.map(n => ({ role: n.className, top: n.getBoundingClientRect().top, bottom: n.getBoundingClientRect().bottom, text: n.innerText })));
  assert.equal(printed.length, 3);
  assert.match(printed[0].text, /1、计算：/);
  assert.doesNotMatch(printed[0].text, /\(1\)/);
  assert.ok(printed[1].top >= printed[0].bottom && printed[2].top >= printed[1].bottom);
  assert.equal(await page.locator('.katex').count(), 2);
  assert.equal(await page.locator('.math-error').count(), 0);
  const pdf = await page.pdf({ format: 'A4' });
  assert.ok(pdf.length > 2000);
  const scene = { points: [{ id: 'A', kind: 'free', x: 0, y: 2, labelOffset: [-16, 14] }, { id: 'B', kind: 'free', x: 0, y: 0 }, { id: 'C', kind: 'free', x: 2, y: 0 }],
    segments: [{ id: 'AB', from: 'A', to: 'B' }, { id: 'BC', from: 'B', to: 'C' }, { id: 'CA', from: 'C', to: 'A' }], lines: [], circles: [], angles: [] };
  const figures = [1, 2, 3].map((n, i) => ({ id: `f${n}`, caption: `图${n}`, captionPosition: 'bottom', scene,
    sourceLayout: { x: 20 + i * 330, y: 10, width: 300, height: 280 } }));
  await page.setContent(renderPrintableDocument({ version: 3, title: '原图同一行', sources: [], questions: [{ id: 'figure-q', category: '选择题', figures,
    blocks: [{ type: 'text', text: '如图，选择正确答案。' }, { type: 'figures', figureIds: figures.map(f => f.id) },
      { type: 'options', columns: 4, items: ['甲', '乙', '丙', '丁'].map((value, i) => ({ label: 'ABCD'[i], text: value })) }] }] },
    { baseUrl: base, figureSvgById: Object.fromEntries(figures.map(f => [f.id, exportSceneSvg(f.scene)])) }));
  await page.waitForFunction(() => window.__printReady === true);
  const positions = await page.locator('figure').evaluateAll(nodes => nodes.map(n => ({ top: n.getBoundingClientRect().top, left: n.getBoundingClientRect().left, bottom: n.getBoundingClientRect().bottom })));
  assert.ok(positions.every(n => Math.abs(n.top - positions[0].top) < 1), 'three source-row drawings stay on the same plane');
  assert.ok(positions[0].left < positions[1].left && positions[1].left < positions[2].left);
  assert.ok((await page.locator('.options').boundingBox()).y >= Math.max(...positions.map(n => n.bottom)));
  assert.deepEqual(await page.locator('figcaption').allTextContents(), ['图1', '图2', '图3']);
  await page.goto(base + 'core/document.js');
  const preview = await page.evaluate(async ({ input, base }) => {
    const { normalizeProject } = await import(base + 'core/document.js');
    const { createQuestionElement, DOCUMENT_CSS } = await import(base + 'core/render.js');
    const style = document.createElement('style'); style.textContent = DOCUMENT_CSS; document.head.append(style);
    const root = document.createElement('main'); root.className = 'exam-document'; document.body.replaceChildren(root);
    root.append(createQuestionElement(normalizeProject(input).questions[0], { number: 3 }));
    const unsafe = { ...normalizeProject(input).questions[0], answerSpaceMm: '2\" onmouseover=alert(1)', blocks: [{ type: 'text', role: 'paragraph\" onclick=alert(1)', text: '<img onerror=alert(1)>' }] };
    let rejected = false; try { createQuestionElement(unsafe); } catch { rejected = true; }
    return { roles: [...root.querySelectorAll('.text-block')].map(n => n.className), first: root.querySelector('.text-block').textContent, rejected };
  }, { input, base });
  assert.deepEqual(preview.roles, printed.map(n => n.role));
  assert.equal(preview.first, '3、计算：');
  assert.equal(preview.rejected, true);
  await page.setContent(renderPrintableDocument({ version: 3, title: '校对', sources: [], questions: [{ id: 'bad', category: '应用题', blocks: [{ type: 'text', text: '$\\unknowncommand{4}$' }], figures: [] }] }, { baseUrl: base }));
  await page.waitForFunction(() => Boolean(window.__printError));
  assert.equal(await page.evaluate(() => window.__printReady), false);
});
