/** Speed / ETA over a sliding window of byte-count samples. */
export class SpeedMeter {
  private samples: Array<{ t: number; bytes: number }> = [];

  constructor(private readonly windowMs = 5000) {}

  reset(): void {
    this.samples = [];
  }

  /** Record the running byte total at time `now` (ms). */
  sample(bytes: number, now: number): void {
    this.samples.push({ t: now, bytes });
    const cutoff = now - this.windowMs;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift();
  }

  /** Bytes per second; 0 until two samples span some time. */
  speed(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) return 0;
    return Math.max(0, (last.bytes - first.bytes) / dt);
  }

  /** Seconds remaining, or null when total or speed is unknown. */
  eta(bytes: number, total: number | null): number | null {
    if (total === null || total <= 0) return null;
    if (bytes >= total) return 0;
    const s = this.speed();
    return s > 0 ? Math.ceil((total - bytes) / s) : null;
  }
}
