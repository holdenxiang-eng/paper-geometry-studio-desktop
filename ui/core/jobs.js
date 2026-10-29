export function createJobQueue({ run, capacity = 2, onChange = () => {}, onResult = () => {} }) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 4) throw new Error('并行任务数无效。');
  const jobs = new Map(), waiting = [];
  let active = 0, sequence = 0;
  const changed = job => onChange({ ...job, controller: undefined });
  const drain = () => {
    while (active < capacity && waiting.length) {
      const job = waiting.shift(); if (job.state !== 'queued') continue;
      active++; job.state = 'running'; job.startedAt = Date.now(); changed(job);
      Promise.resolve().then(() => run(job, job.controller.signal, message => {
        if (job.state !== 'running') return;
        job.message = String(message || '正在处理'); changed(job);
      })).then(result => {
        if (job.state !== 'running') return;
        onResult(job, result); job.state = 'done'; job.message = '已完成';
      }).catch(error => {
        if (job.state === 'cancelled') return;
        job.state = 'error'; job.message = error?.message || '识别失败，截图仍保留。';
      }).finally(() => { active--; changed(job); drain(); });
    }
  };
  return {
    get jobs() { return [...jobs.values()].map(job => ({ ...job, controller: undefined })); },
    add(source, epoch, baseline = null) {
      if ([...jobs.values()].some(job => job.source.id === source.id && ['queued', 'running'].includes(job.state))) return null;
      const job = { id: `job-${++sequence}`, source, epoch, baseline, state: 'queued', message: '排队中', controller: new AbortController() };
      jobs.set(job.id, job); waiting.push(job); changed(job); drain(); return job.id;
    },
    update(id, message) { const job = jobs.get(id); if (job?.state === 'running') { job.message = String(message); changed(job); } },
    cancel(id) { const job = jobs.get(id); if (!job || !['queued', 'running'].includes(job.state)) return;
      job.state = 'cancelled'; job.message = '已取消'; job.controller.abort(new DOMException('已取消', 'AbortError')); changed(job); drain(); },
    cancelSource(sourceId) { for (const job of jobs.values()) if (job.source.id === sourceId) this.cancel(job.id); },
    cancelAll() { for (const job of jobs.values()) this.cancel(job.id); },
    forgetSource(sourceId) { this.cancelSource(sourceId); for (const [id, job] of jobs) if (job.source.id === sourceId) jobs.delete(id); },
    reset() { this.cancelAll(); jobs.clear(); waiting.length = 0; },
  };
}
