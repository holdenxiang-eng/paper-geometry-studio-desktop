import { createBridge } from './core/bridge.js';
import { createStore } from './core/store.js';
import { createJobQueue } from './core/jobs.js';
import { CATEGORIES, emptyProject, groupQuestions, questionAnswerSpace, importProject } from './core/document.js';
import { DOCUMENT_CSS, createQuestionElement, hydrateMath, renderPrintableDocument } from './core/render.js';
import { createPaperPagination } from './core/pagination.js';
import { completeFigures, figureSvg, exportFigureGroups, blankScene } from './core/figures.js';
import { createFigureStage } from './geometry/stage.js';
import { evaluateScene, movePoint, validateScene } from './geometry/geometry.js';
import { prepareRasterInWorker } from './geometry/raster-client.js';

const $ = id => document.getElementById(id), uid = kind => `${kind}-${crypto.randomUUID()}`;
const bridge = createBridge(), store = createStore(), records = new Map(), sourceNodes = new Map(), headings = new Map();
const jobsBySource = new Map(), pendingResults = new Map();
let selectedQuestion = null, selectedFigure = null, selectedPoint = null, confirmedRevision = -1;
let exporting = false, preview = false, serviceState = 'idle', toastTimer, openSequence = 0;
let inspectorQuestionKey = null, inspectorFigureKey = null;
const selected = () => store.project.questions.find(question => question.id === selectedQuestion);
const figure = () => selected()?.figures.find(value => value.id === selectedFigure);
const setFieldValue = (id, value, preserveFocused = true) => { const field = $(id); if (!preserveFocused || field !== document.activeElement) field.value = value; };
const sourceSignature = sourceId => JSON.stringify(store.project.questions.filter(question => question.sourceId === sourceId));
const notify = (message, error = false) => {
  $('toast').textContent = String(message); $('toast').classList.toggle('error', error); $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 8000 : 3500);
};
const paperStyles = document.createElement('style'); paperStyles.textContent = DOCUMENT_CSS; document.head.append(paperStyles);
const pagination = createPaperPagination($('paper-questions'), { onLayout: () => { for (const record of records.values()) for (const stage of record.stages) stage.resize(); } });

