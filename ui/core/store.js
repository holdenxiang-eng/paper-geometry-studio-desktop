import { emptyProject, importProject, normalizeQuestion } from './document.js';

const snapshot = value => ({ ...value, sources: value.sources.map(source => ({ ...source })), questions: structuredClone(value.questions) });

export function createStore() {
  let project = emptyProject(), epoch = 0, revision = 0;
  const undo = [], redo = [], listeners = new Set();
  const emit = change => { revision++; for (const listener of listeners) listener({ project, epoch, revision, ...change }); };
  const remember = () => { undo.push(snapshot(project)); if (undo.length > 40) undo.shift(); redo.length = 0; };
  return {
    get project() { return project; }, get epoch() { return epoch; }, get revision() { return revision; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    change(mutator, detail = {}) { remember(); mutator(project); emit(detail); },
    replace(value) { project = importProject(value); epoch++; undo.length = redo.length = 0; emit({ reset: true, newDocument: true }); },
    undo() { if (!undo.length) return false; redo.push(snapshot(project)); project = undo.pop(); emit({ reset: true }); return true; },
    redo() { if (!redo.length) return false; undo.push(snapshot(project)); project = redo.pop(); emit({ reset: true }); return true; },
    applySource(sourceId, questions, expectedEpoch) {
      if (epoch !== expectedEpoch || !project.sources.some(source => source.id === sourceId)) return false;
      const sourcePosition = project.sources.findIndex(source => source.id === sourceId);
      const values = questions.map((question, index) => normalizeQuestion({ ...question,
        id: `${sourceId}-question-${index + 1}`, sourceId, order: sourcePosition * 1000 + index }));
      remember();
      const insertion = project.questions.findIndex(question => question.sourceId === sourceId);
      const retained = project.questions.filter(question => question.sourceId !== sourceId);
      if (insertion >= 0) retained.splice(Math.min(insertion, retained.length), 0, ...values);
      else {
        const nextSource = retained.findIndex(question => project.sources.findIndex(source => source.id === question.sourceId) > sourcePosition);
        retained.splice(nextSource < 0 ? retained.length : nextSource, 0, ...values);
      }
      project.questions = retained; emit({ sourceId }); return true;
    },
  };
}
