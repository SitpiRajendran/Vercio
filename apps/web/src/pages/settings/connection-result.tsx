import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import type { ConnectionCheck } from '@vercio/shared'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/** Résultat détaillé d'un test de connexion. */
export function ConnectionResult({
  check,
  className,
}: {
  check: ConnectionCheck
  className?: string
}) {
  return (
    <div
      role="status"
      className={cn(
        'space-y-2 rounded-lg border p-3 text-sm',
        check.ok ? 'border-success/40 bg-success/5' : 'border-destructive/40 bg-destructive/5',
        className,
      )}
    >
      <p className="flex items-start gap-2 font-medium">
        {check.ok ? (
          <CheckCircle2 className="text-success mt-0.5 size-4 shrink-0" />
        ) : (
          <XCircle className="text-destructive mt-0.5 size-4 shrink-0" />
        )}
        {check.message}
      </p>
      {check.details.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 pl-6 text-xs">
          {check.details.map((detail) => (
            <div key={detail.label} className="contents">
              <dt className="text-muted-foreground">{detail.label}</dt>
              <dd className="break-all">{detail.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {check.warnings.map((warning) => (
        <p key={warning} className="text-warning flex items-start gap-2 pl-0.5 text-xs">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {warning}
        </p>
      ))}
    </div>
  )
}

/** Pastille d'état du dernier test. */
export function ConnectionBadge({ check }: { check: ConnectionCheck | null }) {
  if (!check) return <Badge variant="outline">Non testé</Badge>
  const date = new Date(check.checkedAt).toLocaleString('fr-FR', {
    dateStyle: 'short',
    timeStyle: 'short',
  })
  return (
    <Badge variant="outline" title={`${check.message} — ${date}`}>
      <span className={cn('size-2 rounded-full', check.ok ? 'bg-success' : 'bg-destructive')} />
      {check.ok ? (check.warnings.length ? 'OK, avec alertes' : 'Connecté') : 'En échec'}
    </Badge>
  )
}
