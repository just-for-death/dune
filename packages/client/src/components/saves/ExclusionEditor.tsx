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

const CATEGORY_GLOBS: Record<FileRow['category'], string[]> = {
  Save: [],
  Config: [],
  Cache: ['**/cache/**', '**/Cache/**', '**/*.log', '**/*.tmp', '**/*.cache', '**/logs/**'],
  Other: [],
};

export function ExclusionEditor({ profile, files, onChange }: Props) {
  const groups = useMemo(() => {
    const map = new Map<FileRow['category'], { count: number; bytes: number }>();
    for (const file of files) {
      const current = map.get(file.category) ?? { count: 0, bytes: 0 };
      current.count += 1;
      current.bytes += file.size;
      map.set(file.category, current);
    }
    return Array.from(map.entries());
  }, [files]);

  const [excludedCategories, setExcludedCategories] = useState<Set<FileRow['category']>>(() => {
    const excluded = new Set<FileRow['category']>();
    for (const category of Object.keys(CATEGORY_GLOBS) as FileRow['category'][]) {
      if (CATEGORY_GLOBS[category].some((glob) => profile.excludeGlobs.includes(glob))) {
        excluded.add(category);
      }
    }
    return excluded;
  });

  const toggleCategory = (category: FileRow['category']) => {
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

  return (
    <div className="exclusion-editor">
      <div className="exclusion-summary">
        <strong>Backup preview</strong>
        <span className="muted">
          {files.filter((file) => !excludedCategories.has(file.category)).reduce((sum, file) => sum + file.size, 0)} bytes included
        </span>
      </div>

      {groups.map(([category, stats]) => (
        <label key={category} className="exclusion-row">
          <input type="checkbox" checked={excludedCategories.has(category)} onChange={() => toggleCategory(category)} />
          <div className="exclusion-row-main">
            <strong>{category}</strong>
            <span className="muted">{stats.count} files · {(stats.bytes / 1024 / 1024).toFixed(1)} MB</span>
          </div>
          <span className="badge">{excludedCategories.has(category) ? 'Excluded' : 'Included'}</span>
        </label>
      ))}
    </div>
  );
}
