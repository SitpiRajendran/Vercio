import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  DatabaseBackup,
  ExternalLink,
  Loader2,
  Lock,
  Play,
  Rocket,
  RotateCw,
  Square,
} from 'lucide-react'
import type { ContainerUsage, OverviewEnvironment, OverviewProject } from '@vercio/shared'
import { useContainerActions } from '@/components/containers/container-actions'
import { ContainerList } from '@/components/containers/container-list'
import { deployedTags } from '@/components/projects/deployment-status'
import { ProjectAvatar } from '@/components/projects/project-avatar'
import { Button } from '@/components/ui/button'
import { useWorkbench, type EnvTarget } from '@/components/workbench/workbench'
import { formatDateTime, formatRelative } from '@/lib/format'
import { environmentStatus, TONE_DOT, TONE_TEXT } from '@/lib/overview'
import { cn } from '@/lib/utils'

const STORAGE_KEY = 'vercio:environnement'

/** Environnement affiché pour un projet : le dernier choisi, sinon le premier. */
export function useChosenEnvironment<E extends { id: string; slug: string }>(
  project: { id: string; environments: E[] },
  initialSlug?: string,
) {
  const [chosen, setChosen] = useState<string | null>(() => {
    if (initialSlug) return project.environments.find((env) => env.slug === initialSlug)?.id ?? null
    try {
      return localStorage.getItem(`${STORAGE_KEY}:${project.id}`)
    } catch {
      return null
    }
  })
  const env =
    project.environments.find((item) => item.id === chosen) ?? project.environments[0] ?? null
  const choose = (id: string) => {
    setChosen(id)
    try {
      localStorage.setItem(`${STORAGE_KEY}:${project.id}`, id)
    } catch {
      // Stockage indisponible (navigation privée) : le choix vaut pour cette page.
    }
  }
  return [env, choose] as const
}

export function envTarget(
  project: { id: string; slug: string; name: string },
  env: { id: string; name: string },
): EnvTarget {
  return {
    projectId: project.id,
    projectSlug: project.slug,
    projectName: project.name,
    envId: env.id,
    envName: env.name,
  }
}

