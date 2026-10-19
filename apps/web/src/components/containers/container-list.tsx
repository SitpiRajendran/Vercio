import { useState } from 'react'
import {
  ExternalLink,
  Gauge,
  Loader2,
  Lock,
  MoreHorizontal,
  Play,
  RotateCw,
  ScrollText,
  Square,
  SquareTerminal,
  View,
} from 'lucide-react'
import type { ContainerUsage, ContainerView, PublishedPort, ResourceAlert } from '@vercio/shared'
import { InspectSheet } from '@/components/containers/inspect-sheet'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useWorkbench, type EnvTarget } from '@/components/workbench/workbench'
import { formatBytes } from '@/lib/format'
import { containerStatus, isRunning, TONE_DOT, TONE_TEXT } from '@/lib/overview'
import { cn } from '@/lib/utils'
import type { useContainerActions } from './container-actions'

/**
 * Conteneurs d'un environnement : état, ports ouverts, consommation, et accès direct aux
 * logs, au terminal et aux actions.
 */
export function ContainerList({
  target,
  containers,
  usage,
  alerts = [],
  actions,
  className,
}: {
  target: EnvTarget
  containers: ContainerView[]
  usage?: Map<string, ContainerUsage>
  /** Saturations CPU ou mémoire des dernières 24 h. */
  alerts?: ResourceAlert[]
  actions: ReturnType<typeof useContainerActions>
  className?: string
}) {
  const [inspected, setInspected] = useState<ContainerView | null>(null)
  return (
    <>
      <ul className={cn('divide-y rounded-lg border', className)}>
        {containers.map((container) => (
          <ContainerRow
            key={container.id}
            target={target}
            container={container}
            usage={usage?.get(container.id)}
            alerts={alerts.filter((alert) => alert.service === container.service)}
            actions={actions}
            onInspect={() => setInspected(container)}
          />
        ))}
      </ul>
      <InspectSheet
        projectId={target.projectId}
        envId={target.envId}
        container={inspected}
        onClose={() => setInspected(null)}
      />
    </>
  )
}

function ContainerRow({
  target,
  container,
  usage,
  alerts,
  actions,
  onInspect,
}: {
  target: EnvTarget
  container: ContainerView
  usage?: ContainerUsage
  alerts: ResourceAlert[]
  actions: ReturnType<typeof useContainerActions>
  onInspect: () => void
}) {
  const workbench = useWorkbench()
  const status = containerStatus(container)
  const running = isRunning(container)
  const pending = actions.pending?.service === container.service ? actions.pending.action : null
  const memoryHigh =
    usage && usage.memoryLimitBytes > 0 && usage.memoryBytes / usage.memoryLimitBytes > 0.9

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2 text-sm">
      <span
        className={cn('size-2 shrink-0 rounded-full', TONE_DOT[status.tone])}
        aria-hidden
        title={container.status}
      />
      <div className="min-w-28 flex-1 basis-40">
        <p className="truncate font-medium" title={container.name}>
          {container.service || container.name}
        </p>
        <p className={cn('truncate text-xs', TONE_TEXT[status.tone])} title={container.status}>
          {status.label}
        </p>
      </div>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {alerts.map((alert) => (
          <AlertChip key={alert.metric} alert={alert} />
        ))}
        {container.published.map((port) => (
          <PortChip key={`${port.ip}-${port.hostPort}-${port.protocol}`} port={port} />
        ))}
      </div>
      {usage && running && (
        <p
          className={cn(
            'text-muted-foreground w-28 shrink-0 text-right text-xs tabular-nums',
            memoryHigh && 'text-destructive',
          )}
          title="Processeur (100 % = un cœur) et mémoire, dernière mesure"
        >
          {usage.cpuPercent === null ? '—' : `${usage.cpuPercent.toFixed(0)} %`} ·{' '}
          {formatBytes(usage.memoryBytes)}
        </p>
      )}
      <div className="ml-auto flex shrink-0 items-center">
        {pending && <Loader2 className="text-muted-foreground mr-1 size-4 animate-spin" />}
        {workbench.canDeploy && !running && (
          <Button
            variant="ghost"
            size="icon"
            className="text-success size-7"
            aria-label={`Démarrer ${container.service}`}
            title="Démarrer"
            disabled={actions.busy}
            onClick={() => actions.run('start', container.service)}
          >
            <Play />
          </Button>
        )}
        <Button
          variant={status.tone === 'error' ? 'outline' : 'ghost'}
          size="sm"
          className={cn('h-7 px-2', status.tone === 'error' && 'text-destructive')}
          onClick={() => workbench.openLogs(target, container.service)}
        >
          <ScrollText />
          Logs
        </Button>
        {workbench.canUseTerminal && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={`Terminal dans ${container.service}`}
            title={container.state === 'running' ? 'Terminal' : 'Conteneur arrêté'}
            disabled={container.state !== 'running'}
            onClick={() =>
              workbench.openTerminal(target, {
                id: container.id,
                name: container.name,
                service: container.service,
              })
            }
          >
            <SquareTerminal />
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={`Actions sur ${container.service}`}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onInspect}>
              <View />
              Inspecter (variables, volumes, réseaux)
            </DropdownMenuItem>
            {workbench.canDeploy && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={actions.busy || running}
                  onSelect={() => actions.run('start', container.service)}
                >
                  <Play />
                  Démarrer
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={actions.busy}
                  onSelect={() => actions.run('restart', container.service)}
                >
                  <RotateCw />
                  Redémarrer
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  disabled={actions.busy || !running}
                  onSelect={() => actions.run('stop', container.service)}
                >
                  <Square />
                  Arrêter
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  )
}

