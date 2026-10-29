import { prepareRasterImage } from './raster-geometry.js';

self.onmessage = async ({ data }) => {
  if (data?.type !== 'prepare') return;
  try {
    const result = await prepareRasterImage(data.dataURL, {
      onProgress: progress => self.postMessage({ type: 'progress', progress }),
    });
    self.postMessage({ type: 'result', result });
  } catch (error) {
    self.postMessage({ type: 'error', error: { name: error.name, message: error.message || '截图预处理失败，请重新选择截图。' } });
  }
};

