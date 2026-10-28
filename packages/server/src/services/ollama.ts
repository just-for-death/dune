import axios from 'axios';
import type { FileAnalysis } from '../types/index.js';
import { database } from '../db/index.js';
import { ApiError } from '../utils/apiError.js';
import { validateServerUrl } from '../utils/path.js';
import { logger, redactText } from '../middleware/logging.js';
import { aiFileAnalysisSchema, type AnalyzeFilesInput } from '../schemas.js';

export interface OllamaAnalysisResult {
  success: boolean;
  analysis?: Record<string, FileAnalysis>;
  message?: string;
}

export interface OllamaHealthResult {
  success: boolean;
  exists?: boolean;
  message?: string;
}

export interface OllamaModelsResult {
  success: boolean;
  models?: string[];
  message?: string;
}

export const DEFAULT_OLLAMA_MODEL = 'phi4-mini:latest';

/**
 * DUN-057/095: Ollama is OFF until an admin stores an endpoint in settings.
 * The ONLY URL the server ever calls for Ollama is the stored one; nothing a
 * caller sends can redirect it (no SSRF). Unset -> 400 OLLAMA_NOT_CONFIGURED.
 */
export function storedOllamaConfig(): { endpoint: string; model: string } {
  const settings = database.getSettings();
  const raw = typeof settings.ollamaEndpoint === 'string' ? settings.ollamaEndpoint.trim() : '';
  if (!raw) throw new ApiError(400, 'OLLAMA_NOT_CONFIGURED', 'Ollama is not configured; set an endpoint in settings');
  const check = validateServerUrl(raw);
  if (!check.valid) throw new ApiError(400, 'INVALID_URL', check.error ?? 'Invalid URL');
  return { endpoint: check.url, model: settings.ollamaModel || DEFAULT_OLLAMA_MODEL };
}

/** Log the upstream failure (redacted, flat fields only); callers get a generic message. */
function logUpstream(err: unknown, op: string): void {
  const e = err as { message?: unknown; code?: unknown; response?: { status?: unknown } };
  logger.warn({
    op,
    message: redactText(typeof e?.message === 'string' ? e.message : String(err)),
    code: typeof e?.code === 'string' ? e.code : undefined,
    status: typeof e?.response?.status === 'number' ? e.response.status : undefined,
  }, 'Ollama request failed');
}

const ANALYSIS_PROMPT = `You are a game save file analyst. Given a list of files from a game save directory, classify each file into one of four categories:
- Save: Actual save game data (progress, characters, world state)
- Config: Configuration files (settings, keybinds, graphics options)
- Cache: Temporary/cache files that can be safely deleted
- Other: Files that don't fit the above categories

Return a JSON object mapping file paths to {category, description}. Be concise.`;

/**
 * DUN-104: the model's answer is untrusted. Keep only entries for files that
 * were actually asked about, each validated (category normalized to the four
 * known values, description clamped). Everything else is dropped.
 */
export function sanitizeAnalysis(raw: unknown, askedPaths: string[]): Record<string, FileAnalysis> {
  const out: Record<string, FileAnalysis> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const asked = new Set(askedPaths);
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!asked.has(key)) continue;
    const r = aiFileAnalysisSchema.safeParse(value);
    if (r.success) out[key] = r.data;
  }
  return out;
}

export async function analyzeFilesAI(
  endpoint: string,
  model: string,
  input: AnalyzeFilesInput,
): Promise<OllamaAnalysisResult> {
  let text: string;
  try {
    const fileList = input.files.map(f => `- ${f.path} (${f.size} bytes, current: ${f.category})`).join('\n');
    const response = await axios.post(
      `${endpoint}/api/generate`,
      {
        model,
        prompt: `${ANALYSIS_PROMPT}\n\nGame: ${input.gameName}\nFiles:\n${fileList}\n\nReturn only valid JSON.`,
        stream: false,
        options: { temperature: 0.1 }
      },
      { timeout: 60000, maxContentLength: 4 * 1024 * 1024 }
    );
    text = typeof response.data?.response === 'string' ? response.data.response : '';
  } catch (error: unknown) {
    logUpstream(error, 'generate');
    return { success: false, message: 'Ollama analysis failed' };
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  let parsed: unknown;
  try {
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : undefined;
  } catch {
    parsed = undefined;
  }
  const analysis = sanitizeAnalysis(parsed, input.files.map((f) => f.path));
  if (Object.keys(analysis).length === 0) {
    return { success: false, message: 'Failed to parse AI response' };
  }
  return { success: true, analysis };
}

function modelNames(data: unknown): string[] {
  const models = (data as { models?: unknown } | undefined)?.models;
  if (!Array.isArray(models)) return [];
  return models
    .map((m) => (m && typeof m === 'object' ? (m as { name?: unknown }).name : undefined))
    .filter((n): n is string => typeof n === 'string')
    .slice(0, 500);
}

export async function checkModelStatus(endpoint: string, model: string): Promise<OllamaHealthResult> {
  try {
    const response = await axios.get(`${endpoint}/api/tags`, { timeout: 5000 });
    const models = modelNames(response.data);
    const exists = models.some((m: string) => m === model || m.startsWith(model.split(':')[0] + ':'));
    return { success: true, exists, message: exists ? 'Model is available' : 'Model not found' };
  } catch (error: unknown) {
    logUpstream(error, 'tags');
    return { success: false, message: 'Failed to check Ollama' };
  }
}

export async function fetchModels(endpoint: string): Promise<OllamaModelsResult> {
  try {
    const response = await axios.get(`${endpoint}/api/tags`, { timeout: 5000 });
    return { success: true, models: modelNames(response.data) };
  } catch (error: unknown) {
    logUpstream(error, 'tags');
    return { success: false, message: 'Failed to fetch models' };
  }
}
