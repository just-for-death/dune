/** Minimal SemVer 2.0.0 parse/compare (no ranges). A leading "v" is accepted. */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly (string | number)[];
  raw: string;
}

const NUM = '0|[1-9]\\d*';
const PRE_ID = `(?:${NUM}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const SEMVER_RE = new RegExp(`^v?(${NUM})\\.(${NUM})\\.(${NUM})(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

export function parseSemver(input: unknown): SemVer | null {
  if (typeof input !== 'string' || input.length > 128) return null;
  const m = SEMVER_RE.exec(input.trim());
  if (!m) return null;
  const nums = [m[1], m[2], m[3]].map(Number);
  if (nums.some((n) => !Number.isSafeInteger(n))) return null;
  const prerelease = m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  return { major: nums[0]!, minor: nums[1]!, patch: nums[2]!, prerelease, raw: input.trim() };
}

/** <0 when a < b, 0 when equal precedence (build metadata ignored), >0 when a > b. */
export function compareSemver(a: SemVer, b: SemVer): number {
  for (const k of ['major', 'minor', 'patch'] as const) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  const pa = a.prerelease;
  const pb = b.prerelease;
  if (pa.length === 0 || pb.length === 0) return pa.length === pb.length ? 0 : pa.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
