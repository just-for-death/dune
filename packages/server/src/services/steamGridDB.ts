import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const CACHE_DIR = path.join(process.cwd(), 'data', 'steamgriddb-cache');

export interface SteamGridDBResponse {
  success: boolean;
  results?: string[];
  message?: string;
}

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

export async function searchGame(apiKey: string, query: string): Promise<{ id: number; name: string } | null> {
  try {
    const response = await axios.get(
      `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 10000 }
    );
    
    if (!response.data.success || !response.data.data || response.data.data.length === 0) {
      return null;
    }
    
    return { id: response.data.data[0].id, name: response.data.data[0].name };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('SteamGridDB search failed:', message);
    return null;
  }
}

export async function getGridImages(apiKey: string, gameId: number): Promise<string[]> {
  try {
    const response = await axios.get(
      `https://www.steamgriddb.com/api/v2/grids/game/${gameId}?dimensions=600x900,460x215,920x430`,
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 10000 }
    );
    
    if (!response.data.success || !response.data.data || response.data.data.length === 0) {
      return [];
    }
    
    return response.data.data.map((g: { url: string }) => g.url);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('SteamGridDB grids failed:', message);
    return [];
  }
}

export async function searchArt(apiKey: string, query: string): Promise<SteamGridDBResponse> {
  const game = await searchGame(apiKey, query);
  if (!game) {
    return { success: true, results: [] };
  }
  
  const images = await getGridImages(apiKey, game.id);
  return { success: true, results: images };
}

export async function autoMatchAll(apiKey: string, games: Array<{ name: string; thumbnail: string }>): Promise<number> {
  let matched = 0;
  
  for (const game of games) {
    if (game.thumbnail) continue;
    
    try {
      const response = await searchArt(apiKey, game.name);
      if (response.success && response.results && response.results.length > 0) {
        matched++;
      }
      await new Promise(r => setTimeout(r, 300));
    } catch {
      // Continue on error
    }
  }
  
  return matched;
}
