import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const CACHE_DIR = path.join(process.cwd(), 'data', 'hltb-cache');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface HLTBTimes {
  mainStory: number;
  mainExtra: number;
  completionist: number;
}

export interface HLTBResponse {
  success: boolean;
  times?: HLTBTimes;
  message?: string;
}

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function getCachePath(gameName: string): string {
  const safeName = gameName.toLowerCase().replace(/[^a-z0-9]/g, '-');
  return path.join(CACHE_DIR, `${safeName}.json`);
}

export function readCache(gameName: string): HLTBTimes | null {
  try {
    ensureCacheDir();
    const cachePath = getCachePath(gameName);
    if (!fs.existsSync(cachePath)) return null;
    
    const stats = fs.statSync(cachePath);
    if (Date.now() - stats.mtimeMs > CACHE_TTL_MS) return null;
    
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    return data.times;
  } catch {
    return null;
  }
}

export function writeCache(gameName: string, times: HLTBTimes): void {
  try {
    ensureCacheDir();
    const cachePath = getCachePath(gameName);
    fs.writeFileSync(cachePath, JSON.stringify({ times, cachedAt: Date.now() }), 'utf-8');
  } catch {
    // Ignore cache write errors
  }
}

async function searchHLTB(gameName: string): Promise<HLTBTimes | null> {
  try {
    const searchResponse = await axios.post(
      'https://howlongtobeat.com/api/search',
      {
        searchType: 'games',
        searchTerms: gameName.split(' '),
        searchPage: 1,
        size: 5,
        searchOptions: {
          games: { userId: 0, platform: '', sortCategory: 'popular', rangeCategory: 'main', rangeTime: { min: 0, max: 0 }, gameplay: { perspective: '', flow: '', genre: '' }, modifier: '' },
          users: { sortCategory: 'postcount' },
          filter: '',
          sort: 0,
          randomizer: 0
        }
      },
      { timeout: 10000 }
    );

    if (!searchResponse.data.data || searchResponse.data.data.length === 0) return null;
    
    const game = searchResponse.data.data[0];
    return {
      mainStory: (game.comp_main || 0) * 60,
      mainExtra: (game.comp_plus || 0) * 60,
      completionist: (game.comp_100 || 0) * 60
    };
  } catch {
    return null;
  }
}

export async function getHLTBTimes(gameName: string): Promise<HLTBResponse> {
  const cached = readCache(gameName);
  if (cached) {
    return { success: true, times: cached };
  }

  const times = await searchHLTB(gameName);
  if (times) {
    writeCache(gameName, times);
    return { success: true, times };
  }

  return { success: false, message: 'Game not found on HowLongToBeat' };
}

export async function bulkFetchHLTB(gameNames: string[]): Promise<Map<string, HLTBTimes>> {
  const results = new Map<string, HLTBTimes>();
  
  for (const name of gameNames) {
    const cached = readCache(name);
    if (cached) {
      results.set(name, cached);
      continue;
    }
    
    const response = await getHLTBTimes(name);
    if (response.success && response.times) {
      results.set(name, response.times);
    }
    
    await new Promise(r => setTimeout(r, 200));
  }
  
  return results;
}
