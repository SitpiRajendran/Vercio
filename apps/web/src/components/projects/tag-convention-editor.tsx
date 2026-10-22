import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  channelTag,
  commitImageTag,
  tagConventionSchema,
  type AppSourceView,
  type ProjectView,
  type TagConvention,
} from '@vercio/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { projectToInput } from '@/pages/projects/to-input'

/** Enregistre la convention de tags d'un dépôt du projet (le reste du projet est inchangé). */
export function saveTagConvention(
  project: ProjectView,
  sourceId: string,
  convention: Partial<TagConvention>,
) {
  return api.projects.update(
    project.id,
    projectToInput(project, {
      sources: projectToInput(project).sources.map((item) =>
        item.key === sourceId ? { ...item, ...convention } : item,
      ),
    }),
  )
}

const EXAMPLE_SHA = 'd4f61051a9b2c3d4e5f60718293a4b5c6d7e8f90'

/**
 * Convention de tags d'un dépôt : quel tag désigne le dernier build d'une branche, et quelles
 * versions proposer (tags Git ou commits). Elle doit correspondre à ce que pousse la CI.
 */
export function TagConventionEditor({
  project,
  source,
  canEdit,
}: {
  project: ProjectView
  source: AppSourceView
  canEdit: boolean
}) {
  const queryClient = useQueryClient()
  const [convention, setConvention] = useState<TagConvention>(source.tagConvention)
  const [customLatest, setCustomLatest] = useState(Boolean(source.tagConvention.latestTagTemplate))
  const draft: TagConvention = {
    ...convention,
    latestTagTemplate: customLatest ? convention.latestTagTemplate || '' : null,
  }
  const parsed = tagConventionSchema.safeParse({
    ...draft,
    latestTagTemplate: customLatest ? draft.latestTagTemplate : null,
  })
  const error =
    customLatest && !draft.latestTagTemplate
      ? 'Saisissez le tag du dernier build'
      : parsed.error?.issues[0]?.message
  const changed = JSON.stringify(draft) !== JSON.stringify(source.tagConvention)

  const save = useMutation({
    mutationFn: () => saveTagConvention(project, source.id, parsed.data!),
    onSuccess: async (updated) => {
      queryClient.setQueryData(['projects', project.slug], updated)
      await queryClient.invalidateQueries({ queryKey: ['projects', project.id, 'versions'] })
      toast.success('Convention de tags enregistrée')
    },
    onError: (failure) => toast.error(failure.message),
  })

  const set = (values: Partial<TagConvention>) =>
    setConvention((current) => ({ ...current, ...values }))
  const preview = (branch: string) =>
    channelTag(branch, {
      defaultBranch: source.defaultBranch,
      latestTagName: 'latest',
      latestTagTemplate: draft.latestTagTemplate || null,
    })

  return (
    <div className="space-y-4 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <a
          href={source.repositoryUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-medium hover:underline"
        >
          {source.repository}
          <ExternalLink className="text-muted-foreground size-3.5" />
        </a>
        <span className="text-muted-foreground">
          {source.gitProviderName} · branche par défaut {source.defaultBranch}
        </span>
      </div>

      <fieldset className="space-y-2" disabled={!canEdit}>
        <legend className="text-sm font-medium">Tag du dernier build</legend>
        <p className="text-muted-foreground text-xs">
          Le tag que la CI déplace à chaque build d’une branche : c’est lui que suit la version «
          latest » d’un environnement.
        </p>
        <Choice
          name={`latest-${source.id}`}
          checked={!customLatest}
          onSelect={() => setCustomLatest(false)}
          label={
            <>
              <code>latest</code> sur {source.defaultBranch}, <code>&lt;branche&gt;-latest</code>{' '}
              ailleurs (convention Vercio)
            </>
          }
        />
        <Choice
          name={`latest-${source.id}`}
          checked={customLatest}
          onSelect={() => setCustomLatest(true)}
          label="Personnalisé"
        />
        {customLatest && (
          <div className="space-y-1 pl-6">
            <Input
              aria-label="Modèle du tag du dernier build"
              className="font-mono text-sm"
              placeholder="{branch}"
              value={convention.latestTagTemplate ?? ''}
              onChange={(event) => set({ latestTagTemplate: event.target.value })}
            />
            <p className="text-muted-foreground text-xs">
              <code>{'{branch}'}</code> est remplacé par le nom de la branche :{' '}
              <code>{'{branch}'}</code> → <code>prod</code> sur la branche prod,{' '}
              <code>{'{branch}-latest'}</code> → <code>prod-latest</code>. Un tag fixe (
              <code>stable</code>) vaut pour toutes les branches.
            </p>
          </div>
        )}
      </fieldset>

      <fieldset className="space-y-2" disabled={!canEdit}>
        <legend className="text-sm font-medium">Versions proposées</legend>
        <Choice
          name={`versions-${source.id}`}
          checked={convention.versionSource === 'git_tags'}
          onSelect={() => set({ versionSource: 'git_tags' })}
          label="Tags Git de version (l’image porte le même nom que le tag)"
        />
        {convention.versionSource === 'git_tags' && (
          <div className="space-y-1 pl-6">
            <Label htmlFor={`pattern-${source.id}`} className="text-xs font-normal">
              Format des tags (expression régulière)
            </Label>
            <Input
              id={`pattern-${source.id}`}
              className="font-mono text-sm"
              value={convention.tagPattern}
              onChange={(event) => set({ tagPattern: event.target.value })}
            />
          </div>
        )}
        <Choice
          name={`versions-${source.id}`}
          checked={convention.versionSource === 'commits'}
          onSelect={() => set({ versionSource: 'commits' })}
          label="Derniers commits de la branche (une image par commit)"
        />
        {convention.versionSource === 'commits' && (
          <div className="space-y-1 pl-6">
            <Label htmlFor={`commit-${source.id}`} className="text-xs font-normal">
              Tag de l’image d’un commit
            </Label>
            <Input
              id={`commit-${source.id}`}
              className="font-mono text-sm"
              value={convention.commitTagTemplate}
              onChange={(event) => set({ commitTagTemplate: event.target.value })}
            />
            <p className="text-muted-foreground text-xs">
              <code>{'{sha:8}'}</code> : 8 premiers caractères du commit (comme{' '}
              <code>$CI_COMMIT_SHORT_SHA</code> sur GitLab) ; <code>{'{sha}'}</code> : SHA complet.
            </p>
          </div>
        )}
      </fieldset>

      <div className="bg-muted/40 text-muted-foreground rounded-md p-2 text-xs">
        Aperçu : dernier build de <code>{source.defaultBranch}</code> →{' '}
        <code className="text-foreground">{preview(source.defaultBranch) || '…'}</code>
        {source.defaultBranch !== 'develop' && (
          <>
            , de <code>develop</code> →{' '}
            <code className="text-foreground">{preview('develop') || '…'}</code>
          </>
        )}
        {convention.versionSource === 'commits' && (
          <>
            {' '}
            ; commit d4f6105… →{' '}
            <code className="text-foreground">
              {commitImageTag(convention.commitTagTemplate, EXAMPLE_SHA)}
            </code>
          </>
        )}
      </div>

      {canEdit && (
        <div className="flex items-center justify-end gap-3">
          {error && <p className="text-destructive text-xs">{error}</p>}
          <Button
            size="sm"
            onClick={() => save.mutate()}
            disabled={!changed || Boolean(error) || save.isPending}
          >
            {save.isPending && <Loader2 className="animate-spin" />}
            Enregistrer la convention
          </Button>
        </div>
      )}
    </div>
  )
}

function Choice({
  name,
  checked,
  onSelect,
  label,
}: {
  name: string
  checked: boolean
  onSelect: () => void
  label: React.ReactNode
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-sm">
      <input
        type="radio"
        name={name}
        className={cn('accent-primary mt-1')}
        checked={checked}
        onChange={onSelect}
      />
      <span>{label}</span>
    </label>
  )
}
