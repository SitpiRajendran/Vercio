import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  CircleDashed,
  ExternalLink,
  GitCommitHorizontal,
  Loader2,
  Radio,
  RefreshCw,
  Tag,
  Wand2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  suggestTagConvention,
  type CommitInfo,
  type ProjectView,
  type TagConvention,
  type VersionChoices,
} from '@vercio/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { saveTagConvention } from '@/components/projects/tag-convention-editor'
import { useWorkbench } from '@/components/workbench/workbench'
import { api } from '@/lib/api'
import { formatDateTime, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

const LATEST = 'latest'

/**
 * Choix de la version d'une source : le dernier build de la branche, ou l'une des 5 versions
 * les plus récentes (tags Git ou commits) dont les images ont été construites par la CI.
 */
export function VersionPicker({
  projectId,
  sourceId,
  branch,
  value,
  onChange,
  currentRef,
  project,
}: {
  projectId: string
  sourceId: string
  branch: string
  value: string
  onChange: (ref: string, kind: 'latest' | 'tag') => void
  /** Version actuellement configurée sur l'environnement (badge « actuelle »). */
  currentRef?: string
  /** Projet : permet de corriger la convention de tags sur place. */
  project?: ProjectView
}) {
  const queryClient = useQueryClient()
  const queryKey = ['projects', projectId, 'versions', sourceId, branch]
  const versions = useQuery({
    queryKey,
    queryFn: () => api.projects.versions(projectId, sourceId, branch),
    staleTime: 60_000,
  })
  const [refreshing, setRefreshing] = useState(false)
  const [manual, setManual] = useState(false)

  async function refresh() {
    setRefreshing(true)
    try {
      queryClient.setQueryData(
        queryKey,
        await api.projects.versions(projectId, sourceId, branch, true),
      )
    } finally {
      setRefreshing(false)
    }
  }

  if (versions.isPending) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 rounded-lg border p-3 text-sm">
        <Loader2 className="size-4 animate-spin" />
        Lecture des tags et du registry…
      </div>
    )
  }
  if (versions.error) {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-destructive text-sm">
          {versions.error.message}
        </p>
        <ManualInput
          value={value}
          onChange={(ref) => onChange(ref, ref === 'latest' ? 'latest' : 'tag')}
        />
      </div>
    )
  }

  const data: VersionChoices = versions.data
  // « latest » désigne le canal de la branche, quel que soit son nom (latest, develop-latest…).
  const isLatest = (ref: string | undefined) => ref === LATEST || ref === data.latest.tag
  const known = isLatest(value) || data.tags.some((tag) => tag.name === value)
  const suggestion = suggestTagConvention({
    branch,
    registryTags: data.registryTags ?? [],
    latestAvailable: data.latest.available,
    versionSource: data.versionSource,
    hasVersions: data.tags.length > 0,
  })

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">Vérifié {formatRelative(data.checkedAt)}</p>
        <Button type="button" variant="ghost" size="sm" onClick={refresh} disabled={refreshing}>
          <RefreshCw className={cn(refreshing && 'animate-spin')} />
          Actualiser
        </Button>
      </div>

      {suggestion && (
        <ConventionFix
          project={project}
          sourceId={sourceId}
          suggestion={suggestion}
          missingTag={data.latest.available ? null : data.latest.tag}
        />
      )}

      <div
        role="radiogroup"
        aria-label={`Version de la branche ${branch}`}
        className="divide-y overflow-hidden rounded-lg border"
      >
        <Option
          selected={isLatest(value)}
          disabled={false}
          onSelect={() => onChange(LATEST, 'latest')}
          icon={<Radio className="size-4" />}
          title={data.latest.tag}
          badges={
            <>
              <Badge variant="secondary">Dernier build</Badge>
              {isLatest(currentRef) && <Badge variant="outline">Actuelle</Badge>}
            </>
          }
          subtitle={
            data.latest.available ? (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                {data.latest.pushedAt && <BuiltAt date={data.latest.pushedAt} />}
                {data.latest.version && (
                  <>
                    <span>
                      ={' '}
                      <span className="text-foreground font-mono">{data.latest.version.name}</span>
                    </span>
                    <CommitLink
                      commit={data.latest.version.commit}
                      versionName={data.latest.version.name}
                    />
                  </>
                )}
                <span>· suit automatiquement les nouveaux builds</span>
              </span>
            ) : (
              `Aucune image ${data.latest.tag}${data.latest.missing.length ? ` pour ${data.latest.missing.join(', ')}` : ''}`
            )
          }
          warning={!data.latest.available}
        />
        {data.tags.length === 0 && (
          <p className="text-muted-foreground p-3 text-sm">
            {data.versionSource === 'commits'
              ? `Aucune image trouvée pour les derniers commits de la branche ${branch}.`
              : `Aucun tag de version sur la branche ${branch}.`}
          </p>
        )}
        {data.tags.map((tag) => (
          <Option
            key={tag.name}
            selected={value === tag.name}
            disabled={!tag.complete}
            onSelect={() => onChange(tag.name, 'tag')}
            icon={tag.complete ? <Tag className="size-4" /> : <CircleDashed className="size-4" />}
            title={tag.name}
            badges={
              <>
                {!tag.complete && (
                  <Badge variant="outline" className="text-warning">
                    Build incomplet : {tag.missing.join(', ')}
                  </Badge>
                )}
                {currentRef === tag.name && <Badge variant="outline">Actuelle</Badge>}
              </>
            }
            subtitle={
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                {tag.pushedAt ? (
                  <BuiltAt date={tag.pushedAt} />
                ) : (
                  tag.commit.date && <span>Commit du {formatDateTime(tag.commit.date)}</span>
                )}
                <CommitLink commit={tag.commit} versionName={tag.name} />
                <a
                  href={tag.pipelineUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-foreground inline-flex items-center gap-1"
                  onClick={(event) => event.stopPropagation()}
                >
                  Pipeline
                  <ExternalLink className="size-3" />
                </a>
              </span>
            }
          />
        ))}
      </div>

      {/* Une correction est proposée plus haut : le détail reste accessible, replié. */}
      {suggestion && data.warnings.length > 0 ? (
        <details className="text-muted-foreground text-xs">
          <summary className="hover:text-foreground cursor-pointer">Détails</summary>
          <div className="mt-1 space-y-1">
            {data.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        </details>
      ) : (
        data.warnings.map((warning) => (
          <p key={warning} className="text-warning flex items-start gap-2 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {warning}
          </p>
        ))
      )}

      {manual || (!known && value) ? (
        <ManualInput
          value={value}
          onChange={(ref) => onChange(ref, ref === data.latest.tag ? 'latest' : 'tag')}
        />
      ) : (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
          onClick={() => setManual(true)}
        >
          Saisir un autre tag…
        </button>
      )}
    </div>
  )
}

