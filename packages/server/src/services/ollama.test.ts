// DUN-003: focused unit tests for services/ollama.ts (axios mocked; no network).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';

vi.mock('axios');

const { database } = await import('../db/index.js');
const { logger } = await import('../middleware/logging.js');
const { storedOllamaConfig, sanitizeAnalysis, analyzeFilesAI, checkModelStatus, fetchModels, DEFAULT_OLLAMA_MODEL } =
  await import('./ollama.js');

const getMock = vi.mocked(axios.get);
const postMock = vi.mocked(axios.post);
const EP = 'http://ollama.test:11434';
const input = {
  gameName: 'G',
  files: [
    { path: 'a.sav', size: 1, category: 'Save' as const },
    { path: 'b.cfg', size: 2, category: 'Other' as const },
  ],
};
let original: ReturnType<typeof database.getSettings>;

beforeEach(() => {
  original = database.getSettings();
  getMock.mockReset();
  postMock.mockReset();
});

afterEach(() => {
  database.saveSettings(original);
  vi.restoreAllMocks();
});

function setOllama(endpoint: unknown, model?: string) {
  database.saveSettings({ ...original, ollamaEndpoint: endpoint as string, ...(model !== undefined ? { ollamaModel: model } : {}) });
}

function codeOf(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { return (e as { code?: string }).code; }
  return undefined;
}

describe('storedOllamaConfig', () => {
  it('is OLLAMA_NOT_CONFIGURED for an empty, blank or non-string endpoint', () => {
    for (const v of ['', '   ', undefined, 42]) {
      setOllama(v);
      expect(codeOf(() => storedOllamaConfig())).toBe('OLLAMA_NOT_CONFIGURED');
    }
  });

  it('is INVALID_URL for a stored value that is not an http(s) URL', () => {
    setOllama('ftp://ollama.test');
    expect(codeOf(() => storedOllamaConfig())).toBe('INVALID_URL');
  });

  it('returns the stored endpoint and model, falling back to the default model', () => {
    setOllama(EP, 'llama3:8b');
    expect(storedOllamaConfig()).toEqual({ endpoint: expect.stringContaining('ollama.test:11434'), model: 'llama3:8b' });
    setOllama(EP, '');
    expect(storedOllamaConfig().model).toBe(DEFAULT_OLLAMA_MODEL);
  });
});

describe('sanitizeAnalysis', () => {
  it('drops non-objects, arrays, unasked keys and invalid entries', () => {
    expect(sanitizeAnalysis(null, ['a.sav'])).toEqual({});
    expect(sanitizeAnalysis('x', ['a.sav'])).toEqual({});
    expect(sanitizeAnalysis([{ category: 'Save' }], ['a.sav'])).toEqual({});
    const out = sanitizeAnalysis({
      'a.sav': { category: 'Save', description: 'progress' },
      'b.cfg': { category: 42 },
      'evil.sh': { category: 'Save', description: 'not asked' },
    }, ['a.sav', 'b.cfg']);
    expect(Object.keys(out)).toEqual(['a.sav']);
    expect(out['a.sav'].category).toBe('Save');
  });
});

describe('analyzeFilesAI', () => {
  it('returns the validated analysis from the model JSON (surrounding text ignored)', async () => {
    postMock.mockResolvedValue({ data: { response: 'Sure! {"a.sav": {"category": "Save", "description": "slot"}} done' } });
    const res = await analyzeFilesAI(EP, 'm', input);
    expect(res.success).toBe(true);
    expect(Object.keys(res.analysis ?? {})).toEqual(['a.sav']);
    expect(postMock.mock.calls[0][0]).toBe(`${EP}/api/generate`);
  });

  it.each([
    ['a non-string response', { data: { response: 7 } }],
    ['no JSON at all', { data: { response: 'no braces here' } }],
    ['malformed JSON', { data: { response: '{ not json }' } }],
    ['JSON with nothing usable', { data: { response: '{"other.sav": {"category": "Save"}}' } }],
    ['no data', {}],
  ])('fails with a parse message for %s', async (_label, reply) => {
    postMock.mockResolvedValue(reply);
    expect(await analyzeFilesAI(EP, 'm', input)).toEqual({ success: false, message: 'Failed to parse AI response' });
  });

  it('upstream errors are generic and logged redacted with flat fields', async () => {
    const warn = vi.spyOn(logger, 'warn');
    postMock.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED http://u:secret@host/?key=abc'), {
      code: 'ECONNREFUSED',
      response: { status: 502 },
    }));
    expect(await analyzeFilesAI(EP, 'm', input)).toEqual({ success: false, message: 'Ollama analysis failed' });
    const [fields] = warn.mock.calls.at(-1) as [Record<string, unknown>];
    expect(fields).toMatchObject({ op: 'generate', code: 'ECONNREFUSED', status: 502 });
    expect(String(fields.message)).not.toContain('secret');
  });

  it('a non-Error rejection is still generic (no code/status)', async () => {
    const warn = vi.spyOn(logger, 'warn');
    postMock.mockRejectedValue('plain string failure');
    expect((await analyzeFilesAI(EP, 'm', input)).success).toBe(false);
    const [fields] = warn.mock.calls.at(-1) as [Record<string, unknown>];
    expect(fields).toMatchObject({ op: 'generate', message: 'plain string failure', code: undefined, status: undefined });
  });
});

describe('checkModelStatus / fetchModels', () => {
  it('finds the model by exact name or by family prefix', async () => {
    getMock.mockResolvedValue({ data: { models: [{ name: 'phi4-mini:q4' }, { name: 'llama3:8b' }] } });
    expect(await checkModelStatus(EP, 'llama3:8b')).toEqual({ success: true, exists: true, message: 'Model is available' });
    expect((await checkModelStatus(EP, 'phi4-mini:latest')).exists).toBe(true);
    expect(await checkModelStatus(EP, 'mistral:7b')).toEqual({ success: true, exists: false, message: 'Model not found' });
    expect(getMock.mock.calls[0][0]).toBe(`${EP}/api/tags`);
  });

  it('ignores malformed tag lists', async () => {
    getMock.mockResolvedValue({ data: { models: 'nope' } });
    expect(await fetchModels(EP)).toEqual({ success: true, models: [] });
    getMock.mockResolvedValue({ data: { models: [null, 3, { name: 5 }, { name: 'ok:1' }] } });
    expect(await fetchModels(EP)).toEqual({ success: true, models: ['ok:1'] });
    getMock.mockResolvedValue({ data: undefined });
    expect((await checkModelStatus(EP, 'x')).exists).toBe(false);
  });

  it('upstream errors are generic', async () => {
    getMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND internal.corp'));
    expect(await checkModelStatus(EP, 'm')).toEqual({ success: false, message: 'Failed to check Ollama' });
    expect(await fetchModels(EP)).toEqual({ success: false, message: 'Failed to fetch models' });
  });
});
