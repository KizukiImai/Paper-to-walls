import { warpImage, recognize, estimatePaper, vectorizePaths } from './lib/vision-core.js';
self.onmessage = ({ data }) => {
  const { id, type, image, corners, aspect, config } = data;
  const progress = (message, percent) => self.postMessage({ id, type: 'progress', message, percent });
  try {
    if (type === 'vectorize') { self.postMessage({ id, type:'result', result:vectorizePaths(data.paths, data.width, data.height, config) }); return; }
    if (type === 'estimate') { self.postMessage({ id, type: 'result', result: estimatePaper(image) }); return; }
    progress('台形の歪みを補正しています', 10);
    const rectified = warpImage(image, corners, aspect, config.longSide);
    const result = recognize(rectified, config, progress);
    self.postMessage({ id, type: 'result', result: { ...result, rectified } }, [rectified.data.buffer, result.binary.buffer, result.skeleton.buffer]);
  } catch (error) { self.postMessage({ id, type: 'error', message: error instanceof Error ? error.message : String(error) }); }
};
