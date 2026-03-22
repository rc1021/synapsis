/**
 * Shared embedding utility — singleton model (Xenova/bge-m3).
 * bge-m3 uses CLS pooling + normalize for best results.
 */

import { pipeline } from '@xenova/transformers';

const MODEL_NAME = 'Xenova/bge-m3';
let extractor = null;

async function getExtractor() {
  if (!extractor) {
    extractor = await pipeline('feature-extraction', MODEL_NAME);
  }
  return extractor;
}

/**
 * Embed a text string → Float32Array (1024d).
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embed(text) {
  const ext = await getExtractor();
  const output = await ext(text, { pooling: 'cls', normalize: true });
  return Array.from(output.data);
}