/**
 * La CI ne pousse pas les tags attendus, mais le registry en contient d'autres qui conviennent :
 * correction de la convention de tags du dépôt en un clic (administrateurs).
 */
function ConventionFix({
  project,
  sourceId,
  suggestion,
  missingTag,
}: {
  project?: ProjectView
  sourceId: string
  suggestion: NonNullable<ReturnType<typeof suggestTagConvention>>
  missingTag: string | null
}) {
  const { isAdmin } = useWorkbench()
  const queryClient = useQueryClient()
  const patch: Partial<TagConvention> = {
    ...(suggestion.latest ? { latestTagTemplate: suggestion.latest.template } : {}),
    ...(suggestion.commits
      ? { versionSource: 'commits', commitTagTemplate: suggestion.commits.template }
      : {}),
  }
  const apply = useMutation({
    mutationFn: () => saveTagConvention(project!, sourceId, patch),
    onSuccess: async (updated) => {
      queryClient.setQueryData(['projects', updated.slug], updated)
      await queryClient.invalidateQueries({ queryKey: ['projects', updated.id, 'versions'] })
      toast.success('Convention de tags enregistrée')
    },
    onError: (failure) => toast.error(failure.message),
  })

  return (
    <div className="border-warning/40 bg-warning/5 space-y-2 rounded-lg border p-3 text-sm">
      <p className="flex items-start gap-2 font-medium">
        <Wand2 className="text-warning mt-0.5 size-4 shrink-0" />
        {missingTag
          ? `Votre CI ne pousse pas le tag « ${missingTag} », mais d’autres tags conviennent :`
          : 'Votre CI pousse des images par commit :'}
      </p>
      <ul className="text-muted-foreground list-disc space-y-0.5 pl-10 text-xs">
        {suggestion.latest && (
          <li>
            dernier build : suivre <code className="text-foreground">{suggestion.latest.tag}</code>
          </li>
        )}
        {suggestion.commits && (
          <li>
            versions proposées : les derniers commits (images{' '}
            <code className="text-foreground">{suggestion.commits.example}</code>…)
          </li>
        )}
      </ul>
      {isAdmin && project ? (
        <div className="pl-6">
          <Button type="button" size="sm" onClick={() => apply.mutate()} disabled={apply.isPending}>
            {apply.isPending && <Loader2 className="animate-spin" />}
            Utiliser ces tags
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground pl-6 text-xs">
          Demandez à un administrateur de régler la convention de tags (Paramètres du projet).
        </p>
      )}
    </div>
  )
}

