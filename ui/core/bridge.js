export function createBridge(transport = globalThis.chrome?.webview) {
  const pending = new Map(), listeners = new Set();
  let sequence = 0;
  const receive = ({ data }) => {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'response') {
      const item = pending.get(data.id); if (!item) return;
      pending.delete(data.id); clearTimeout(item.timer);
      data.ok ? item.resolve(data.result) : item.reject(Object.assign(new Error(data.error?.message || data.error || '操作未完成。'), { code: data.error?.code }));
    } else if (data.type === 'event') for (const listener of listeners) listener(data);
  };
  transport?.addEventListener('message', receive);
  return {
    connected: Boolean(transport),
    request(command, payload = {}, { timeoutMs = 240000 } = {}) {
      if (!transport) return Promise.reject(new Error('请从“截图组卷.exe”打开完整应用。'));
      const id = `ui-${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('操作等待超时，现有内容仍保留。')); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { transport.postMessage({ id, command, payload }); }
        catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
      });
    },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() {
      transport?.removeEventListener('message', receive);
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('窗口已关闭。')); }
      pending.clear(); listeners.clear();
    },
  };
}
