import { z } from 'zod'

export const projectTypeSchema = z.enum(['compose', 'single'])
export const composeSourceSchema = z.enum(['inline', 'git'])
export const versionModeSchema = z.enum(['tracking', 'locked'])
export const deployStrategySchema = z.enum(['recreate', 'blue-green'])
export const gitProviderTypeSchema = z.enum(['gitlab', 'github'])
export const registryTypeSchema = z.enum(['gitlab', 'ghcr', 'oci'])
export const deploymentStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'rolled_back',
  'interrupted',
])
export const deploymentTriggerSchema = z.enum(['user', 'webhook', 'rollback', 'auto_rollback'])

export type ProjectType = z.infer<typeof projectTypeSchema>
export type GitProviderType = z.infer<typeof gitProviderTypeSchema>
export type VersionMode = z.infer<typeof versionModeSchema>
export type DeployStrategy = z.infer<typeof deployStrategySchema>
export type DeploymentStatus = z.infer<typeof deploymentStatusSchema>
