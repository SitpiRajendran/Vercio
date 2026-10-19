import { useEffect, useState } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ExternalLink, FileCode2, Loader2, Palette, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { ComposeAnalysis, ProjectView } from '@vercio/shared'
import { DependencyWarning, useSharedNetworks } from '@/components/networks/dependencies'
import { AppearanceDialog } from '@/components/projects/appearance-dialog'
import { CodeToImageFlow } from '@/components/projects/code-to-image-flow'
import { ProjectAvatar } from '@/components/projects/project-avatar'
import { ZeroDowntimeCard } from '@/components/projects/zero-downtime-card'
import { ComposeAnalysisView } from '@/components/projects/compose-analysis'
import { ImportFileButton } from '@/components/projects/import-file-button'
import {
  autoMapServices,
  mappingError,
  ServicesMapping,
  type ServiceDraft,
  type SourceDraft,
} from '@/components/projects/services-mapping'
import { TagConventionEditor } from '@/components/projects/tag-convention-editor'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api, type CatalogRegistry } from '@/lib/api'
import { useDebounced } from '@/lib/use-debounced'
import { cn } from '@/lib/utils'
import { useProjectCompose } from '@/lib/project-compose'
import { EnvironmentsTab } from './environments-tab'
import { projectToInput } from './to-input'
import { WebhooksTab } from './webhooks-tab'

interface Permissions {
  canDeploy: boolean
  isAdmin: boolean
}

const SECTIONS = [
  { id: 'apparence', label: 'Apparence et adresse' },
  { id: 'environnements', label: 'Environnements' },
  { id: 'code', label: 'Code et images' },
  { id: 'sans-coupure', label: 'Mise à jour sans coupure' },
  { id: 'webhooks', label: 'Webhooks' },
  { id: 'general', label: 'Général et suppression' },
] as const

/** Réglages du projet, rarement modifiés : regroupés sur un seul onglet. */
export function SettingsTab({
  project,
  envId,
  can,
}: {
  project: ProjectView
  envId: string
  can: Permissions
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[11rem_minmax(0,1fr)]">
      <SectionNav />
      <div className="min-w-0 space-y-10">
        <section
          id="apparence"
          className="scroll-mt-[calc(var(--sticky-tabs-height,0px)+4rem)] space-y-3 lg:scroll-mt-[calc(var(--sticky-tabs-height,0px)+1rem)]"
        >
          <SectionTitle
            title="Apparence et adresse"
            description="Icône et couleur (ou image) du projet dans les listes, et adresse du site pour l’ouvrir d’un clic."
          />
          <AppearanceSection project={project} canEdit={can.isAdmin} />
        </section>
        <section
          id="environnements"
          className="scroll-mt-[calc(var(--sticky-tabs-height,0px)+4rem)] space-y-3 lg:scroll-mt-[calc(var(--sticky-tabs-height,0px)+1rem)]"
        >
          <SectionTitle
            title="Environnements"
            description="Production, recette… Chacun a sa branche, sa version et ses variables. La plupart des projets n’en ont qu’un."
          />
          <EnvironmentsTab project={project} can={can} />
        </section>
        <section
          id="code"
          className="scroll-mt-[calc(var(--sticky-tabs-height,0px)+4rem)] space-y-3 lg:scroll-mt-[calc(var(--sticky-tabs-height,0px)+1rem)]"
        >
          <SectionTitle
            title="Code et images"
            description="D’où viennent les images déployées : fixes dans le fichier Compose, ou construites par la CI de votre dépôt."
          />
          <CodeToImageFlow />
          <ServicesTab project={project} canEdit={can.isAdmin} />
        </section>
        <section
          id="sans-coupure"
          className="scroll-mt-[calc(var(--sticky-tabs-height,0px)+4rem)] space-y-3 lg:scroll-mt-[calc(var(--sticky-tabs-height,0px)+1rem)]"
        >
          <SectionTitle
            title="Mise à jour sans coupure"
            description="Pour un site ou une API sans état : la nouvelle version démarre à côté de l’ancienne, qui ne s’arrête qu’une fois la nouvelle prête. Les autres services sont remplacés (courte coupure). Le premier déploiement après activation coupe encore quelques secondes, le temps de mettre le relais en place."
          />
          <ZeroDowntimeCard project={project} canEdit={can.isAdmin} />
        </section>
        <section
          id="webhooks"
          className="scroll-mt-[calc(var(--sticky-tabs-height,0px)+4rem)] space-y-3 lg:scroll-mt-[calc(var(--sticky-tabs-height,0px)+1rem)]"
        >
          <SectionTitle
            title="Webhooks"
            description="Déployer automatiquement après un push : adresse à donner à GitLab, GitHub ou votre CI."
          />
          <WebhooksTab project={project} can={can} envId={envId} />
        </section>
        <section
          id="general"
          className="scroll-mt-[calc(var(--sticky-tabs-height,0px)+4rem)] space-y-3 lg:scroll-mt-[calc(var(--sticky-tabs-height,0px)+1rem)]"
        >
          <SectionTitle title="Général et suppression" />
          <ConfigurationTab project={project} canEdit={can.isAdmin} />
        </section>
      </div>
    </div>
  )
}

