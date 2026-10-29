import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { evaluateScene } from '../ui/geometry/geometry.js';

const ui = fileURLToPath(new URL('../ui/', import.meta.url));
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

async function launch(t, project) {
  const server = createServer(async (request, response) => {
    const relative = decodeURIComponent(new URL(request.url, 'http://local').pathname).replace(/^\//, '') || 'index.html';
    const filename = path.resolve(ui, relative);
    if (!filename.startsWith(ui)) { response.writeHead(403).end(); return; }
    try { const body = await readFile(filename); response.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream' }); response.end(body); }
    catch { response.writeHead(404).end(); }
  });
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const error = value => reject(value); server.once('error', error);
        server.listen(30000 + Math.floor(Math.random() * 25000), '127.0.0.1', () => { server.off('error', error); resolve(); });
      });
      break;
    } catch (error) { if (attempt >= 5 || error.code !== 'EADDRINUSE') throw error; }
  }
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } });
  await page.addInitScript(project => {
    const listeners = new Set(); window.__requests = []; window.__recognitions = []; window.__projectFixture = project;
    const deliver = data => { for (const listener of listeners) listener({ data }); };
    window.__respond = (id, result) => deliver({ type: 'response', id, ok: true, result });
    window.chrome ||= {}; window.chrome.webview = {
      addEventListener: (name, listener) => listeners.add(listener), removeEventListener: (name, listener) => listeners.delete(listener),
      postMessage: request => {
        window.__requests.push(request);
        if (request.command === 'ready') window.__respond(request.id, { uiReadyMs: performance.now() });
        else if (request.command === 'openProject') window.__respond(request.id, { json: JSON.stringify(window.__projectFixture), cancelled: false });
        else if (request.command === 'saveProject') window.__respond(request.id, { cancelled: false });
        else if (request.command === 'worker' && request.payload.method === 'recognize') window.__recognitions.push(request);
        else if (request.command === 'worker' && request.payload.method === 'cancel') window.__respond(request.id, { cancelled: true });
        // Deliberately leave warmup unresolved: the real editor must stay usable.
      },
    };
  }, project);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  return { page, errors };
}

const mathProject = () => ({ version: 3, title: '原图分行', sources: [], questions: [{ id: 'q1', category: '应用题', figures: [], blocks: [
  { id: 'h', type: 'text', role: 'heading', text: '计算：', sourceRowId: 'row1' },
  { id: 'p1', type: 'text', role: 'subquestion', label: '(1)', text: '$\\left|-5\\right|+\\left(-2026\\right)^0-\\sqrt{4}$', sourceRowId: 'row2' },
  { id: 'p2', type: 'text', role: 'subquestion', label: '(2)', text: '$\\dfrac{3a}{2a-1}-\\dfrac{a+1}{2a-1}$', sourceRowId: 'row3' },
] }] });

const geometryProject = () => {
  const scene = { points: [
    { id: 'B', kind: 'free', x: 0, y: 0, labelOffset: [-14, -12] },
    { id: 'C', kind: 'free', x: 3, y: 0, labelOffset: [12, -12] },
    { id: 'A', kind: 'rotate', source: 'B', center: 'C', angle: -90, labelOffset: [6, 14] },
    { id: 'M', kind: 'midpoint', from: 'B', to: 'C', labelOffset: [0, -14] },
  ], segments: [{ id: 'AB', from: 'A', to: 'B' }, { id: 'BC', from: 'B', to: 'C' }, { id: 'CA', from: 'C', to: 'A' }], lines: [], circles: [], angles: [] };
  const figures = [0, 1, 2].map(index => ({ id: `f${index + 1}`, caption: `图${index + 1}`, captionPosition: 'bottom',
    layout: { x: index * 330, y: 0, width: 310, height: 280 }, sourceLayout: { x: index * 330, y: 0, width: 310, height: 280 }, scene: structuredClone(scene) }));
  return { version: 3, title: '动态图形', sources: [], questions: [{ id: 'gq', category: '应用题', figures,
    blocks: [{ id: 'gt', type: 'text', role: 'paragraph', text: '如图，拖动 B，垂直和等长关系保持。' }, { id: 'gf', type: 'figures', figureIds: figures.map(figure => figure.id) }] }] };
};

async function withBackgroundSource(project) {
  const image = await readFile(new URL('../../tests/fixtures/recognition-rational-expressions.png', import.meta.url));
  project.sources = [{ id: 'background-source', name: 'background.png', dataUrl: `data:image/png;base64,${image.toString('base64')}` }];
  return project;
}

