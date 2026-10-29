import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobQueue } from '../ui/core/jobs.js';

test('two jobs run independently; cancellation retains the permit until actual work stops', async () => {
  const pending = new Map(), results = [];
  let running = 0, peak = 0;
  const queue = createJobQueue({ run: async job => { running++; peak = Math.max(peak, running);
    await new Promise(resolve => pending.set(job.source.id, resolve)); running--; return job.source.id; },
    onResult: (job, value) => results.push(value) });
  const first = queue.add({ id: 'one' }, 1); queue.add({ id: 'two' }, 1); queue.add({ id: 'three' }, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(running, 2); queue.cancel(first);
  assert.equal(running, 2); assert.equal(pending.has('three'), false);
  pending.get('one')(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.has('three'), true); pending.get('two')(); pending.get('three')();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(peak, 2); assert.deepEqual(results, ['two', 'three']);
});

test('cancelled queued sources never run and duplicate active sources are ignored', async () => {
  let calls = 0, finish;
  const queue = createJobQueue({ capacity: 1, run: async () => { calls++; await new Promise(resolve => { finish = resolve; }); } });
  queue.add({ id: 'one' }, 1); assert.equal(queue.add({ id: 'one' }, 1), null);
  const waiting = queue.add({ id: 'two' }, 1); queue.cancel(waiting);
  await new Promise(resolve => setImmediate(resolve)); finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('a queued baseline stays fixed and reset releases old screenshot references without releasing physical permits early', async () => {
  const pending = new Map(), seen = [];
  const queue = createJobQueue({ capacity: 1, run: async job => {
    seen.push([job.source.id, job.baseline]); await new Promise(resolve => pending.set(job.source.id, resolve));
  } });
  queue.add({ id: 'one', dataUrl: 'large-old-image' }, 1, 'old-one');
  queue.add({ id: 'two' }, 1, 'frozen-two');
  await new Promise(resolve => setImmediate(resolve)); pending.get('one')();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen[1], ['two', 'frozen-two']);
  queue.reset(); assert.equal(queue.jobs.length, 0);
  queue.add({ id: 'three' }, 2, 'new-three');
  assert.equal(pending.has('three'), false);
  pending.get('two')(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.has('three'), true); assert.deepEqual(seen.at(-1), ['three', 'new-three']);
  pending.get('three')(); await new Promise(resolve => setImmediate(resolve));
});