/**
 * Menu des sections, toujours visible : colonne collante sur grand écran, barre collante en
 * haut sur petit écran. La section affichée est mise en évidence.
 */
function SectionNav() {
  const [active, setActive] = useState<string>(SECTIONS[0].id)
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (visible) setActive(visible.target.id)
      },
      { rootMargin: '0px 0px -60% 0px' },
    )
    for (const section of SECTIONS) {
      const element = document.getElementById(section.id)
      if (element) observer.observe(element)
    }
    return () => observer.disconnect()
  }, [])
  return (
    <nav
      aria-label="Sections"
      className="bg-background sticky top-(--sticky-tabs-height,0px) z-10 -mx-4 min-w-0 border-b px-4 py-2 md:-mx-6 md:px-6 lg:top-[calc(var(--sticky-tabs-height,0px)+1rem)] lg:mx-0 lg:self-start lg:border-0 lg:p-0"
    >
      <ul className="flex gap-1 overflow-x-auto text-sm lg:flex-col">
        {SECTIONS.map((section) => (
          <li key={section.id} className="shrink-0">
            <button
              type="button"
              aria-current={active === section.id ? 'true' : undefined}
              onClick={() => {
                setActive(section.id)
                document
                  .getElementById(section.id)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }}
              className={cn(
                'block w-full rounded px-2 py-1 text-left whitespace-nowrap',
                active === section.id
                  ? 'bg-accent text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {section.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}

function AppearanceSection({ project, canEdit }: { project: ProjectView; canEdit: boolean }) {
  const [editing, setEditing] = useState(false)
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border p-4">
      <ProjectAvatar project={project} size="lg" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-medium">{project.name}</p>
        {project.url ? (
          <a
            href={project.url}
            target="_blank"
            rel="noreferrer"
            className="text-primary inline-flex items-center gap-1 break-all underline-offset-4 hover:underline"
          >
            {project.url}
            <ExternalLink className="size-3 shrink-0" />
          </a>
        ) : (
          <p className="text-muted-foreground">Aucune adresse de site.</p>
        )}
      </div>
      {canEdit && (
        <Button variant="outline" onClick={() => setEditing(true)}>
          <Palette />
          Modifier l’icône, la couleur ou l’adresse
        </Button>
      )}
      {editing && <AppearanceDialog project={project} onClose={() => setEditing(false)} />}
    </div>
  )
}

function SectionTitle({ title, description }: { title: string; description?: string }) {
  return (
    <div>
      <h2 className="text-base font-semibold">{title}</h2>
      {description && <p className="text-muted-foreground text-sm">{description}</p>}
    </div>
  )
}

function toSourceDrafts(project: ProjectView): SourceDraft[] {
  return project.sources.map((source) => ({
    key: source.id,
    name: source.name,
    gitProviderId: source.gitProviderId,
    repository: source.repository,
    defaultBranch: source.defaultBranch,
  }))
}

function ServicesTab({ project, canEdit }: { project: ProjectView; canEdit: boolean }) {
  const compose = useProjectCompose(project)
  const registries = useQuery({
    queryKey: ['catalog', 'registries'],
    queryFn: api.catalog.registries,
  })

  if (compose.isPending || registries.isPending) return <Skeleton className="h-40 w-full" />
  if (compose.error) return <p className="text-destructive text-sm">{compose.error.message}</p>
  if (compose.data.analysis.error) return <ComposeAnalysisView analysis={compose.data.analysis} />
  return (
    <ServicesEditor
      key={`${compose.dataUpdatedAt}-${project.updatedAt}`}
      project={project}
      analysis={compose.data.analysis}
      registries={registries.data ?? []}
      canEdit={canEdit}
    />
  )
}

function ServicesEditor({
  project,
  analysis,
  registries,
  canEdit,
}: {
  project: ProjectView
  analysis: ComposeAnalysis
  registries: CatalogRegistry[]
  canEdit: boolean
}) {
  const queryClient = useQueryClient()
  const sources = toSourceDrafts(project)
  // Services suivis enregistrés ; les autres restent figés (non suivis).
  const [services, setServices] = useState<ServiceDraft[]>(() =>
    analysis.services.map((service) => {
      const saved = project.trackedServices.find((item) => item.serviceName === service.name)
      if (saved) {
        return {
          serviceName: service.name,
          image: service.image,
          tracked: true,
          sourceKey: saved.appSourceId,
          registryId: saved.registryId,
          imageRepository: saved.imageRepository,
        }
      }
      return { ...autoMapServices([service], registries, sources)[0]!, tracked: false }
    }),
  )
  const images = useQueries({
    queries: sources.map((source) => ({
      queryKey: ['catalog', 'images', source.gitProviderId, source.repository],
      queryFn: () => api.catalog.images(source.gitProviderId, source.repository),
      staleTime: 60_000,
    })),
  })

  const save = useMutation({
    mutationFn: () =>
      api.projects.update(
        project.id,
        projectToInput(project, {
          trackedServices: services
            .filter((service) => service.tracked)
            .map(({ serviceName, sourceKey, registryId, imageRepository }) => ({
              serviceName,
              sourceKey,
              registryId,
              imageRepository,
            })),
        }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(['projects', project.slug], updated)
      toast.success('Services enregistrés')
    },
    onError: (error) => toast.error(error.message),
  })

  const error = mappingError(services, sources)
  return (
    <div className="space-y-4">
      <ComposeAnalysisView analysis={analysis} />
      <ServicesMapping
        services={services}
        onChange={canEdit ? setServices : () => {}}
        sources={sources}
        registries={registries}
        imageSuggestions={images.flatMap((query) => query.data?.map((image) => image.path) ?? [])}
      />
      {canEdit && (
        <div className="flex items-center justify-end gap-3">
          {error && <p className="text-muted-foreground text-xs">{error}</p>}
          <Button onClick={() => save.mutate()} disabled={Boolean(error) || save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            Enregistrer les services
          </Button>
        </div>
      )}
    </div>
  )
}

function ConfigurationTab({ project, canEdit }: { project: ProjectView; canEdit: boolean }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')
  const [content, setContent] = useState(
    project.compose.source === 'inline' ? project.compose.content : '',
  )
  const [path, setPath] = useState(project.compose.source === 'git' ? project.compose.path : '')
  const [confirming, setConfirming] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const debounced = useDebounced(content, 400)
  const analysis = useQuery({
    queryKey: ['compose-analysis', debounced],
    queryFn: () => api.catalog.analyze(debounced),
    enabled: project.compose.source === 'inline',
  })

  const save = useMutation({
    mutationFn: () =>
      api.projects.update(
        project.id,
        projectToInput(project, {
          name,
          description: description || undefined,
          compose:
            project.compose.source === 'inline'
              ? { source: 'inline', content }
              : { source: 'git', sourceKey: project.compose.appSourceId, path },
        }),
      ),
    onSuccess: (updated) => {
      queryClient.setQueryData(['projects', project.slug], updated)
      void queryClient.invalidateQueries({ queryKey: ['projects'], exact: true })
      toast.success('Configuration enregistrée')
    },
    onError: (error) => toast.error(error.message),
  })

  const networks = useSharedNetworks()
  const remove = useMutation({
    mutationFn: () => api.projects.remove(project.id),
    onSuccess: async () => {
      toast.success(`Projet « ${project.name} » supprimé`)
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      await queryClient.invalidateQueries({ queryKey: ['networks'] })
      await navigate({ to: '/projets' })
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Général</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="cfg-name">Nom</Label>
            <Input
              id="cfg-name"
              value={name}
              disabled={!canEdit}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cfg-slug">Identifiant</Label>
            <Input id="cfg-slug" value={project.slug} disabled className="font-mono text-sm" />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="cfg-description">Description</Label>
            <Input
              id="cfg-description"
              value={description}
              disabled={!canEdit}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileCode2 className="size-4" />
            Fichier Compose
          </CardTitle>
          <CardDescription>
            {project.compose.source === 'git'
              ? 'Lu dans le dépôt à chaque déploiement, sur la branche de l’environnement.'
              : 'Saisi dans Vercio.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {project.compose.source === 'git' ? (
            <div className="space-y-1.5">
              <Label htmlFor="cfg-path">Chemin dans le dépôt</Label>
              <Input
                id="cfg-path"
                className="font-mono text-sm"
                value={path}
                disabled={!canEdit}
                onChange={(e) => setPath(e.target.value)}
              />
            </div>
          ) : (
            <>
              {canEdit && (
                <div className="flex justify-end">
                  <ImportFileButton onImport={(imported) => setContent(imported)} />
                </div>
              )}
              <Textarea
                aria-label="Contenu du fichier Compose"
                rows={14}
                spellCheck={false}
                className="font-mono text-xs"
                value={content}
                disabled={!canEdit}
                onChange={(e) => setContent(e.target.value)}
              />
              {analysis.data && <ComposeAnalysisView analysis={analysis.data} />}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Dépôts de code</CardTitle>
          <CardDescription>
            Dépôts dont la CI construit les images suivies, et la façon dont elle nomme ces images
            (convention de tags).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {project.sources.length === 0 && (
            <p className="text-muted-foreground text-sm">Aucun dépôt : les images sont fixes.</p>
          )}
          {project.sources.map((source) => (
            <TagConventionEditor
              key={`${source.id}-${project.updatedAt}`}
              project={project}
              source={source}
              canEdit={canEdit}
            />
          ))}
        </CardContent>
      </Card>

      {canEdit && (
        <div className="flex flex-wrap justify-between gap-2">
          <Button
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirming(true)}
          >
            <Trash2 />
            Supprimer le projet
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={
              save.isPending || Boolean(analysis.data?.error && project.compose.source === 'inline')
            }
          >
            {save.isPending && <Loader2 className="animate-spin" />}
            Enregistrer la configuration
          </Button>
        </div>
      )}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer « {project.name} » ?</DialogTitle>
            <DialogDescription>
              Ses environnements et variables seront supprimés. Tapez{' '}
              <code className="font-mono">{project.slug}</code> pour confirmer.
            </DialogDescription>
          </DialogHeader>
          <DependencyWarning
            networks={networks.data}
            environmentIds={project.environments.map((env) => env.id)}
            action="la suppression (avec les réseaux partagés qu’il expose)"
          />
          <Input
            aria-label="Confirmation"
            className="font-mono"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Annuler
            </Button>
            <Button
              variant="destructive"
              disabled={confirmation !== project.slug || remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending && <Loader2 className="animate-spin" />}
              Supprimer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
