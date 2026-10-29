/** The document is ordered source content; rendering never infers a new layout. */
export const CATEGORIES = Object.freeze(['选择题', '填空题', '判断题', '应用题']);
const NUMERALS = ['一', '二', '三', '四'];
const ROLES = new Set(['heading', 'paragraph', 'subquestion']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const text = value => typeof value === 'string' ? value : '';
const id = (value, fallback) => typeof value === 'string' && value ? value : fallback;
const heading = /^(\s*(?:计算|求值|化简|解答)\s*[:：])\s*(.*)$/u;
const secondLabel = /(?:^|\r?\n)[ \t]*[（(]2[）)]/u;

function balanced(formula) {
  let braces = 0;
  for (let i = 0; i < formula.length; i++) {
    if (formula[i] === '\\') { if ('{}$'.includes(formula[i + 1])) i++; continue; }
    if (formula[i] === '{') braces++;
    if (formula[i] === '}' && --braces < 0) return false;
  }
  return braces === 0 && (formula.match(/\\left\b/g) || []).length === (formula.match(/\\right\b/g) || []).length;
}

/** Only complete, high-signal bare TeX is wrapped; expressions are not solved. */
export function normalizeMathText(value) {
  value = text(value);
  const output = [];
  const pieces = value.split(/(\$\$[\s\S]*?\$\$|\$(?:\\.|[^$])*?\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\])/g);
  for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex++) {
    let piece = pieces[pieceIndex];
    if (pieceIndex % 2) { output.push(piece.startsWith('\\(') ? `$${piece.slice(2, -2)}$` : piece.startsWith('\\[') ? `$$${piece.slice(2, -2)}$$` : piece); continue; }
    piece = piece.replace(/([^\u3400-\u9fff，。；：！？\n]*\\(?:dfrac|tfrac|frac|sqrt|left)\b[^\u3400-\u9fff，。；：！？\n]*)/gu, (candidate, _formula, offset) => {
      if (candidate.includes('`') || /(?:[A-Za-z]:\\|\\\\)/.test(candidate)) return candidate;
      const leading = /^\s*/.exec(candidate)[0], trailing = /\s*$/.exec(candidate)[0];
      const formula = candidate.slice(leading.length, candidate.length - trailing.length || undefined);
      if (!balanced(formula)) throw new Error('公式不完整，请校对括号、分子分母后再导入。');
      return `${leading}$${formula}$${trailing}`;
    });
    output.push(piece);
  }
  return output.join('');
}

function labelAtStart(line, sequence) {
  let match = /^[ \t]*([（(]\d{1,3}[）)])[ \t]*(.*)$/u.exec(line);
  if (match) return { label: match[1].replace('（', '(').replace('）', ')'), body: match[2] };
  if (!sequence) return null;
  const trimmed = line.trimStart();
  const opener = ['$$', '$', '\\('].find(prefix => trimmed.startsWith(prefix)) || '';
  match = /^\\left[ \t]*\([ \t]*1[ \t]*\\right[ \t]*\)[ \t]*(.*)$/u.exec(trimmed.slice(opener.length));
  if (!match) return null;
  return { label: '(1)', body: opener + match[1] };
}

function legacyTextBlocks(stem, prefix, sequence = secondLabel.test(stem)) {
  const result = [];
  for (const raw of text(stem).split(/\r?\n/)) {
    if (!raw.trim()) {
      if (result.length) result[result.length - 1].text += '\n';
      continue;
    }
    let line = raw;
    const title = heading.exec(line);
    if (title && (!title[2] || sequence && labelAtStart(title[2], true))) {
      result.push({ id: `${prefix}-${result.length + 1}`, type: 'text', role: 'heading', text: title[1].trim() });
      line = title[2];
      if (!line) continue;
    }
    const part = labelAtStart(line, sequence);
    result.push({ id: `${prefix}-${result.length + 1}`, type: 'text', role: part ? 'subquestion' : 'paragraph',
      ...(part ? { label: part.label } : {}), text: normalizeMathText(part ? part.body : line) });
  }
  return result;
}

export function normalizeBlocks(values = [], { prefix = 'block' } = {}) {
  if (!Array.isArray(values) || values.length > 1000) throw new Error('题目内容块无效。');
  return values.flatMap((value, index) => {
    if (!object(value)) throw new Error('题目内容块必须是对象。');
    const blockId = id(value.id, `${prefix}-${index + 1}`);
    if (value.type === 'text') {
      const role = ROLES.has(value.role) ? value.role : 'paragraph';
      if (text(value.text).length > 80000) throw new Error('题文过长。');
      // A v3 block records a physical source row. It must never be split merely
      // because it happens to contain a heading and a numbered expression.
      return [{ id: blockId, type: 'text', role, ...(value.label ? { label: text(value.label) } : {}),
        ...(value.sourceRowId !== undefined ? { sourceRowId: String(value.sourceRowId) } : {}),
        ...(value.rowId !== undefined ? { rowId: String(value.rowId) } : {}), text: normalizeMathText(value.text) }];
    }
    if (value.type === 'figures') {
      if (!Array.isArray(value.figureIds) || value.figureIds.some(v => typeof v !== 'string')) throw new Error('图形块引用无效。');
      return [{ id: blockId, type: 'figures', figureIds: [...value.figureIds] }];
    }
    if (value.type === 'options') {
      const columns = value.columns ?? 1;
      if (!Number.isInteger(columns) || columns < 1 || columns > 4 || !Array.isArray(value.items)) throw new Error('选项排版无效。');
      return [{ id: blockId, type: 'options', columns, items: value.items.map((item, i) => ({ label: text(item?.label) || String.fromCharCode(65 + i), text: normalizeMathText(item?.text ?? item) })) }];
    }
    throw new Error('不支持的题目内容块。');
  });
}

