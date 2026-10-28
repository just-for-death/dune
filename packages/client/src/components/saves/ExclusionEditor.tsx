import { useMemo, useState } from 'react';
import type { BackupProfile } from '@dune/shared';
import { useI18n } from '../../i18n/context';
import type { MessageKey } from '../../i18n';
import { CATEGORY_GLOBS, type CategorizedSaveFile, type SaveFileCategory } from '../../services/saveFiles';

interface Props {
  profile: BackupProfile;
  files: CategorizedSaveFile[];
  onChange: (profile: BackupProfile) => void;
}

type Category = SaveFileCategory;

const CATEGORY_KEYS: Record<Category, MessageKey> = {
  Save: 'exclusions.category.save',
  Config: 'exclusions.category.config',
  Cache: 'exclusions.category.cache',
  Other: 'exclusions.category.other',
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
  const { t, tc } = useI18n();
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
        <strong>{t('exclusions.preview')}</strong>
        <span className="muted">{t('exclusions.included', { size: formatBytes(includedBytes) })}</span>
      </div>
      <p className="muted exclusion-note">{t('exclusions.note')}</p>

      {groups.length === 0 && <p className="muted">{t('exclusions.noBreakdown')}</p>}

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
              <strong>{t(CATEGORY_KEYS[category])}</strong>
              <span className="muted">
                {tc('exclusions.files', stats.count, { size: formatBytes(stats.bytes) })}
                {!toggleable && t('exclusions.alwaysIncluded')}
              </span>
            </span>
            <span className="badge">{excluded ? t('exclusions.excluded') : t('exclusions.includedBadge')}</span>
          </label>
        );
      })}
    </div>
  );
}
