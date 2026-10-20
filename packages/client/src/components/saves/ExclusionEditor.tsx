import { useMemo, useState } from 'react';
import type { BackupProfile } from '@dune/shared';

interface FileRow {
  path: string;
  size: number;
  category: 'Save' | 'Config' | 'Cache' | 'Other';
}

interface Props {
  profile: BackupProfile;
  files: FileRow[];
  onChange: (profile: BackupProfile) => void;
}

type Category = FileRow['category'];

// Globs written to profile.excludeGlobs when a category is excluded. "Other"
// is the catch-all bucket and has no pattern that would not overlap the other
// categories, so it is shown but cannot be toggled.
const CATEGORY_GLOBS: Record<Category, string[]> = {
  Save: ['**/*.sav', '**/*.save', '**/*.sl2', '**/saves/**', '**/Saves/**', '**/SaveGames/**'],
  Config: ['**/*.ini', '**/*.cfg', '**/*.conf', '**/config/**', '**/Config/**'],
  Cache: ['**/cache/**', '**/Cache/**', '**/*.log', '**/*.tmp', '**/*.cache', '**/logs/**'],
  Other: [],
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function excludedFromProfile(profile: BackupProfile): Set<Category> {
  const excluded = new Set<Category>();
  for (const category of Object.keys(CATEGORY_GLOBS) as Category[]) {
    if (CATEGORY_GLOBS[category].some((glob) => profile.excludeGlobs.includes(glob))) {
      excluded.add(category);
    }
  }
  return excluded;
}

export function ExclusionEditor({ profile, files, onChange }: Props) {
  const groups = useMemo(() => {
    const map = new Map<Category, { count: number; bytes: number }>();
    for (const file of files) {
      const current = map.get(file.category) ?? { count: 0, bytes: 0 };
      current.count += 1;
      current.bytes += file.size;
      map.set(file.category, current);
    }
    return Array.from(map.entries());
  }, [files]);

  const [excludedCategories, setExcludedCategories] = useState<Set<Category>>(() => excludedFromProfile(profile));
  // Reset the local toggle state when a different game's profile arrives
  // (state adjustment during render instead of an effect).
  const [profileGameId, setProfileGameId] = useState(profile.gameId);
  if (profile.gameId !== profileGameId) {
    setProfileGameId(profile.gameId);
    setExcludedCategories(excludedFromProfile(profile));
  }

  const toggleCategory = (category: Category) => {
    if (CATEGORY_GLOBS[category].length === 0) return;
    const next = new Set(excludedCategories);
    if (next.has(category)) next.delete(category);
    else next.add(category);

    const excludeGlobs = new Set(profile.excludeGlobs);
    for (const glob of CATEGORY_GLOBS[category]) {
      if (next.has(category)) excludeGlobs.add(glob);
      else excludeGlobs.delete(glob);
    }

    setExcludedCategories(next);
    onChange({
      ...profile,
      excludeGlobs: Array.from(excludeGlobs),
      updatedAt: new Date().toISOString(),
    });
  };

  const includedBytes = files
    .filter((file) => !excludedCategories.has(file.category))
    .reduce((sum, file) => sum + file.size, 0);

  return (
    <div className="exclusion-editor">
      <div className="exclusion-summary">
        <strong>Backup preview</strong>
        <span className="muted">{formatBytes(includedBytes)} included</span>
      </div>
      <p className="muted exclusion-note">Excluded files are only skipped in backups. Nothing is deleted from your PC.</p>

      {groups.length === 0 && <p className="muted">No file breakdown is available for this game yet.</p>}

      {groups.map(([category, stats]) => {
        const toggleable = CATEGORY_GLOBS[category].length > 0;
        const excluded = excludedCategories.has(category);
        return (
          <label key={category} className={`exclusion-row${toggleable ? '' : ' exclusion-row-disabled'}`}>
            <input
              type="checkbox"
              className="checkbox-input"
              checked={excluded}
              disabled={!toggleable}
              onChange={() => toggleCategory(category)}
            />
            <span className="exclusion-row-main">
              <strong>{category}</strong>
              <span className="muted">
                {stats.count} file{stats.count === 1 ? '' : 's'} · {formatBytes(stats.bytes)}
                {!toggleable && ' · always included'}
              </span>
            </span>
            <span className="badge">{excluded ? 'Excluded' : 'Included'}</span>
          </label>
        );
      })}
    </div>
  );
}
