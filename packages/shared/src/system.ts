import { z } from 'zod'

export const healthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  database: z.boolean(),
  docker: z.boolean(),
  /** Démarrage du processus : change après un redémarrage (restauration de Vercio). */
  startedAt: z.string().optional(),
})
export type Health = z.infer<typeof healthSchema>

export const dockerInfoSchema = z.object({
  serverVersion: z.string(),
  operatingSystem: z.string(),
  architecture: z.string(),
  cpus: z.number(),
  memoryBytes: z.number(),
  containers: z.object({
    total: z.number(),
    running: z.number(),
    paused: z.number(),
    stopped: z.number(),
  }),
  images: z.number(),
})
export type DockerInfo = z.infer<typeof dockerInfoSchema>