/** Sélecteur discret d'environnement : affiché seulement s'il y en a plusieurs. */
export function EnvironmentPills({
  environments,
  value,
  onChange,
}: {
  environments: OverviewEnvironment[]
  value: string
  onChange: (id: string) => void
}) {
  if (environments.length < 2) return null
  return (
    <div
      role="radiogroup"
      aria-label="Environnement"
      className="bg-muted inline-flex rounded-md p-0.5"
    >
      {environments.map((env) => {
        const tone = environmentStatus(env).tone
        return (
          <button
            key={env.id}
            type="button"
            role="radio"
            aria-checked={env.id === value}
            onClick={() => onChange(env.id)}
            className={cn(
              'flex items-center gap-1.5 rounded px-2 py-0.5 text-xs',
              env.id === value ? 'bg-background shadow-xs' : 'text-muted-foreground',
            )}
          >
            <span className={cn('size-1.5 rounded-full', TONE_DOT[tone])} aria-hidden />
            {env.name}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Boutons selon l'état de l'environnement : jamais déployé (ou sans conteneur) → « Déployer » ;
 * arrêté → « Démarrer » et « Mettre à jour » ; en marche → « Mettre à jour », « Redémarrer »,
 * « Arrêter ».
 */
export function EnvironmentActions({
  target,
  env,
  actions,
  compact = false,
  url,
}: {
  target: EnvTarget
  env: OverviewEnvironment
  actions: ReturnType<typeof useContainerActions>
  compact?: boolean
  /** Adresse du site : bouton « Ouvrir le site ». */
  url?: string | null
}) {
  const workbench = useWorkbench()
  const open = url && (
    <Button size="sm" variant="outline" asChild>
      <a href={url} target="_blank" rel="noreferrer" title={url}>
        <ExternalLink />
        {compact ? 'Ouvrir' : 'Ouvrir le site'}
      </a>
    </Button>
  )
  if (!workbench.canDeploy) return open || null
  const deploying =
    env.lastDeployment?.status === 'queued' || env.lastDeployment?.status === 'running'
  const hasContainers = env.containers.length > 0
  const anyRunning = env.containers.some((container) => container.state === 'running')
  const stopped = hasContainers && !anyRunning
  const whole = actions.pending && !actions.pending.service ? actions.pending.action : null
  const disabled = actions.busy || deploying

  const deploy = (
    <Button
      size="sm"
      variant={stopped ? 'outline' : 'default'}
      onClick={() => workbench.openDeploy(target)}
    >
      {deploying ? <Loader2 className="animate-spin" /> : <Rocket />}
      {deploying ? 'Déploiement…' : hasContainers ? 'Mettre à jour' : 'Déployer'}
    </Button>
  )
  return (
    <div className="flex flex-wrap items-center gap-2">
      {open}
      {stopped && (
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => actions.run('start')}
          aria-label="Démarrer"
        >
          {whole === 'start' ? <Loader2 className="animate-spin" /> : <Play />}
          {!compact && 'Démarrer'}
        </Button>
      )}
      {deploy}
      {anyRunning && (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => actions.run('restart')}
            aria-label="Redémarrer"
          >
            {whole === 'restart' ? <Loader2 className="animate-spin" /> : <RotateCw />}
            {!compact && 'Redémarrer'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-destructive hover:text-destructive"
            disabled={disabled}
            onClick={() => actions.run('stop')}
            aria-label="Arrêter"
          >
            <Square />
            {!compact && 'Arrêter'}
          </Button>
        </>
      )}
    </div>
  )
}

/** Ligne « version en service », discrète. */
export function VersionLine({ env }: { env: OverviewEnvironment }) {
  if (!env.current) return null
  const at = env.current.finishedAt ?? env.current.createdAt
  const tags = Object.keys(env.current.versions).length ? deployedTags(env.current) : null
  return (
    <span title={formatDateTime(at)}>
      {tags ? (
        <>
          <span className="text-foreground font-mono">{tags}</span> en service depuis{' '}
        </>
      ) : (
        'Déployé '
      )}
      {formatRelative(at)}
      {env.locked && <Lock className="ml-1 inline size-3" aria-label="version verrouillée" />}
    </span>
  )
}

/** « Sauvegardé il y a 3 h », en rouge si la dernière a échoué. */
export function BackupLine({
  env,
  projectSlug,
}: {
  env: OverviewEnvironment
  projectSlug: string
}) {
  const backup = env.lastBackup
  if (!backup) return null
  const at = backup.finishedAt ?? backup.startedAt
  const label =
    backup.status === 'running'
      ? 'Sauvegarde en cours'
      : backup.status === 'failed'
        ? `Sauvegarde échouée ${formatRelative(at)}`
        : backup.status === 'partial'
          ? `Sauvegarde incomplète ${formatRelative(at)}`
          : `Sauvegardé ${formatRelative(at)}`
  return (
    <Link
      to="/projets/$slug"
      params={{ slug: projectSlug }}
      search={{ onglet: 'sauvegardes', env: env.slug }}
      title={formatDateTime(at)}
      className={cn(
        'inline-flex items-center gap-1 hover:underline',
        backup.status === 'failed' && 'text-destructive',
        backup.status === 'partial' && 'text-warning',
      )}
    >
      <DatabaseBackup className="size-3" />
      {label}
    </Link>
  )
}

/** Carte d'un projet sur l'accueil : son état, ses conteneurs et les actions courantes. */
export function ProjectOverviewCard({
  project,
  usage,
}: {
  project: OverviewProject
  usage?: Map<string, ContainerUsage>
}) {
  const [env, choose] = useChosenEnvironment(project)
  if (!env) return null
  return <CardBody key={env.id} project={project} env={env} onChoose={choose} usage={usage} />
}

function CardBody({
  project,
  env,
  onChoose,
  usage,
}: {
  project: OverviewProject
  env: OverviewEnvironment
  onChoose: (id: string) => void
  usage?: Map<string, ContainerUsage>
}) {
  const target = envTarget(project, env)
  const actions = useContainerActions(target)
  const status = environmentStatus(env)
  return (
    <article className="bg-card flex flex-col gap-3 rounded-xl border p-4 shadow-xs">
      <header className="flex flex-wrap items-start gap-3">
        <Link to="/projets/$slug" params={{ slug: project.slug }} className="shrink-0">
          <ProjectAvatar project={project} size="lg" />
        </Link>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate font-semibold">
              <Link to="/projets/$slug" params={{ slug: project.slug }} className="hover:underline">
                {project.name}
              </Link>
            </h2>
            <EnvironmentPills
              environments={project.environments}
              value={env.id}
              onChange={onChoose}
            />
          </div>
          <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
            <span className={cn('flex items-center gap-1.5 font-medium', TONE_TEXT[status.tone])}>
              <span className={cn('size-2 rounded-full', TONE_DOT[status.tone])} aria-hidden />
              {status.label}
            </span>
            <VersionLine env={env} />
            <BackupLine env={env} projectSlug={project.slug} />
          </p>
        </div>
        <div className="w-full sm:w-auto">
          <EnvironmentActions
            target={target}
            env={env}
            actions={actions}
            url={project.url}
            compact
          />
        </div>
      </header>
      {env.lastDeployment?.status === 'failed' && (
        <p className="text-destructive text-xs">
          Dernier déploiement échoué
          {env.lastDeployment.error ? ` : ${env.lastDeployment.error}` : ''}{' '}
          <Link
            to="/projets/$slug/deploiements/$deploymentId"
            params={{ slug: project.slug, deploymentId: env.lastDeployment.id }}
            className="underline underline-offset-4"
          >
            Journal
          </Link>
        </p>
      )}
      {env.containers.length > 0 ? (
        <ContainerList
          target={target}
          containers={env.containers}
          usage={usage}
          alerts={env.alerts}
          actions={actions}
        />
      ) : (
        <p className="text-muted-foreground rounded-lg border border-dashed py-4 text-center text-sm">
          {env.current ? 'Aucun conteneur.' : 'Jamais déployé : cliquez sur « Déployer ».'}
        </p>
      )}
      {actions.dialog}
    </article>
  )
}
