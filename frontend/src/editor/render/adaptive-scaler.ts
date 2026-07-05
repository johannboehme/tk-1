import { clamp } from "../../lib/clamp";
/**
 * Adaptive resolution scaler für die Live-Preview.
 *
 * Die App ist als Instrument spielbar (Punch-In-Effekte, Multi-Cam,
 * Cuts) und MUSS responsiv bleiben — bei mehreren 4K-Sources kann der
 * Backend ins Stottern kommen. Statt frames zu droppen reduzieren wir
 * lieber die Backbuffer-Auflösung: das Bild wird minimal weicher,
 * aber jeder RAF-Tick bleibt im 60 fps-Budget. Auf Recovery skaliert
 * der Wert wieder hoch.
 *
 * Funktionsweise:
 *   - `record(ms)` wird pro Tick aufgerufen mit der gemessenen
 *     drawFrame-Latenz (inkl. layer/fx/present).
 *   - Sliding-Window p95 über die letzten N Samples.
 *   - Bei p95 > LAG_THRESHOLD: scale × DOWN_FACTOR (bounded by MIN).
 *   - Bei p95 < FAST_THRESHOLD: scale × UP_FACTOR (bounded by MAX = 1).
 *   - Cooldown: zwischen zwei Änderungen mindestens N Ticks Pause —
 *     verhindert Oszillation und gibt der GPU Zeit, den neuen
 *     Backbuffer-Pipeline-State zu stabilisieren.
 *
 * Stateless gegenüber Wand-Zeit: die Hysterese läuft in Frame-Zähler-
 * Einheiten, sodass das Verhalten unabhängig vom realen RAF-Takt
 * deterministisch testbar bleibt.
 */

/** Default-Bounds + thresholds. Die zahlen sind kalibriert für ein
 *  60fps-Ziel (16.67 ms/Frame). LAG_MS gibt etwas headroom (22 ms ≈
 *  45 fps); FAST_MS triggert nur wenn klar Reserve da ist (12 ms ≈
 *  80 fps), um nicht direkt nach scale-down wieder hochzuskalieren. */
export interface AdaptiveScalerConfig {
  windowSize: number;
  lagThresholdMs: number;
  fastThresholdMs: number;
  downFactor: number;
  upFactor: number;
  minScale: number;
  maxScale: number;
  cooldownTicks: number;
}

export const DEFAULT_ADAPTIVE_CONFIG: AdaptiveScalerConfig = {
  windowSize: 30,
  lagThresholdMs: 22,
  fastThresholdMs: 12,
  downFactor: 0.75,
  upFactor: 4 / 3, // 1.333 — inverse of downFactor for symmetric ramp
  minScale: 0.25,
  maxScale: 1.0,
  cooldownTicks: 30,
};

export interface AdaptiveScalerStatus {
  /** Currently selected scale ∈ [minScale, maxScale]. */
  scale: number;
  /** Did `consult()` change the scale on this call? */
  changed: boolean;
  /** p95 frame time across the current window (NaN if window not full). */
  p95Ms: number;
}

export class AdaptiveScaler {
  private config: AdaptiveScalerConfig;
  private samples: number[] = [];
  private writeIdx = 0;
  private filled = 0;
  private cooldownLeft = 0;
  /** Current scale; mutated by consult() when thresholds trip. */
  private currentScale: number;

  constructor(initialScale = 1.0, config: Partial<AdaptiveScalerConfig> = {}) {
    this.config = { ...DEFAULT_ADAPTIVE_CONFIG, ...config };
    this.currentScale = clamp(
      initialScale,
      this.config.minScale,
      this.config.maxScale,
    );
    this.samples = new Array(this.config.windowSize).fill(0);
  }

  get scale(): number {
    return this.currentScale;
  }

  /** Record a frame's measured drawFrame latency in milliseconds. */
  record(frameMs: number): void {
    const w = this.config.windowSize;
    this.samples[this.writeIdx] = frameMs;
    this.writeIdx = (this.writeIdx + 1) % w;
    if (this.filled < w) this.filled++;
  }

  /** Should be called once per tick after `record()`. Returns the new
   *  scale and whether it changed; caller is responsible for actually
   *  applying it (i.e. calling `backend.resize()` via setScale). */
  consult(): AdaptiveScalerStatus {
    if (this.cooldownLeft > 0) this.cooldownLeft--;

    const p95 = this.percentile(0.95);
    const status: AdaptiveScalerStatus = {
      scale: this.currentScale,
      changed: false,
      p95Ms: p95,
    };

    // Need at least a half-window to react — avoid flapping on a tiny
    // sample of cold-start tick times.
    if (this.filled < this.config.windowSize / 2) return status;
    if (this.cooldownLeft > 0) return status;
    if (!Number.isFinite(p95)) return status;

    const c = this.config;
    if (p95 > c.lagThresholdMs && this.currentScale > c.minScale) {
      const next = Math.max(c.minScale, this.currentScale * c.downFactor);
      if (next !== this.currentScale) {
        this.currentScale = next;
        status.scale = next;
        status.changed = true;
        this.cooldownLeft = c.cooldownTicks;
        // Throw away the old timing samples — new resolution = new
        // frame-time distribution; mixing them blurs the next decision.
        this.resetSamples();
      }
    } else if (p95 < c.fastThresholdMs && this.currentScale < c.maxScale) {
      const next = Math.min(c.maxScale, this.currentScale * c.upFactor);
      if (next !== this.currentScale) {
        this.currentScale = next;
        status.scale = next;
        status.changed = true;
        this.cooldownLeft = c.cooldownTicks;
        this.resetSamples();
      }
    }

    return status;
  }

  /** Force a manual override (e.g. user-set scale via debug HUD). Resets
   *  samples + cooldown so the auto-loop doesn't immediately fight back. */
  override(scale: number): void {
    this.currentScale = clamp(scale, this.config.minScale, this.config.maxScale);
    this.resetSamples();
    this.cooldownLeft = this.config.cooldownTicks;
  }

  private resetSamples(): void {
    this.filled = 0;
    this.writeIdx = 0;
  }

  private percentile(q: number): number {
    if (this.filled === 0) return NaN;
    const w = Math.min(this.filled, this.samples.length);
    const sorted = this.samples.slice(0, w).sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    return sorted[idx];
  }
}