function loadScript(name) {
  if (document.querySelector(`script[data-library="${name}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = `vendor/${name}`; script.dataset.library = name;
    script.onload = resolve; script.onerror = () => { script.remove(); reject(new Error('排版组件未加载，请使用完整应用文件夹。')); };
    document.head.append(script);
  });
}
let graphReady;
function ensureGeometry() { return graphReady ||= loadScript('jsxgraphcore.js'); }

function service(message, state = 'loading') {
  serviceState = state; $('service-message').textContent = message;
  $('service-light').classList.toggle('ready', state === 'ready'); $('service-light').classList.toggle('error', state === 'error');
  $('retry-service').hidden = state !== 'error';
}

async function warmup() {
  service('正在后台准备识别', 'loading');
  try { const result = await bridge.request('worker', { method: 'warmup', params: {} });
    const state = result?.recognition || result;
    service(state?.message || (state?.state === 'ready' ? '本机识别已就绪' : '正在后台准备识别'), state?.state || 'loading');
  } catch (error) { service('识别准备失败，仍可编辑和保存', 'error'); }
}

const queue = createJobQueue({
  capacity: 2,
  async run(job, signal, progress) {
    progress('正在分析原图布局');
    const raster = await prepareRasterInWorker(job.source.dataUrl, { signal, onProgress: value => progress(value.message) });
    signal.throwIfAborted();
    const cancel = () => { void bridge.request('worker', { method: 'cancel', params: { jobId: job.id } }, { timeoutMs: 5000 }).catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      progress(serviceState === 'ready' ? '正在识别题目' : '截图已排队，正在准备识别');
      const result = await bridge.request('worker', { method: 'recognize', params: { jobId: job.id, sourceId: job.source.id, imageDataUrl: job.source.dataUrl, raster } });
      signal.throwIfAborted();
      const payload = result?.project || result;
      const questions = completeFigures(payload, raster, job.source.id);
      if (questions.some(question => question.figures.length)) await ensureGeometry();
      return { questions };
    } finally { signal.removeEventListener('abort', cancel); }
  },
  onChange(job) { if (job.epoch !== store.epoch) return; const latest = jobsBySource.get(job.source.id);
    if (latest && Number(latest.id.slice(4)) > Number(job.id.slice(4))) return;
    jobsBySource.set(job.source.id, job); renderSourceState(job.source.id); updateActions(); },
  onResult(job, result) {
    if (store.epoch !== job.epoch || !store.project.sources.some(source => source.id === job.source.id)) return;
    if (sourceSignature(job.source.id) !== job.baseline) {
      pendingResults.set(job.source.id, result); notify('新识别已完成，已保留你识别期间的修改。可以在截图旁应用新结果。');
    } else store.applySource(job.source.id, result.questions, job.epoch);
  },
});

bridge.onEvent(event => {
  if (event.event === 'job') queue.update(event.jobId, event.message || event.stage);
  else if (['worker-state', 'model-state', 'engine', 'state'].includes(event.event)) {
    const state = event.state || event.phase;
    const phase = event.event === 'worker-state' && state !== 'error' ? 'loading' : state || 'loading';
    service(event.message || (phase === 'ready' ? '本机识别已就绪' : phase === 'error' ? '识别暂不可用，仍可编辑和保存' : '正在后台准备识别'), phase);
  }
});

function startSource(source) { pendingResults.delete(source.id); queue.add(source, store.epoch, sourceSignature(source.id)); }

function renderSourceState(sourceId) {
  const record = sourceNodes.get(sourceId); if (!record) return;
  const job = jobsBySource.get(sourceId), count = store.project.questions.filter(question => question.sourceId === sourceId).length;
  record.badge.className = `source-badge ${job?.state || ''}`;
  record.badge.textContent = pendingResults.has(sourceId) ? '新结果已完成，当前修改已保留' : job?.state === 'done' ? `${count} 道题 · 已完成` : job?.message || (count ? `${count} 道题` : '待处理');
  record.cancel.hidden = !job || !['queued', 'running'].includes(job.state);
  record.retry.hidden = Boolean(job && ['queued', 'running'].includes(job.state));
  record.apply.hidden = !pendingResults.has(sourceId);
}

function showSource(sourceId) {
  const source = store.project.sources.find(source => source.id === sourceId); if (!source) return;
  $('source-dialog-title').textContent = source.name; $('source-dialog-image').src = source.dataUrl; $('source-dialog').showModal();
}

function renderSources() {
  const valid = new Set(store.project.sources.map(source => source.id));
  for (const [id, record] of sourceNodes) if (!valid.has(id)) { record.element.remove(); sourceNodes.delete(id); }
  for (const [sourceIndex, source] of store.project.sources.entries()) {
    if (!sourceNodes.has(source.id)) {
      const element = document.createElement('article'); element.className = 'source-card'; element.dataset.sourceId = source.id;
      const image = document.createElement('img'); image.src = source.dataUrl; image.alt = source.name; image.onclick = () => showSource(source.id);
      const description = document.createElement('div'); description.className = 'source-description';
      const name = document.createElement('span'); name.className = 'source-name'; name.textContent = source.name;
      const badge = document.createElement('span'); const controls = document.createElement('div'); controls.className = 'source-controls';
      const button = (text, action) => { const node = document.createElement('button'); node.textContent = text; node.onclick = action; controls.append(node); return node; };
      const retry = button('识别 / 重试', () => startSource(source));
      const cancel = button('取消', () => queue.cancelSource(source.id));
      const apply = button('应用新结果', () => { const result = pendingResults.get(source.id); if (result) { pendingResults.delete(source.id); store.applySource(source.id, result.questions, store.epoch); } });
      button('删除', () => { queue.forgetSource(source.id); pendingResults.delete(source.id); store.change(project => { project.sources = project.sources.filter(item => item.id !== source.id); project.questions = project.questions.filter(question => question.sourceId !== source.id); }); }).className = 'danger';
      description.append(name, badge, controls); element.append(image, description); $('source-list').append(element);
      sourceNodes.set(source.id, { element, badge, retry, cancel, apply });
    }
    const element = sourceNodes.get(source.id).element;
    if ($('source-list').children[sourceIndex] !== element) $('source-list').insertBefore(element, $('source-list').children[sourceIndex] || null);
    renderSourceState(source.id);
  }
  $('source-count').textContent = `${store.project.sources.length} 张`;
}

function renderOutline() {
  const fragment = document.createDocumentFragment();
  for (const group of groupQuestions(store.project)) {
    const heading = document.createElement('div'); heading.className = 'outline-category'; heading.textContent = group.title; fragment.append(heading);
    for (const question of group.questions) {
      const button = document.createElement('button'); button.className = `outline-question${question.id === selectedQuestion ? ' active' : ''}`;
      button.textContent = `${question.number}、${question.blocks.filter(block => block.type === 'text').map(block => block.text).join(' ').slice(0, 42)}`;
      button.dataset.questionId = question.id; button.onclick = () => selectQuestion(question.id, true); fragment.append(button);
    }
  }
  $('question-list').replaceChildren(fragment);
}

function destroyRecord(record) { for (const stage of record.stages) stage.destroy(); record.element.remove(); }

function renderPaper() {
  const valid = new Set(store.project.questions.map(question => question.id));
  for (const [id, record] of records) if (!valid.has(id)) { destroyRecord(record); records.delete(id); }
  const groups = [];
  for (const group of groupQuestions(store.project)) {
    let heading = headings.get(group.category);
    if (!heading) { heading = document.createElement('h2'); heading.className = 'paper-category-heading category-title'; headings.set(group.category, heading); }
    heading.textContent = group.title;
    const nodes = [];
    for (const question of group.questions) {
      const signature = JSON.stringify(question); let record = records.get(question.id);
      if (!record || record.signature !== signature) {
        if (record) destroyRecord(record);
        let element;
        try { element = createQuestionElement(question, { number: question.number, figureRenderer: value => figureSvg(value) }); }
        catch (error) {
          // A partially typed formula must not fail an unrelated recognition task.
          element = document.createElement('article'); element.className = 'question'; element.dataset.questionId = question.id;
          const message = document.createElement('p'); message.className = 'math-error'; message.textContent = `${question.number}、内容待校对：${error.message}`; element.append(message);
        }
        const stages = [];
        for (const [index, block] of question.blocks.filter(block => block.type === 'figures').entries()) {
          const old = element.querySelectorAll('.figures')[0]; if (!old) continue;
          const host = document.createElement('div'); host.className = 'figure-stage-block'; host.dataset.blockId = block.id; old.replaceWith(host);
          const stage = createFigureStage(host, {
            onSelect: fid => { selectedQuestion = question.id; selectedFigure = fid; selectedPoint = null; renderSelection(); },
            onPointSelect: pid => { selectedPoint = pid; renderFigureInspector(); },
            onSceneChange: (fid, scene) => store.change(project => { project.questions.find(q => q.id === question.id).figures.find(f => f.id === fid).scene = scene; }, { live: true, questionId: question.id }),
            onLayoutChange: (fid, layout) => store.change(project => { project.questions.find(q => q.id === question.id).figures.find(f => f.id === fid).layout = layout; }, { live: true, questionId: question.id }),
            onError: message => notify(message, true),
          });
          stage.setFigures(block.figureIds.map(fid => question.figures.find(value => value.id === fid)), question.id === selectedQuestion && block.figureIds.includes(selectedFigure) ? selectedFigure : null);
          stage.setLocked(preview); stages.push(stage);
        }
        element.addEventListener('click', () => { if (selectedQuestion !== question.id) selectQuestion(question.id); });
        record = { element, signature, stages }; records.set(question.id, record);
      }
      record.element.classList.toggle('selected', question.id === selectedQuestion); nodes.push(record.element);
    }
    groups.push({ category: group.category, title: group.title, heading, questions: nodes });
  }
  $('empty-state').hidden = valid.size > 0; $('paper-questions').hidden = !valid.size;
  pagination.update(groups, store.project.title); hydrateMath($('paper-questions'));
}

function selectQuestion(id, scroll = false) {
  selectedQuestion = id; selectedFigure = selectedPoint = null; renderSelection();
  if (scroll) records.get(id)?.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderSelection() {
  for (const [qid, record] of records) {
    record.element.classList.toggle('selected', qid === selectedQuestion);
    const question = store.project.questions.find(question => question.id === qid);
    const blocks = question?.blocks.filter(block => block.type === 'figures') || [];
    record.stages.forEach((stage, index) => stage.setFigures(blocks[index].figureIds.map(id => question.figures.find(figure => figure.id === id)), qid === selectedQuestion && blocks[index].figureIds.includes(selectedFigure) ? selectedFigure : null));
  }
  renderOutline(); renderInspector();
}

function editQuestion(mutator) {
  const id = selectedQuestion; if (!id) return;
  try { store.change(project => mutator(project.questions.find(question => question.id === id))); }
  catch (error) { notify(error.message, true); }
}

function renderInspector() {
  const question = selected(); $('selection-hint').hidden = Boolean(question); $('question-inspector').hidden = !question;
  const key = question ? `${store.epoch}:${question.id}` : null;
  const preserveEditor = key === inspectorQuestionKey && $('block-editors').contains(document.activeElement);
  const preserveFocused = key === inspectorQuestionKey;
  inspectorQuestionKey = key;
  if (question) {
    setFieldValue('question-category', question.category, preserveFocused); setFieldValue('answer-space', questionAnswerSpace(question), preserveFocused);
    $('show-source').hidden = !question.sourceId;
    if (!preserveEditor) {
      const controls = [];
      for (const [index, block] of question.blocks.entries()) {
        const section = document.createElement('div'); section.className = 'block-editor';
        const header = document.createElement('div'); header.className = 'block-editor-header';
        const label = document.createElement('span'); label.textContent = block.type === 'text' ? block.role === 'heading' ? '原图标题行' : block.label || '原图正文行' : block.type === 'options' ? '选项' : '图形组';
        const move = document.createElement('span');
        for (const [text, delta] of [['↑', -1], ['↓', 1]]) { const button = document.createElement('button'); button.textContent = text; button.onclick = () => editQuestion(q => { const to = index + delta; if (to >= 0 && to < q.blocks.length) [q.blocks[index], q.blocks[to]] = [q.blocks[to], q.blocks[index]]; }); move.append(button); }
        header.append(label, move); section.append(header);
        if (block.type === 'text') {
          const textarea = document.createElement('textarea'); textarea.value = block.text; textarea.dataset.blockId = block.id; textarea.setAttribute('aria-label', label.textContent);
          textarea.oninput = () => editQuestion(q => { q.blocks.find(value => value.id === block.id).text = textarea.value; }); section.append(textarea);
        } else if (block.type === 'options') {
          const columns = document.createElement('select'); columns.setAttribute('aria-label', '选项每行数量');
          for (let count = 1; count <= 4; count++) columns.add(new Option(`每行 ${count} 个选项`, String(count)));
          columns.value = block.columns; columns.onchange = () => editQuestion(q => { q.blocks.find(value => value.id === block.id).columns = Number(columns.value); }); section.append(columns);
          const textarea = document.createElement('textarea'); textarea.value = block.items.map(item => `${item.label}. ${item.text}`).join('\n'); textarea.dataset.blockId = block.id;
          textarea.oninput = () => editQuestion(q => { q.blocks.find(value => value.id === block.id).items = textarea.value.split('\n').filter(Boolean).map((line, i) => { const match = /^([^ .、．]+)[.、．]\s*(.*)$/.exec(line); return { label: match?.[1] || String.fromCharCode(65 + i), text: match?.[2] || line }; }); }); section.append(textarea);
        }
        controls.push(section);
      }
      $('block-editors').replaceChildren(...controls);
    }
  }
  renderFigureInspector();
}

function renderFigureInspector() {
  const value = figure(); $('figure-inspector').hidden = !value;
  const key = value ? `${store.epoch}:${selectedQuestion}:${value.id}:${selectedPoint || ''}` : null;
  const preserveFocused = key === inspectorFigureKey; inspectorFigureKey = key;
  if (!value) return;
  setFieldValue('figure-caption', value.caption || '', preserveFocused); setFieldValue('line-width', value.scene.lineWidth || 2, preserveFocused);
  $('figure-owner').replaceChildren(...store.project.questions.map((question, index) => new Option(`${question.category} ${index + 1}`, question.id)));
  $('figure-owner').value = selectedQuestion;
  $('point-select').replaceChildren(new Option('选择顶点', ''), ...value.scene.points.map(point => new Option(point.label || point.id, point.id)));
  $('point-select').value = selectedPoint || '';
  const point = value.scene.points.find(point => point.id === selectedPoint), coordinates = evaluateScene(value.scene).points[selectedPoint];
  for (const name of ['point-label', 'point-x', 'point-y', 'label-x', 'label-y']) $(name).disabled = !point;
  setFieldValue('point-label', point?.label || point?.id || '', preserveFocused);
  setFieldValue('point-x', coordinates ? Number(coordinates.x.toFixed(4)) : '', preserveFocused); setFieldValue('point-y', coordinates ? Number(coordinates.y.toFixed(4)) : '', preserveFocused);
  setFieldValue('label-x', point?.labelOffset?.[0] || 0, preserveFocused); setFieldValue('label-y', point?.labelOffset?.[1] || 0, preserveFocused);
}

function updateActions() {
  const active = queue.jobs.some(job => ['queued', 'running'].includes(job.state));
  $('cancel-all').hidden = !active; $('document-count').textContent = `${store.project.questions.length} 道题`;
  const confirmed = confirmedRevision === store.revision && store.project.questions.length > 0;
  $('confirm-layout').disabled = exporting || active || !store.project.questions.length;
  $('export-word').disabled = $('export-pdf').disabled = exporting || !confirmed;
  $('confirmation-message').textContent = confirmed ? '当前排版已确认，可以导出。' : active ? '截图正在处理，可继续编辑；完成后确认整卷。' : '校对题目、图形和布局后确认整卷。';
}

store.subscribe(change => {
  if (!store.project.questions.some(question => question.id === selectedQuestion)) selectedQuestion = selectedFigure = selectedPoint = null;
  if (change.reset) { inspectorQuestionKey = inspectorFigureKey = null; for (const record of records.values()) destroyRecord(record); records.clear(); }
  if (change.newDocument) { for (const record of sourceNodes.values()) record.element.remove(); sourceNodes.clear(); }
  if (change.live) {
    const question = store.project.questions.find(question => question.id === change.questionId);
    if (records.has(question?.id)) records.get(question.id).signature = JSON.stringify({ ...question, number: groupQuestions(store.project).flatMap(group => group.questions).find(q => q.id === question.id)?.number });
    renderFigureInspector();
  } else { setFieldValue('document-title', store.project.title, !change.reset); renderSources(); renderOutline(); renderPaper(); renderInspector(); }
  updateActions();
});

async function addImages(files) {
  if (exporting) return;
  const epoch = store.epoch;
  const inputs = [...files].filter(Boolean); if (!inputs.length) return;
  try {
    const additions = [];
    for (const file of inputs) {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) throw new Error('请选择不超过 8 MB 的 PNG/JPG/WebP 截图。');
      const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
      if (epoch !== store.epoch) return;
      if (store.project.sources.some(source => source.dataUrl === dataUrl) || additions.some(source => source.dataUrl === dataUrl)) continue;
      additions.push({ id: uid('source'), name: file.name || '粘贴截图.png', dataUrl });
    }
    if (store.project.sources.length + additions.length > 20) throw new Error('一份试卷最多放 20 张截图。');
    const bytes = [...store.project.sources, ...additions].reduce((sum, source) => sum + source.dataUrl.length * .75, 0);
    if (bytes > 48 * 1024 * 1024) throw new Error('截图总大小不能超过 48 MB，请适当裁小。');
    if (epoch !== store.epoch) return;
    store.change(project => { project.sources.push(...additions); });
    if ($('auto-recognize').checked) for (const source of additions) startSource(source);
  } catch (error) { notify(error.message || '截图未能导入。', true); }
}

async function exportDocument(kind) {
  if (exporting || confirmedRevision !== store.revision) return;
  const snapshot = { version: 3, title: store.project.title, sources: [], questions: structuredClone(store.project.questions) };
  exporting = true; updateActions();
  try {
    await loadScript('katex.min.js'); hydrateMath($('paper-questions'));
    if ($('paper-questions').querySelector('.math-error')) throw new Error('有公式尚未校对，不能将错误内容导出。');
    const fileName = snapshot.title.replace(/[\\/:*?"<>|]/g, '_') || '数学试卷';
    let result;
    if (kind === 'pdf') {
      const map = Object.fromEntries(snapshot.questions.flatMap(question => question.figures.map(value => [value.id, figureSvg(value)])));
      const html = renderPrintableDocument(snapshot, { figureSvgById: map, baseUrl: 'https://paper.local/' });
      result = await bridge.request('exportPdf', { html, fileName: `${fileName}.pdf` });
    } else {
      const figureGroups = await exportFigureGroups(snapshot);
      const document = await bridge.request('worker', { method: 'exportWord', params: { project: snapshot, figureGroups } });
      result = await bridge.request('saveFile', { base64: document.dataBase64, fileName: document.fileName || `${fileName}.docx`, kind: 'docx' });
    }
    if (!result?.cancelled) notify('试卷已导出。');
  } catch (error) { notify(error.message, true); }
  finally { exporting = false; updateActions(); }
}

function bind() {
  $('import-images').onclick = $('drop-zone').onclick = () => $('image-input').click();
  $('image-input').onchange = event => { void addImages(event.target.files); event.target.value = ''; };
  $('drop-zone').ondragover = event => { event.preventDefault(); $('drop-zone').classList.add('dragover'); };
  $('drop-zone').ondragleave = () => $('drop-zone').classList.remove('dragover');
  $('drop-zone').ondrop = event => { event.preventDefault(); $('drop-zone').classList.remove('dragover'); void addImages(event.dataTransfer.files); };
  document.addEventListener('paste', event => { const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()); if (files.length) { event.preventDefault(); void addImages(files); } });
  $('document-title').oninput = event => store.change(project => { project.title = event.target.value.trim() || '数学练习'; });
  $('document-title').onblur = () => setFieldValue('document-title', store.project.title, false);
  $('retry-service').onclick = warmup;
  $('recognize-all').onclick = () => { for (const source of store.project.sources) if (!store.project.questions.some(question => question.sourceId === source.id) || jobsBySource.get(source.id)?.state === 'error') startSource(source); };
  $('cancel-all').onclick = () => queue.cancelAll();
  $('new-project').onclick = () => { openSequence++; queue.reset(); pendingResults.clear(); jobsBySource.clear(); store.replace(emptyProject()); };
  $('open-project').onclick = async () => { const sequence = ++openSequence, epoch = store.epoch; try { const value = await bridge.request('openProject'); if (value.cancelled || sequence !== openSequence || epoch !== store.epoch) return;
    const project = importProject(JSON.parse(value.json)); for (const question of project.questions) for (const value of question.figures) { const errors = validateScene(value.scene); if (errors.length) throw new Error(errors.join('；')); }
    if (project.questions.some(question => question.figures.length)) await ensureGeometry();
    if (sequence !== openSequence || epoch !== store.epoch) return;
    queue.reset(); pendingResults.clear(); jobsBySource.clear(); store.replace(project);
  } catch (error) { notify(error.message, true); } };
  $('save-project').onclick = async () => { try { await bridge.request('saveProject', { json: JSON.stringify(store.project), fileName: `${store.project.title}.paper.json` }); } catch (error) { notify(error.message, true); } };
  $('undo').onclick = () => store.undo(); $('redo').onclick = () => store.redo();
  $('add-question').onclick = () => { const id = uid('question'); store.change(project => { project.questions.push({ id, category: '应用题', blocks: [{ id: uid('block'), type: 'text', role: 'paragraph', text: '' }], figures: [] }); }); selectQuestion(id); };
  $('question-category').onchange = event => editQuestion(question => { question.category = event.target.value; });
  $('answer-space').onchange = event => { const value = event.target.valueAsNumber; if (Number.isFinite(value) && value >= 0 && value <= 96) editQuestion(question => { question.answerSpaceMm = value; }); else { notify('答题空白应在 0 至 96 mm 之间。', true); renderInspector(); } };
  $('add-text-block').onclick = () => editQuestion(question => { question.blocks.push({ id: uid('block'), type: 'text', role: 'paragraph', text: '' }); });
  $('show-source').onclick = () => showSource(selected()?.sourceId);
  $('delete-question').onclick = () => { const id = selectedQuestion; store.change(project => { project.questions = project.questions.filter(question => question.id !== id); }); };
  for (const [name, delta] of [['question-up', -1], ['question-down', 1]]) $(name).onclick = () => { const question = selected(); if (!question) return;
    store.change(project => { const values = project.questions.filter(value => value.category === question.category), index = values.findIndex(value => value.id === question.id), target = values[index + delta];
      if (target) { const a = project.questions.indexOf(question), b = project.questions.indexOf(target); [project.questions[a], project.questions[b]] = [project.questions[b], project.questions[a]]; } }); };
  $('add-figure').onclick = async () => { await ensureGeometry(); const id = uid('figure'); editQuestion(question => { question.figures.push({ id, name: '', caption: '', scene: blankScene(), layout: { x: 0, y: 0, width: 500, height: 350 } }); question.blocks.push({ id: uid('block'), type: 'figures', figureIds: [id] }); }); selectedFigure = id; renderSelection(); };
  $('figure-caption').oninput = event => editQuestion(question => { const value = question.figures.find(value => value.id === selectedFigure); value.name = value.caption = event.target.value.trim(); });
  $('delete-figure').onclick = () => { const id = selectedFigure; selectedFigure = selectedPoint = null; editQuestion(question => { question.figures = question.figures.filter(value => value.id !== id); question.blocks = question.blocks.map(block => block.type === 'figures' ? { ...block, figureIds: block.figureIds.filter(fid => fid !== id) } : block).filter(block => block.type !== 'figures' || block.figureIds.length); }); };
  $('restore-figure-layout').onclick = () => editQuestion(question => { const value = question.figures.find(value => value.id === selectedFigure); if (value.sourceLayout) value.layout = structuredClone(value.sourceLayout); });
  $('figure-owner').onchange = event => { const fromId = selectedQuestion, fid = selectedFigure, toId = event.target.value; if (fromId === toId) return;
    store.change(project => { const from = project.questions.find(question => question.id === fromId), to = project.questions.find(question => question.id === toId), value = from.figures.find(value => value.id === fid);
      from.figures = from.figures.filter(value => value.id !== fid); from.blocks = from.blocks.map(block => block.type === 'figures' ? { ...block, figureIds: block.figureIds.filter(id => id !== fid) } : block).filter(block => block.type !== 'figures' || block.figureIds.length);
      value.id = uid('figure'); to.figures.push(value); to.blocks.push({ id: uid('block'), type: 'figures', figureIds: [value.id] }); selectedQuestion = toId; selectedFigure = value.id; }); renderSelection(); };
  $('point-select').onchange = event => { selectedPoint = event.target.value; for (const stage of records.get(selectedQuestion)?.stages || []) stage.selectPoint?.(selectedPoint); renderFigureInspector(); };
  const mutatePoint = action => editQuestion(question => { const value = question.figures.find(value => value.id === selectedFigure), point = value?.scene.points.find(point => point.id === selectedPoint); if (point) action(point); });
  $('point-label').oninput = event => mutatePoint(point => { point.label = event.target.value.trim() || point.id; });
  const coordinates = () => { const x = $('point-x').valueAsNumber, y = $('point-y').valueAsNumber;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    editQuestion(question => { const value = question.figures.find(value => value.id === selectedFigure); if (value && selectedPoint) value.scene = movePoint(value.scene, selectedPoint, x, y); }); };
  $('point-x').oninput = $('point-y').oninput = coordinates;
  $('label-x').oninput = $('label-y').oninput = () => { const x = $('label-x').valueAsNumber, y = $('label-y').valueAsNumber;
    if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) <= 200 && Math.abs(y) <= 200) mutatePoint(point => { point.labelOffset = [x, y]; }); };
  for (const id of ['figure-caption', 'point-label', 'point-x', 'point-y', 'label-x', 'label-y']) $(id).onblur = renderFigureInspector;
  $('line-width').onchange = event => editQuestion(question => { const value = question.figures.find(value => value.id === selectedFigure); if (value) value.scene.lineWidth = Number(event.target.value); });
  for (const button of document.querySelectorAll('[data-tool]')) button.onclick = () => { for (const stage of records.get(selectedQuestion)?.stages || []) stage.setTool(button.dataset.tool); };
  $('preview-toggle').onclick = () => { preview = !preview; document.body.classList.toggle('preview-mode', preview); $('preview-toggle').textContent = preview ? '返回编辑' : '打印预览'; for (const record of records.values()) for (const stage of record.stages) stage.setLocked(preview); };
  $('confirm-layout').onclick = () => { try { importProject(store.project); for (const question of store.project.questions) for (const value of question.figures) { const errors = validateScene(value.scene); if (errors.length) throw new Error(errors.join('；')); }
    confirmedRevision = store.revision; updateActions(); notify('当前排版已确认。'); } catch (error) { notify(error.message, true); } };
  $('export-word').onclick = () => exportDocument('word'); $('export-pdf').onclick = () => exportDocument('pdf');
  $('close-source-dialog').onclick = () => $('source-dialog').close();
  document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); $('save-project').click(); } });
}

bind(); renderSources(); renderPaper(); renderOutline(); renderInspector(); updateActions();
requestAnimationFrame(() => requestAnimationFrame(() => {
  document.body.dataset.ready = 'true';
  void bridge.request('ready', { titleEditable: !$('document-title').disabled, sourceCount: store.project.sources.length }, { timeoutMs: 5000 }).catch(() => {});
  setTimeout(() => { if (bridge.connected) void warmup(); }, 1500);
  void loadScript('katex.min.js').then(() => { hydrateMath($('paper-questions')); pagination.schedule(); }).catch(error => notify(error.message, true));
}));
