import { listWinePrefixes, createWinePrefix, deleteWinePrefix, backupWinePrefix } from './wine.js';
import { listProtonVersions } from './proton.js';
import { listHeroicPrefixes } from './heroic.js';
import { listLutrisPrefixes } from './lutris.js';

export interface PrefixSummary {
  wine: ReturnType<typeof listWinePrefixes>;
  proton: ReturnType<typeof listProtonVersions>;
  heroic: ReturnType<typeof listHeroicPrefixes>;
  lutris: ReturnType<typeof listLutrisPrefixes>;
}

export function listPrefixes(): PrefixSummary {
  return {
    wine: listWinePrefixes(),
    proton: listProtonVersions(),
    heroic: listHeroicPrefixes(),
    lutris: listLutrisPrefixes(),
  };
}

export { createWinePrefix, deleteWinePrefix, backupWinePrefix };
