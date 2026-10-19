import { CheckCircle2, CircleDashed, Loader2, Undo2, XCircle, type LucideIcon } from 'lucide-react'
import type { DeploymentStatus, DeploymentSummary } from '@vercio/shared'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const STATUS: Record<
  DeploymentStatus,
  { label: string; icon: LucideIcon; className: string; spin?: boolean }
> = {
  queued: { label: 'En attente', icon: CircleDashed, className: 'text-muted-foreground' },
  running: { label: 'En cours', icon: Loader2, className: 'text-primary', spin: true },
  succeeded: { label: 'Réussi', icon: CheckCircle2, className: 'text-success' },
  failed: { label: 'Échec', icon: XCircle, className: 'text-destructive' },
  rolled_back: {
    label: 'Échec, version précédente rétablie',
    icon: Undo2,
    className: 'text-warning',
  },
  interrupted: { label: 'Interrompu', icon: XCircle, className: 'text-muted-foreground' },
}

export const TRIGGER_LABELS: Record<DeploymentSummary['trigger'], string> = {
  user: 'Manuel',
  webhook: 'Webhook',
  rollback: 'Retour arrière',
  auto_rollback: 'Retour automatique',
}

export function DeploymentStatusBadge({
  status,
  className,
}: {
  status: DeploymentStatus
  className?: string
}) {
  const { label, icon: Icon, className: tone, spin } = STATUS[status]
  return (
    <Badge variant="outline" className={cn('gap-1.5', tone, className)}>
      <Icon className={cn('size-3.5', spin && 'animate-spin')} />
      {label}
    </Badge>
  )
}

export const isFinal = (status: DeploymentStatus) => status !== 'queued' && status !== 'running'

/** Tags déployés, lisibles : « v1.5 » ou « latest ». */
export function deployedTags(deployment: DeploymentSummary): string {
  const tags = [...new Set(Object.values(deployment.versions).map((version) => version.tag))]
  return tags.join(', ') || 'images fixes'
}

export function duration(deployment: DeploymentSummary): string | null {
  if (!deployment.startedAt || !deployment.finishedAt) return null
  const seconds = Math.round(
    (Date.parse(deployment.finishedAt) - Date.parse(deployment.startedAt)) / 1000,
  )
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`
}