/** Date de construction de l'image : absolue, avec l'écart relatif. */
function BuiltAt({ date }: { date: string }) {
  return (
    <span>
      Construite le {formatDateTime(date)} ({formatRelative(date)})
    </span>
  )
}

/**
 * Commit associé à une version : SHA court (lien), message et auteur. Le SHA n'est pas répété
 * quand le nom de la version est déjà le SHA (versions par commit).
 */
function CommitLink({ commit, versionName }: { commit: CommitInfo; versionName?: string }) {
  const shaInName = Boolean(versionName && commit.sha.startsWith(versionName))
  return (
    <>
      <a
        href={commit.url}
        target="_blank"
        rel="noreferrer"
        aria-label={`Commit ${commit.shortSha}`}
        className="hover:text-foreground inline-flex items-center gap-1 font-mono"
        onClick={(event) => event.stopPropagation()}
      >
        <GitCommitHorizontal className="size-3" />
        {shaInName ? 'commit' : commit.shortSha}
      </a>
      {commit.message && <span className="truncate">{commit.message}</span>}
      {commit.author && <span>· {commit.author}</span>}
    </>
  )
}

function Option({
  selected,
  disabled,
  onSelect,
  icon,
  title,
  badges,
  subtitle,
  warning,
}: {
  selected: boolean
  disabled: boolean
  onSelect: () => void
  icon: React.ReactNode
  title: string
  badges?: React.ReactNode
  subtitle: React.ReactNode
  warning?: boolean
}) {
  return (
    <div
      role="radio"
      aria-checked={selected}
      aria-disabled={disabled}
      aria-label={title}
      tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && onSelect()}
      onKeyDown={(event) => {
        if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        'flex cursor-pointer items-start gap-3 px-3 py-2.5 text-sm outline-none',
        'hover:bg-accent/60 focus-visible:bg-accent',
        selected && 'bg-accent',
        disabled && 'cursor-not-allowed opacity-60 hover:bg-transparent',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
          selected && 'border-primary bg-primary',
        )}
      >
        {selected && <span className="bg-primary-foreground size-1.5 rounded-full" />}
      </span>
      <span className="text-muted-foreground mt-0.5">{icon}</span>
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono font-medium">{title}</span>
          {badges}
        </span>
        <span className={cn('text-muted-foreground block text-xs', warning && 'text-warning')}>
          {subtitle}
        </span>
      </span>
    </div>
  )
}

function ManualInput({ value, onChange }: { value: string; onChange: (ref: string) => void }) {
  return (
    <Input
      aria-label="Tag à déployer"
      className="font-mono text-sm"
      placeholder="v1.0.0"
      value={value}
      onChange={(event) => onChange(event.target.value.trim())}
    />
  )
}
