import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Isolated config home BEFORE importing the module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dune-config-test-'));
process.env.DUNE_CONFIG_DIR = TMP;

const { ConfigManager } = await import('./config.js');
import type { DuneConfig } from './config.js';

const managers: Array<{ stop: () => void }> = [];

afterEach(() => {
  while (managers.length > 0) managers.pop()?.stop();
  for (const entry of fs.readdirSync(TMP)) {
    fs.rmSync(path.join(TMP, entry), { recursive: true, force: true });
  }
});

function freshManager(file = 'dune.config.json') {
  const mgr = new ConfigManager({ configPath: path.join(TMP, file) });
  managers.push(mgr);
  return mgr;
}

function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe('ConfigManager', () => {
  it('writes defaults on first boot', () => {
    const mgr = freshManager();
    expect(mgr.getConfig().server.port).toBe(3030);
    expect(fs.existsSync(path.join(TMP, 'dune.config.json'))).toBe(true);
  });

  it('deep-merges partial files without wiping nested defaults', () => {
    fs.writeFileSync(
      path.join(TMP, 'dune.config.json'),
      JSON.stringify({ sync: { maxVersions: 7 } }),
    );
    const mgr = freshManager();
    const cfg = mgr.getConfig();
    expect(cfg.sync.maxVersions).toBe(7);
    expect(cfg.server.port).toBe(3030);
    expect(cfg.sync.autoSync).toBe(true);
  });

  it('falls back to defaults on corrupt JSON', () => {
    fs.writeFileSync(path.join(TMP, 'dune.config.json'), '{nope');
    const mgr = freshManager();
    expect(mgr.getConfig().server.port).toBe(3030);
  });

  it('updateConfig persists and emits a change', () => {
    const mgr = freshManager();
    let seen: DuneConfig | null = null;
    mgr.on('change', (next: DuneConfig) => {
      seen = next;
    });
    mgr.updateConfig({ sync: { maxVersions: 3, autoSync: false, syncInterval: 60000 } });
    expect(seen).not.toBeNull();
    const raw = JSON.parse(fs.readFileSync(path.join(TMP, 'dune.config.json'), 'utf-8'));
    expect(raw.sync.maxVersions).toBe(3);
    // Nested sections untouched by the partial update.
    expect(raw.server.port).toBe(3030);
  });

  it('hot-reloads external file edits', async () => {
    const mgr = freshManager();
    let reloaded: DuneConfig | null = null;
    mgr.on('change', (next: DuneConfig) => {
      reloaded = next;
    });
    const file = path.join(TMP, 'dune.config.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    raw.sync.maxVersions = 9;
    fs.writeFileSync(file, JSON.stringify(raw, null, 2));
    await waitFor(() => reloaded !== null);
    expect((reloaded as unknown as DuneConfig).sync.maxVersions).toBe(9);
    expect(mgr.getConfig().sync.maxVersions).toBe(9);
  });

  it('respects a custom config path', () => {
    const mgr = freshManager('custom.json');
    expect(mgr.getConfigPath()).toBe(path.join(TMP, 'custom.json'));
    expect(fs.existsSync(path.join(TMP, 'custom.json'))).toBe(true);
  });

  it('stop() is idempotent', () => {
    const mgr = freshManager();
    expect(() => {
      mgr.stop();
      mgr.stop();
    }).not.toThrow();
  });

  it('initConfig is a singleton and the config proxy reads live values', async () => {
    const { initConfig, getConfig, config } = await import('./config.js');
    const a = initConfig();
    const b = initConfig();
    expect(b).toBe(a);
    managers.push(a);
    expect(getConfig().server.port).toBe(3030);
    expect(config.server.port).toBe(3030);
    expect(config.sync.maxVersions).toBeGreaterThan(0);
    expect(config.data.savesDir).toContain('saves');
    expect(typeof config.client.minimizeToTray).toBe('boolean');
    expect(typeof config.ollamaAI.timeout).toBe('number');
    expect('steamGridDb' in config).toBe(false); // DUN-092: never in the config file
  });
});