/** Port publié : lien s'il est ouvert à tous, cadenas s'il n'écoute que sur l'hôte. */
export function PortChip({ port }: { port: PublishedPort }) {
  const local = port.ip === '127.0.0.1' || port.ip === '::1'
  const label = `${port.ip && !local ? `${port.ip}:` : ''}${port.hostPort}${port.protocol === 'tcp' ? '' : `/${port.protocol}`}`
  const className =
    'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-xs'
  if (local) {
    return (
      <span
        className={cn(className, 'text-muted-foreground')}
        title={`Port ${port.hostPort} → ${port.containerPort} dans le conteneur, joignable depuis l’hôte seulement (127.0.0.1)`}
      >
        <Lock className="size-3" />
        {label}
      </span>
    )
  }
  if (port.protocol !== 'tcp') {
    return (
      <span
        className={className}
        title={`Ouvert sur toutes les interfaces → ${port.containerPort}`}
      >
        {label}
      </span>
    )
  }
  const host = port.ip ?? window.location.hostname
  return (
    <a
      href={`http://${host.includes(':') ? `[${host}]` : host}:${port.hostPort}`}
      target="_blank"
      rel="noreferrer"
      className={cn(className, 'hover:bg-accent')}
      title={`Ouvert à tous sur le port ${port.hostPort} (→ ${port.containerPort} dans le conteneur) : accessible de l’extérieur si le pare-feu le permet`}
    >
      {label}
      <ExternalLink className="size-3" />
    </a>
  )
}

/** « RAM saturée ×4 » : épisodes de saturation des dernières 24 h. */
export function AlertChip({ alert }: { alert: ResourceAlert }) {
  const label = alert.metric === 'cpu' ? 'CPU saturé' : 'RAM saturée'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs',
        alert.active ? 'border-destructive/40 text-destructive' : 'border-warning/40 text-warning',
      )}
      title={`${alert.episodes} épisode${alert.episodes > 1 ? 's' : ''} de saturation sur 24 h, pic à ${alert.peak} %${alert.metric === 'cpu' ? ' d’un cœur' : ' de la limite'}${alert.active ? ' ; en cours' : ''}`}
    >
      <Gauge className="size-3" />
      {label}
      {alert.episodes > 1 && ` ×${alert.episodes}`}
    </span>
  )
}
