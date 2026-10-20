/**
 * Serialised "latest value" save queue for settings-like writes.
 *
 * - One save runs at a time.
 * - A value enqueued while a save is in flight replaces any older pending
 *   value; when the current save finishes, only the latest pending value is
 *   saved (intermediate values are skipped, never reordered).
 * - Failures are reported through onError and do not stop later saves.
 */
export interface SaveQueueOptions<T> {
  save: (value: T) => Promise<unknown>;
  onSaved?: (value: T) => void;
  onError?: (error: unknown, value: T) => void;
}

export interface SaveQueue<T> {
  enqueue(value: T): void;
  /** Resolves once nothing is in flight or pending. */
  idle(): Promise<void>;
  readonly busy: boolean;
}

export function createSaveQueue<T>({ save, onSaved, onError }: SaveQueueOptions<T>): SaveQueue<T> {
  let running: Promise<void> | null = null;
  let pending: { value: T } | null = null;

  const drain = async () => {
    while (pending) {
      const { value } = pending;
      pending = null;
      try {
        const result = await save(value);
        if (result === false) throw new Error('Save was rejected');
        onSaved?.(value);
      } catch (error) {
        onError?.(error, value);
      }
    }
    running = null;
  };

  return {
    enqueue(value: T) {
      pending = { value };
      if (!running) running = drain();
    },
    idle: () => running ?? Promise.resolve(),
    get busy() {
      return running !== null;
    },
  };
}