async function beginBackground(page) {
  const before = await page.evaluate(() => window.__recognitions.length);
  await page.locator('.source-controls button').first().click();
  await page.waitForFunction(count => window.__recognitions.length > count, before);
}

async function finishBackground(page) {
  await page.evaluate(() => window.__respond(window.__recognitions.at(-1).id, {
    questions: [{ id: 'background-q', category: '填空题', figures: [], blocks: [{ id: 'background-text', type: 'text', role: 'paragraph', text: '后台完成的题目' }] }], figureReadings: [],
  }));
  await page.waitForFunction(() => ['done', 'error'].some(state => document.querySelector('.source-badge')?.classList.contains(state)));
  assert.equal(await page.locator('.source-badge').evaluate(node => node.classList.contains('done')), true,
    await page.locator('.source-badge').textContent());
}

async function saveWithoutBlur(page) {
  return page.evaluate(() => {
    document.getElementById('save-project').click();
    return JSON.parse(window.__requests.filter(request => request.command === 'saveProject').at(-1).payload.json);
  });
}

test('background completion preserves an unblurred title and its selection and saves the current input', { timeout: 20000 }, async t => {
  const { page, errors } = await launch(t, await withBackgroundSource(mathProject()));
  await page.click('#open-project'); await beginBackground(page);
  await page.fill('#document-title', '正在输入的新标题');
  await page.locator('#document-title').evaluate(node => node.setSelectionRange(2, 5));
  await finishBackground(page);
  assert.deepEqual(await page.locator('#document-title').evaluate(node => ({ value: node.value, focused: node === document.activeElement,
    start: node.selectionStart, end: node.selectionEnd })), { value: '正在输入的新标题', focused: true, start: 2, end: 5 });
  assert.equal((await saveWithoutBlur(page)).title, '正在输入的新标题'); assert.deepEqual(errors, []);
});

test('background completion preserves active text and option editors and commits them before blur', { timeout: 25000 }, async t => {
  const project = mathProject();
  project.questions[0].blocks.push({ id: 'options-edit', type: 'options', columns: 2, items: [{ label: 'A', text: '甲' }, { label: 'B', text: '乙' }] });
  const { page, errors } = await launch(t, await withBackgroundSource(project));
  await page.click('#open-project');
  for (const [selector, value, expected] of [['textarea[data-block-id="h"]', '用户尚未失焦的正文', '用户尚未失焦的正文'],
    ['textarea[data-block-id="options-edit"]', 'A. 新选项甲\nB. 新选项乙', '新选项甲']]) {
    await beginBackground(page); await page.locator('.outline-question[data-question-id="q1"]').click();
    await page.locator(selector).fill(value);
    await page.locator(selector).evaluate(node => { node.setSelectionRange(1, 4); window.__editingNode = node; });
    await finishBackground(page);
    assert.deepEqual(await page.locator(selector).evaluate(node => ({ value: node.value, focused: node === document.activeElement,
      sameNode: node === window.__editingNode, start: node.selectionStart, end: node.selectionEnd })),
    { value, focused: true, sameNode: true, start: 1, end: 4 });
    const saved = await saveWithoutBlur(page), question = saved.questions.find(question => question.id === 'q1');
    assert.equal(selector.includes('options-edit') ? question.blocks.find(block => block.id === 'options-edit').items[0].text : question.blocks[0].text, expected);
  }
  assert.deepEqual(errors, []);
});

