import { z } from 'zod';

/**
 * Zod schema for one game of the Ludusavi save-path manifest
 * (https://github.com/mtkennerly/ludusavi-manifest/blob/master/data/schema.yaml).
 * Lenient like upstream recommends (unknown tag/os/store values are kept as
 * strings) but bounded. Unknown fields are stripped, and `launch` (executable
 * paths and command-line arguments) is deliberately NOT part of the schema, so
 * it never leaves this package: Dune only reads save/config locations.
 */
export const MAX_PATH_CHARS = 1024;
export const MAX_ENTRIES_PER_SECTION = 500;
const MAX_LIST = 64;
/** steamExtra/gogExtra list DLC ids: real entries reach several hundred (Train Simulator, Euro Truck Simulator 2). */
const MAX_STORE_IDS = 4096;
const MAX_NOTE_CHARS = 4000;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const Label = z.string().min(1).max(64);
const StoreId = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PathKey = z.string().min(1).max(MAX_PATH_CHARS).refine((s) => !CONTROL.test(s), 'control characters in path');

function boundedRecord<T extends z.ZodType>(value: T) {
  return z.record(PathKey, value).refine((r) => Object.keys(r).length <= MAX_ENTRIES_PER_SECTION, 'too many entries');
}

const FileConstraint = z.object({ os: Label.optional(), store: Label.optional() });
const RegistryConstraint = z.object({ store: Label.optional() });

/** `<path>: {}` and `<path>:` (null) both mean "no tags, no constraints". */
const FileRule = z
  .object({ tags: z.array(Label).max(MAX_LIST).optional(), when: z.array(FileConstraint).max(MAX_LIST).optional() })
  .nullish()
  .transform((v) => v ?? {});
const RegistryRule = z
  .object({ tags: z.array(Label).max(MAX_LIST).optional(), when: z.array(RegistryConstraint).max(MAX_LIST).optional() })
  .nullish()
  .transform((v) => v ?? {});

export const ManifestGameSchema = z.object({
  files: boundedRecord(FileRule).optional(),
  registry: boundedRecord(RegistryRule).optional(),
  /** Upstream: map of directory name -> {}. Normalised to the list of names. */
  installDir: boundedRecord(z.unknown()).transform((r) => Object.keys(r)).optional(),
  steam: z.object({ id: StoreId.optional() }).optional(),
  gog: z.object({ id: StoreId.optional() }).optional(),
  id: z
    .object({
      flatpak: z.string().min(1).max(256).optional(),
      lutris: z.string().min(1).max(256).optional(),
      steamExtra: z.array(StoreId).max(MAX_STORE_IDS).optional(),
      gogExtra: z.array(StoreId).max(MAX_STORE_IDS).optional(),
    })
    .optional(),
  /** Another game's title; this entry's other fields are ignored (upstream rule). */
  alias: z.string().min(1).max(512).optional(),
  cloud: z
    .object({ epic: z.boolean().optional(), gog: z.boolean().optional(), origin: z.boolean().optional(), steam: z.boolean().optional(), uplay: z.boolean().optional() })
    .optional(),
  notes: z.array(z.object({ message: z.string().max(MAX_NOTE_CHARS) })).max(MAX_LIST).optional(),
});

/** One validated game. Paths are data with Ludusavi placeholders (`<base>`, `<winAppData>`, ...): never expand them into a shell or run them. */
export type ManifestGame = z.output<typeof ManifestGameSchema>;
export type ManifestFileRule = NonNullable<ManifestGame['files']>[string];
export type ManifestRegistryRule = NonNullable<ManifestGame['registry']>[string];