function categoryOf(question, blocks) {
  const aliases = { 单项选择题: '选择题', 多项选择题: '选择题', 解答题: '应用题', 计算题: '应用题', 证明题: '应用题' };
  if (CATEGORIES.includes(question.category)) return question.category;
  if (aliases[question.category]) return aliases[question.category];
  if (question.category) throw new Error('题型必须是选择题、填空题、判断题或应用题。');
  if (blocks.some(b => b.type === 'options' && b.items.length)) return '选择题';
  const content = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
  if (/_{2,}|＿+|（\s*）|\(\s*\)/u.test(content)) return '填空题';
  if (/判断.{0,12}(?:正误|对错|是否正确)/u.test(content)) return '判断题';
  return '应用题';
}

function normalizeFigure(value, index) {
  if (!object(value)) throw new Error('图形数据无效。');
  const figure = clone(value);
  figure.id = id(value.id, `figure-${index + 1}`);
  const caption = text(value.caption !== undefined ? value.caption : value.name).trim();
  figure.caption = /^(?:题图|提图|第\d+题图)$/u.test(caption) ? '' : caption;
  figure.name = figure.caption;
  return figure;
}

export function normalizeQuestion(value, index = 0, version = 3) {
  if (!object(value)) throw new Error('题目必须是对象。');
  const questionId = id(value.id, `question-${index + 1}`);
  const figures = (value.figures ?? []).map(normalizeFigure);
  if (version < 3) for (const figure of figures) figure.id = `${encodeURIComponent(questionId)}::${encodeURIComponent(figure.id)}`;
  let blocks;
  if (Array.isArray(value.blocks)) blocks = normalizeBlocks(value.blocks, { prefix: `${questionId}-block` });
  else {
    blocks = legacyTextBlocks(text(value.stem ?? value.question), `${questionId}-text`);
    const figureBlock = figures.length ? { id: `${questionId}-figures`, type: 'figures', figureIds: figures.map(f => f.id) } : null;
    const options = value.options?.length ? normalizeBlocks([{ id: `${questionId}-options`, type: 'options', columns: value.presentation?.optionColumns ?? Math.min(4, value.options.length), items: value.options }])[0] : null;
    blocks.push(...(value.presentation?.figurePlacement === 'afterOptions' ? [options, figureBlock] : [figureBlock, options]).filter(Boolean));
  }
  const figureIds = new Set(figures.map(f => f.id));
  if (figureIds.size !== figures.length || blocks.some(b => b.type === 'figures' && b.figureIds.some(fid => !figureIds.has(fid)))) throw new Error('图形块引用了不存在或重复的图形。');
  const result = { id: questionId, ...(value.sourceId !== undefined ? { sourceId: text(value.sourceId) } : {}),
    ...(value.originalNumber !== undefined ? { originalNumber: text(String(value.originalNumber)) } : {}),
    category: categoryOf(value, blocks), blocks, figures };
  const answerSpace = value.answerSpaceMm ?? value.presentation?.answerSpaceMm ?? (value.answerLines > 0 ? value.answerLines * 8 : undefined);
  if (answerSpace !== undefined) {
    if (!Number.isFinite(answerSpace) || answerSpace < 0 || answerSpace > 96) throw new Error('答题留白须为 0 至 96 毫米。');
    result.answerSpaceMm = answerSpace;
  }
  return result;
}

export function normalizeProject(value) {
  if (!object(value) || ![1, 2, 3].includes(value.version ?? 3)) throw new Error('不支持的工程版本。');
  const questions = value.version === 1 ? [{ id: 'question-1', stem: value.question, figures: value.figures ?? [] }] : value.questions ?? [];
  if (!Array.isArray(questions) || questions.length > 200 || !Array.isArray(value.sources ?? [])) throw new Error('工程题目或截图数据无效。');
  const normalized = questions.map((q, i) => normalizeQuestion(q, i, value.version));
  if (new Set(normalized.map(q => q.id)).size !== normalized.length) throw new Error('题目编号重复。');
  const figureIds = normalized.flatMap(q => q.figures.map(f => f.id));
  if (new Set(figureIds).size !== figureIds.length) throw new Error('图形标识重复，不能覆盖其他题目的图形。');
  return { version: 3, title: text(value.title) || '数学练习', sources: clone(value.sources ?? []), questions: normalized };
}

export const importProject = normalizeProject;
export const emptyProject = () => ({ version: 3, title: '数学练习', sources: [], questions: [] });

export function questionAnswerSpace(question) {
  return question.answerSpaceMm ?? (question.category === '应用题' ? 24 : 0);
}

export function groupQuestions(projectOrQuestions) {
  const questions = Array.isArray(projectOrQuestions) ? projectOrQuestions : projectOrQuestions.questions;
  return CATEGORIES.map(category => ({ category, questions: questions.filter(q => q.category === category).map((q, i) => ({ ...q, number: i + 1 })) }))
    .filter(group => group.questions.length).map((group, i) => ({ ...group, title: `${NUMERALS[i]}、${group.category}` }));
}