test('background completion preserves unblurred figure captions point labels and numeric coordinates', { timeout: 30000 }, async t => {
  const { page, errors } = await launch(t, await withBackgroundSource(geometryProject()));
  await page.click('#open-project'); await page.waitForSelector('.figure-frame');
  await page.locator('.figure-frame[data-figure-id="f3"] .figure-frame-canvas').click(); await page.selectOption('#point-select', 'B');
  const edits = [['figure-caption', '图9', q => q.figures[2].caption], ['point-label', '新顶点B', q => q.figures[2].scene.points[0].label],
    ['point-x', '-1.25', q => q.figures[2].scene.points[0].x], ['point-y', '1.5', q => q.figures[2].scene.points[0].y],
    ['label-x', '24', q => q.figures[2].scene.points[0].labelOffset[0]], ['label-y', '-20', q => q.figures[2].scene.points[0].labelOffset[1]]];
  for (const [name, input, read] of edits) {
    await beginBackground(page); await page.fill(`#${name}`, input);
    if (name.includes('caption') || name === 'point-label') await page.locator(`#${name}`).evaluate(node => node.setSelectionRange(1, 2));
    await finishBackground(page);
    const actual = await page.locator(`#${name}`).evaluate(node => ({ value: node.value, focused: node === document.activeElement,
      start: node.selectionStart, end: node.selectionEnd }));
    assert.equal(actual.value, input, name); assert.equal(actual.focused, true, name);
    if (name.includes('caption') || name === 'point-label') { assert.equal(actual.start, 1); assert.equal(actual.end, 2); }
    const saved = await saveWithoutBlur(page), question = saved.questions.find(question => question.id === 'gq');
    assert.equal(read(question), ['figure-caption', 'point-label'].includes(name) ? input : Number(input), name);
  }
  assert.deepEqual(errors, []);
});

test('typing before the same screenshot finishes preserves the edit and offers the new recognition separately', { timeout: 20000 }, async t => {
  const project = await withBackgroundSource(mathProject()); project.questions[0].sourceId = project.sources[0].id;
  const { page, errors } = await launch(t, project);
  await page.click('#open-project'); await beginBackground(page); await page.locator('.outline-question').click();
  await page.locator('textarea[data-block-id="h"]').fill('识别期间正在修改'); await finishBackground(page);
  assert.equal(await page.locator('.question').count(), 1);
  assert.equal(await page.locator('textarea[data-block-id="h"]').inputValue(), '识别期间正在修改');
  assert.equal(await page.getByRole('button', { name: '应用新结果', exact: true }).isVisible(), true);
  assert.equal((await saveWithoutBlur(page)).questions[0].blocks[0].text, '识别期间正在修改');
  await page.evaluate(() => document.getElementById('undo').click());
  assert.equal(await page.locator('textarea[data-block-id="h"]').inputValue(), '计算：');
  await page.evaluate(() => document.getElementById('redo').click());
  assert.equal(await page.locator('textarea[data-block-id="h"]').inputValue(), '识别期间正在修改'); assert.deepEqual(errors, []);
});

test('temporarily incomplete formulas stay editable without failing an unrelated background task', { timeout: 20000 }, async t => {
  const { page, errors } = await launch(t, await withBackgroundSource(mathProject()));
  await page.click('#open-project'); await beginBackground(page); await page.locator('.outline-question').click();
  const editor = page.locator('textarea[data-block-id="p1"]');
  await editor.fill('\\frac{a');
  await finishBackground(page);
  assert.equal(await editor.inputValue(), '\\frac{a'); assert.equal(await editor.evaluate(node => node === document.activeElement), true);
  await editor.fill('\\frac{a}{b}');
  await page.waitForFunction(() => document.querySelectorAll('.question .katex').length === 2);
  assert.equal((await saveWithoutBlur(page)).questions.find(question => question.id === 'q1').blocks[1].text, '\\frac{a}{b}');
  assert.deepEqual(errors, []);
});

test('a cancelled older attempt cannot hide the running retry controls', { timeout: 20000 }, async t => {
  const { page, errors } = await launch(t, await withBackgroundSource(mathProject()));
  await page.click('#open-project'); await beginBackground(page);
  await page.getByRole('button', { name: '取消', exact: true }).click(); await beginBackground(page);
  await page.evaluate(() => window.__respond(window.__recognitions[0].id, { questions: [], figureReadings: [] }));
  await page.waitForTimeout(50);
  assert.equal(await page.getByRole('button', { name: '取消', exact: true }).isVisible(), true);
  assert.equal(await page.getByRole('button', { name: '识别 / 重试', exact: true }).isVisible(), false);
  assert.equal(await page.locator('.source-badge').evaluate(node => node.classList.contains('running')), true);
  await finishBackground(page); assert.deepEqual(errors, []);
});

test('moving a figure to another question gives it a distinct identity from later source recognition', { timeout: 20000 }, async t => {
  const project = geometryProject(); project.questions.push({ id: 'target', category: '应用题', figures: [], blocks: [{ id: 'target-text', type: 'text', text: '另一题' }] });
  const { page, errors } = await launch(t, project);
  await page.click('#open-project'); await page.waitForSelector('.figure-frame');
  await page.locator('.figure-frame[data-figure-id="f3"] .figure-frame-canvas').click(); await page.selectOption('#figure-owner', 'target');
  const saved = await saveWithoutBlur(page), moved = saved.questions.find(question => question.id === 'target');
  assert.equal(moved.figures.length, 1); assert.notEqual(moved.figures[0].id, 'f3');
  assert.deepEqual(moved.blocks.at(-1).figureIds, [moved.figures[0].id]);
  assert.equal(saved.questions[0].figures.length, 2); assert.deepEqual(errors, []);
});

