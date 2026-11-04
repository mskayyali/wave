import { expect, test } from 'bun:test';
import { ALIGNER_MODEL_ID, PARAKEET_MODEL_ID, isTranscriptionReady, readyTranscriptionModels } from '../src/lib/modelCatalog';

const ready = (id: string) => ({ id, status: { type: 'ready' } });
test('Parakeet works without the Whisper aligner; Whisper requires both downloads', () => {
  expect(isTranscriptionReady([ready(PARAKEET_MODEL_ID)], PARAKEET_MODEL_ID)).toBe(true);
  expect(isTranscriptionReady([ready('large-v3-turbo')], 'large-v3-turbo')).toBe(false);
  expect(isTranscriptionReady([ready('large-v3-turbo'), ready(ALIGNER_MODEL_ID)], 'large-v3-turbo')).toBe(true);
  expect(isTranscriptionReady([ready(ALIGNER_MODEL_ID)], ALIGNER_MODEL_ID)).toBe(false);
});
test('partial downloads are never selectable, and fallback prefers a complete Whisper bundle', () => {
  const models = [ready(PARAKEET_MODEL_ID), ready('large-v3-turbo'), ready(ALIGNER_MODEL_ID)];
  expect(readyTranscriptionModels(models).map(m => m.id)).toEqual(['large-v3-turbo', PARAKEET_MODEL_ID]);
  expect(readyTranscriptionModels(models.filter(m => m.id !== ALIGNER_MODEL_ID)).map(m => m.id)).toEqual([PARAKEET_MODEL_ID]);
  expect(readyTranscriptionModels([{ id: PARAKEET_MODEL_ID, status: { type: 'partial' } }])).toEqual([]);
  expect(isTranscriptionReady(models, null)).toBe(false);
  expect(isTranscriptionReady([ready('removed-model')], 'removed-model')).toBe(false);
});
