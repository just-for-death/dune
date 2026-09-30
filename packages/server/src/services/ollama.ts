import axios from 'axios';
import type { FileAnalysis } from '../types/index.js';

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

const ANALYSIS_PROMPT = `You are a game save file analyst. Given a list of files from a game save directory, classify each file into one of four categories:
- Save: Actual save game data (progress, characters, world state)
- Config: Configuration files (settings, keybinds, graphics options)
- Cache: Temporary/cache files that can be safely deleted
- Other: Files that don't fit the above categories

Return a JSON object mapping file paths to {category, description}. Be concise.`;

export async function analyzeFilesAI(
  endpoint: string,
  model: string,
  gameName: string,
  files: Array<{ path: string; size: number; category: string }>
): Promise<OllamaAnalysisResult> {
  try {
    const fileList = files.map(f => `- ${f.path} (${f.size} bytes, current: ${f.category})`).join('\n');
    
    const response = await axios.post(
      `${endpoint}/api/generate`,
      {
        model,
        prompt: `${ANALYSIS_PROMPT}\n\nGame: ${gameName}\nFiles:\n${fileList}\n\nReturn only valid JSON.`,
        stream: false,
        options: { temperature: 0.1 }
      },
      { timeout: 60000 }
    );

    const text = response.data.response || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, message: 'Failed to parse AI response' };
    }

    const analysis = JSON.parse(jsonMatch[0]);
    return { success: true, analysis };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Ollama analysis failed: ${message}` };
  }
}

export async function checkModelStatus(endpoint: string, model: string): Promise<OllamaHealthResult> {
  try {
    const response = await axios.get(`${endpoint}/api/tags`, { timeout: 5000 });
    const models = response.data.models?.map((m: { name: string }) => m.name) || [];
    const exists = models.some((m: string) => m === model || m.startsWith(model.split(':')[0] + ':'));
    return { success: true, exists, message: exists ? 'Model is available' : 'Model not found' };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Failed to check Ollama: ${message}` };
  }
}

export async function fetchModels(endpoint: string): Promise<OllamaModelsResult> {
  try {
    const response = await axios.get(`${endpoint}/api/tags`, { timeout: 5000 });
    const models = response.data.models?.map((m: { name: string }) => m.name) || [];
    return { success: true, models };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Failed to fetch models: ${message}` };
  }
}