test('the complete new editor is usable without a worker and preserves all three source rows', { timeout: 25000 }, async t => {
  const { page, errors } = await launch(t, mathProject());
  await page.fill('#document-title', '无模型也能编辑');
  await page.click('#add-question');
  assert.equal(await page.locator('.question').count(), 1);
  await page.click('#open-project');
  await page.waitForSelector('.question .subquestion');
  await page.waitForFunction(() => document.querySelectorAll('.question .katex').length === 2);
  const blocks = await page.locator('.question .text-block').evaluateAll(nodes => nodes.map(node => ({ top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom, text: node.innerText })));
  assert.equal(blocks.length, 3); assert.match(blocks[0].text, /计算：$/);
  assert.ok(blocks[1].top >= blocks[0].bottom && blocks[2].top >= blocks[1].bottom);
  assert.equal(await page.locator('.answer-space').count(), 1);
  await page.click('.outline-question'); await page.fill('#answer-space', '0'); await page.locator('#answer-space').blur();
  assert.equal(await page.locator('.answer-space').count(), 0);
  await page.click('#save-project');
  const saved = await page.evaluate(() => JSON.parse(window.__requests.filter(request => request.command === 'saveProject').at(-1).payload.json));
  assert.deepEqual(saved.questions[0].blocks.map(block => block.sourceRowId), ['row1', 'row2', 'row3']);
  assert.equal(saved.questions[0].answerSpaceMm, 0); assert.deepEqual(errors, []);
});

test('three source drawings share one plane and changing a free vertex keeps dependent geometry', { timeout: 25000 }, async t => {
  const { page, errors } = await launch(t, geometryProject());
  await page.click('#open-project'); await page.waitForSelector('.figure-frame');
  const bounds = await page.locator('.figure-frame').evaluateAll(nodes => nodes.map(node => { const box = node.getBoundingClientRect(); return { x: box.left, y: box.top, right: box.right }; }));
  assert.equal(bounds.length, 3); assert.ok(bounds.every(box => Math.abs(box.y - bounds[0].y) < 1));
  assert.ok(bounds[1].x > bounds[0].right && bounds[2].x > bounds[1].right);
  await page.locator('.figure-frame[data-figure-id="f3"] .figure-frame-canvas').click();
  await page.selectOption('#point-select', 'B'); await page.fill('#point-x', '-1'); await page.locator('#point-x').blur();
  await page.click('#save-project');
  const saved = await page.evaluate(() => JSON.parse(window.__requests.filter(request => request.command === 'saveProject').at(-1).payload.json));
  const actual = evaluateScene(saved.questions[0].figures[2].scene).points;
  assert.equal(actual.B.x, -1); assert.ok(Math.abs(actual.A.x - 3) < 1e-9); assert.ok(Math.abs(actual.A.y - 4) < 1e-9); assert.equal(actual.M.x, 1);
  assert.equal(saved.questions[0].figures[0].scene.points[0].x, 0, 'other drawings retain their own point identities');
  assert.equal(await page.locator('.figure-frame.active').count(), 1); assert.deepEqual(errors, []);
});

test('Word export uses the confirmed snapshot even if another document is opened during image rendering', { timeout: 20000 }, async t => {
  const { page, errors } = await launch(t, geometryProject());
  await page.click('#open-project'); await page.waitForSelector('.figure-frame'); await page.click('#confirm-layout');
  await page.evaluate(() => { const original = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function() { return new Promise((resolve, reject) => setTimeout(() => original.call(this).then(resolve, reject), 200)); };
  });
  await page.click('#export-word'); await page.click('#new-project');
  await page.waitForFunction(() => window.__requests.some(request => request.command === 'worker' && request.payload.method === 'exportWord'));
  const input = await page.evaluate(() => window.__requests.find(request => request.command === 'worker' && request.payload.method === 'exportWord').payload.params);
  assert.equal(input.project.title, '动态图形'); assert.equal(input.project.questions.length, 1); assert.equal(input.project.sources.length, 0);
  assert.ok(input.figureGroups.gf.dataBase64.length > 100); assert.deepEqual(errors, []);
});

