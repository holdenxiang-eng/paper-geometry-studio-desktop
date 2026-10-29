/** Each request owns its worker, so cancellation also releases CPU and caches. */
export function prepareRasterInWorker(dataURL, { signal, onProgress, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) { reject(new Error('截图预处理超时时间无效。')); return; }
    if (signal?.aborted) { reject(new DOMException('已取消截图预处理。', 'AbortError')); return; }
    if (typeof Worker !== 'function') { reject(new Error('当前浏览器不支持截图处理线程，请使用最新版软件。')); return; }
    let worker, timer, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker?.terminate();
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(new DOMException('已取消截图预处理。', 'AbortError'));
    try {
      worker = new Worker(new URL('./raster-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        if (settled) return;
        if (data?.type === 'progress') {
          try { onProgress?.(data.progress); } catch (error) { finish(error); }
        } else if (data?.type === 'result') finish(null, data.result);
        else if (data?.type === 'error') {
          const error = new Error(data.error?.message || '截图预处理失败，请重试。');
          error.name = data.error?.name || 'Error'; finish(error);
        }
      };
      worker.onerror = event => { event.preventDefault(); finish(new Error('截图处理线程启动失败，请重新打开软件后重试。')); };
      worker.onmessageerror = () => finish(new Error('截图处理结果无法读取，请重试。'));
      timer = setTimeout(() => finish(new Error(`截图预处理超时（${Math.max(1, Math.ceil(timeoutMs / 1000))}秒），请裁剪单个图形后重试。`)), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      worker.postMessage({ type: 'prepare', dataURL });
    } catch (error) { finish(error); }
  });
}

