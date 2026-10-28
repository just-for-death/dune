/** Minimal typed event emitter (no Node EventEmitter 'error' semantics). */
export class TypedEmitter<Events extends { [K in keyof Events]: (...args: never[]) => void }> {
  private listeners = new Map<keyof Events, Set<Events[keyof Events]>>();

  on<K extends keyof Events>(event: K, listener: Events[K]): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => this.off(event, listener);
  }

  once<K extends keyof Events>(event: K, listener: Events[K]): () => void {
    const wrapped = ((...args: Parameters<Events[K]>) => {
      off();
      (listener as (...a: Parameters<Events[K]>) => void)(...args);
    }) as unknown as Events[K];
    const off = this.on(event, wrapped);
    return off;
  }

  off<K extends keyof Events>(event: K, listener: Events[K]): void {
    this.listeners.get(event)?.delete(listener);
  }

  /** Calls listeners in order; a throwing listener never breaks the engine. */
  protected emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        (listener as (...a: Parameters<Events[K]>) => void)(...args);
      } catch (err) {
        console.error(`[downloads] listener for "${String(event)}" threw:`, err);
      }
    }
  }
}