test('image imports from a replaced document are discarded before they can enter the new document', { timeout: 15000 }, async t => {
  const { page, errors } = await launch(t, mathProject());
  await page.evaluate(() => {
    const original = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function(file) { window.__reading = true; setTimeout(() => original.call(this, file), 250); };
  });
  const buffer = await readFile(new URL('../../tests/fixtures/recognition-rational-expressions.png', import.meta.url));
  await page.setInputFiles('#image-input', { name: 'old-reading.png', mimeType: 'image/png', buffer });
  await page.waitForFunction(() => window.__reading === true); await page.click('#new-project');
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.source-card').count(), 0); assert.deepEqual(errors, []);
});

test('reused source IDs in another project replace image pixels and retry closures', { timeout: 20000 }, async t => {
  const first = await readFile(new URL('../../tests/fixtures/recognition-rational-expressions.png', import.meta.url));
  const data = buffer => `data:image/png;base64,${buffer.toString('base64')}`;
  const a = { version: 3, title: 'A', questions: [], sources: [{ id: 'source-1', name: 'A.png', dataUrl: data(first) }] };
  const b = { ...a, title: 'B', sources: [{ id: 'source-1', name: 'B.png', dataUrl: data(Buffer.concat([first, Buffer.from('B')])) }] };
  const { page, errors } = await launch(t, a);
  await page.click('#open-project'); await page.waitForSelector('.source-card');
  await page.locator('.source-controls button').first().click();
  await page.waitForFunction(() => window.__recognitions.length === 1);
  await page.evaluate(project => { window.__projectFixture = project; }, b); await page.click('#open-project');
  await page.waitForFunction(() => document.querySelector('.source-name').textContent === 'B.png');
  assert.equal(await page.locator('.source-card img').getAttribute('src'), b.sources[0].dataUrl);
  await page.evaluate(() => window.__respond(window.__recognitions[0].id, { questions: [], figureReadings: [] }));
  await page.waitForTimeout(50);
  await page.locator('.source-controls button').first().click();
  await page.waitForFunction(() => window.__recognitions.length === 2);
  assert.equal(await page.evaluate(() => window.__recognitions[1].payload.params.imageDataUrl), b.sources[0].dataUrl);
  assert.deepEqual(errors, []);
});

test('multiple real screenshots start two independent requests and cancelled late results stay out of a new project', { timeout: 30000 }, async t => {
  const { page, errors } = await launch(t, mathProject());
  const first = await readFile(new URL('../../tests/fixtures/recognition-rational-expressions.png', import.meta.url));
  await page.setInputFiles('#image-input', [
    { name: 'one.png', mimeType: 'image/png', buffer: first },
    { name: 'two.png', mimeType: 'image/png', buffer: Buffer.concat([first, Buffer.from('two')]) },
  ]);
  await page.waitForFunction(() => window.__recognitions.length === 2);
  assert.equal(await page.locator('.source-card').count(), 2);
  const order = await page.evaluate(() => [...document.querySelectorAll('.source-card')].map(node => {
    const request = window.__recognitions.find(request => request.payload.params.sourceId === node.dataset.sourceId);
    return { id: request.id, sourceId: node.dataset.sourceId };
  }));
  const result = name => ({ questions: [{ id: name, category: '填空题', figures: [], blocks: [{ id: `${name}-b`, type: 'text', role: 'paragraph', text: name }] }], figureReadings: [] });
  await page.evaluate(({ id, value }) => window.__respond(id, value), { id: order[1].id, value: result('第二张') });
  await page.evaluate(({ id, value }) => window.__respond(id, value), { id: order[0].id, value: result('第一张') });
  await page.waitForFunction(() => document.querySelectorAll('.question').length === 2);
  assert.deepEqual(await page.locator('.question .text-block').allTextContents(), ['1、第一张', '2、第二张']);
  await page.click('#new-project');
  await page.setInputFiles('#image-input', { name: 'again.png', mimeType: 'image/png', buffer: first });
  await page.waitForFunction(() => window.__recognitions.length === 3);
  await page.click('#cancel-all'); await page.click('#new-project');
  await page.evaluate(value => window.__respond(window.__recognitions.at(-1).id, value), result('迟到旧结果'));
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.question').count(), 0); assert.deepEqual(errors, []);
});
