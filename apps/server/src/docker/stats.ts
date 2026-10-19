import type { FastifyBaseLogger } from 'fastify'
import type { ContainerStatsSample } from '@vercio/shared'
import type { HostDriver } from './host-driver.js'

interface Entry {
  controller: AbortController
  samples: ContainerStatsSample[]
  lastRequested: number
}

export interface StatsSamplerOptions {
  /** Écart minimal entre deux mesures gardées. */
  intervalMs?: number
  /** Mesures gardées par conteneur (120 × 5 s = 10 minutes). */
  history?: number
  /** Arrêt de la mesure d'un conteneur que plus personne ne consulte. */
  idleMs?: number
}

/**
 * Statistiques des conteneurs, mesurées seulement pendant qu'on les consulte :
 * le flux Docker d'un conteneur est ouvert à la première demande et coupé une minute
 * après la dernière. L'historique reste en mémoire (perdu au redémarrage de Vercio).
 */
export class StatsSampler {
  readonly #host: HostDriver
  readonly #log: FastifyBaseLogger
  readonly #intervalMs: number
  readonly #history: number
  readonly #idleMs: number
  readonly #entries = new Map<string, Entry>()
  #sweeper: NodeJS.Timeout | null = null

  constructor(host: HostDriver, log: FastifyBaseLogger, options: StatsSamplerOptions = {}) {
    this.#host = host
    this.#log = log
    this.#intervalMs = options.intervalMs ?? 5000
    this.#history = options.history ?? 120
    this.#idleMs = options.idleMs ?? 60_000
  }

  /** Historique de chaque conteneur demandé ; lance la mesure de ceux qui n'en ont pas. */
  history(containerIds: string[]): Map<string, ContainerStatsSample[]> {
    const now = Date.now()
    const result = new Map<string, ContainerStatsSample[]>()
    for (const id of containerIds) {
      const entry = this.#entries.get(id) ?? this.#start(id)
      entry.lastRequested = now
      result.set(id, [...entry.samples])
    }
    return result
  }

  /** Conteneurs mesurés en ce moment. */
  get active(): number {
    return this.#entries.size
  }

  stop(): void {
    for (const entry of this.#entries.values()) entry.controller.abort()
    this.#entries.clear()
    if (this.#sweeper) clearInterval(this.#sweeper)
    this.#sweeper = null
  }

  #start(id: string): Entry {
    const entry: Entry = { controller: new AbortController(), samples: [], lastRequested: 0 }
    this.#entries.set(id, entry)
    this.#host
      .streamStats(id, {
        signal: entry.controller.signal,
        onSample: (sample) => this.#record(entry, sample),
      })
      .catch((error: unknown) => this.#log.debug({ err: error, id }, 'Statistiques indisponibles'))
      .finally(() => {
        // Conteneur arrêté ou supprimé : la prochaine demande relancera la mesure.
        if (this.#entries.get(id) === entry) this.#entries.delete(id)
      })
    this.#sweeper ??= setInterval(() => this.#sweep(), Math.max(1000, this.#idleMs / 4))
    this.#sweeper.unref()
    return entry
  }

  #record(entry: Entry, sample: ContainerStatsSample): void {
    const last = entry.samples.at(-1)
    if (last) {
      const elapsed = Date.parse(sample.at) - Date.parse(last.at)
      // La première mesure Docker n'a pas de CPU : remplacée par la suivante.
      if (last.cpuPercent === null && entry.samples.length === 1) {
        entry.samples[0] = sample
        return
      }
      if (elapsed < this.#intervalMs - 500) return
    }
    entry.samples.push(sample)
    if (entry.samples.length > this.#history) entry.samples.shift()
  }

  #sweep(): void {
    const limit = Date.now() - this.#idleMs
    for (const [id, entry] of this.#entries) {
      if (entry.lastRequested < limit) {
        entry.controller.abort()
        this.#entries.delete(id)
      }
    }
    if (!this.#entries.size && this.#sweeper) {
      clearInterval(this.#sweeper)
      this.#sweeper = null
    }
  }
}
