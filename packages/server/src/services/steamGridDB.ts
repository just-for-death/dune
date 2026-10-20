import axios from 'axios';
import { logger, redactText } from '../middleware/logging.js';

/** DUN-092: an error message must never carry the key, even if a library echoes it. */
function safeMessage(error: unknown, apiKey: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactText(apiKey ? message.split(apiKey).join('[REDACTED]') : message);
}

export interface SteamGridDBResponse {
  success: boolean;
  results?: string[];
  message?: string;
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
    logger.warn({ err: safeMessage(error, apiKey), query }, 'SteamGridDB search failed');
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
    logger.warn({ err: safeMessage(error, apiKey), gameId }, 'SteamGridDB grids failed');
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

export async function autoMatchAll(apiKey: string, games: Array<{ name: string; thumbnail: string }>): Promise<Array<{ name: string; thumbnail: string }>> {
  const matched: Array<{ name: string; thumbnail: string }> = [];
  const errors: Array<{ game: string; error: string }> = [];
  
  for (const game of games) {
    if (game.thumbnail) continue;
    
    try {
      const response = await searchArt(apiKey, game.name);
      if (response.success && response.results && response.results.length > 0) {
        matched.push({ name: game.name, thumbnail: response.results[0] });
      }
      await new Promise(r => setTimeout(r, 300));
    } catch (error) {
      const message = safeMessage(error, apiKey);
      logger.warn({ err: message, game: game.name }, 'SteamGridDB auto-match failed for game');
      errors.push({ game: game.name, error: message });
    }
  }
  
  if (errors.length > 0) {
    logger.warn({ errors }, 'Some games failed auto-match');
  }
  
  return matched;
}
