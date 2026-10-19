import { useMemo, useState } from 'react'
import { useMutation, useQueries, useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  ArrowLeft,
  ArrowRight,
  Boxes,
  FileCode2,
  FolderGit2,
  FolderInput,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react'
import { slugify, type ExternalComposeProject } from '@vercio/shared'
import { PageHeader } from '@/components/layout/app-layout'
import { BranchSelect } from '@/components/projects/branch-select'
import { CodeToImageFlow } from '@/components/projects/code-to-image-flow'
import { ComposeAnalysisView } from '@/components/projects/compose-analysis'
import { ImportFileButton } from '@/components/projects/import-file-button'
import { ImportPicker } from '@/components/projects/import-picker'
import { RepositoryPicker, type PickedRepository } from '@/components/projects/repository-picker'
import {
  autoMapServices,
  mappingError,
  ServicesMapping,
  type ServiceDraft,
  type SourceDraft,
} from '@/components/projects/services-mapping'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { api, ApiError } from '@/lib/api'
import { useDebounced } from '@/lib/use-debounced'
import { cn } from '@/lib/utils'

type Kind = 'compose' | 'single' | 'import'
type ComposeMode = 'git' | 'inline'

interface EnvironmentDraft {
  key: number
  name: string
  slug: string
  /** Branche par source (clé de la source → branche). */
  branches: Record<string, string>
}

const STEPS = ['Type', 'Fichier Compose', 'Services', 'Environnements'] as const

const EXAMPLE_COMPOSE = `services:
  front:
    image: registry.gitlab.com/groupe/site/front:latest
    ports: ["8080:80"]
  back:
    image: registry.gitlab.com/groupe/site/back:latest
  redis:
    image: redis:7
`

/** Génère le Compose d'un service seul (ex. une base de données mutualisée). */
function singleServiceCompose(name: string, image: string, port: string, dataPath: string) {
  const lines = [`services:`, `  ${name}:`, `    image: ${image}`, `    restart: unless-stopped`]
  if (port) lines.push(`    ports: ["${port}"]`)
  if (dataPath) lines.push(`    volumes:`, `      - ${name}-data:${dataPath}`)
  if (dataPath) lines.push(`volumes:`, `  ${name}-data: {}`)
  return `${lines.join('\n')}\n`
}

let envKey = 0

export function NewProjectPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState(0)
  const [kind, setKind] = useState<Kind>('compose')
  const [mode, setMode] = useState<ComposeMode>('git')
  // Reprise d'un projet lancé hors de Vercio
  const [imported, setImported] = useState<ExternalComposeProject | null>(null)
  const [importVariables, setImportVariables] = useState(true)

  // Étape 2 : fichier Compose
  const [picked, setPicked] = useState<PickedRepository | null>(null)
  /** Fichier choisi dans la liste ; null : le fichier Compose standard détecté dans le dépôt. */
  const [chosenPath, setChosenPath] = useState<string | null>(null)
  const [manualPath, setManualPath] = useState('')
  const [inline, setInline] = useState(EXAMPLE_COMPOSE)
  const [single, setSingle] = useState({
    image: 'postgres:17',
    name: 'postgres',
    port: '',
    dataPath: '/var/lib/postgresql/data',
  })

  // Étape 3 : sources et services
  const [extraSources, setExtraSources] = useState<SourceDraft[]>([])
  const [services, setServices] = useState<ServiceDraft[]>([])
  const [addingSource, setAddingSource] = useState(false)

  // Étape 4 : projet et environnements
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [environments, setEnvironments] = useState<EnvironmentDraft[]>([])

  const registries = useQuery({
    queryKey: ['catalog', 'registries'],
    queryFn: api.catalog.registries,
    // Un registry ajouté dans un autre onglet apparaît au retour sur l'assistant.
    refetchOnWindowFocus: true,
  })

  const inlineContent =
    kind === 'single'
      ? singleServiceCompose(single.name || 'service', single.image, single.port, single.dataPath)
      : inline
  const debouncedInline = useDebounced(inlineContent, 400)
  const inlineAnalysis = useQuery({
    queryKey: ['compose-analysis', debouncedInline],
    queryFn: () => api.catalog.analyze(debouncedInline),
    enabled: kind === 'single' || mode === 'inline',
  })

  const ref = picked?.repository.defaultBranch ?? 'main'
  const composeFiles = useQuery({
    queryKey: ['catalog', 'compose-files', picked?.gitProviderId, picked?.repository.fullName, ref],
    queryFn: () =>
      api.catalog.composeFiles(picked!.gitProviderId, picked!.repository.fullName, ref),
    enabled: Boolean(picked),
  })
  const path = chosenPath ?? composeFiles.data?.detected ?? null
  const composeFile = useQuery({
    queryKey: ['catalog', 'compose', picked?.gitProviderId, picked?.repository.fullName, ref, path],
    queryFn: () =>
      api.catalog.composeFromGit(picked!.gitProviderId, {
        repository: picked!.repository.fullName,
        ref,
        path: path!,
      }),
    enabled: Boolean(picked && path),
    retry: false,
  })
  const gitFile = composeFile.data ?? null

  const usesGit = kind !== 'single' && mode === 'git'
  const analysis = usesGit ? gitFile?.analysis : inlineAnalysis.data
  const composeSource: SourceDraft | null =
    usesGit && picked
      ? {
          key: 'compose',
          name: picked.repository.name,
          gitProviderId: picked.gitProviderId,
          repository: picked.repository.fullName,
          defaultBranch: picked.repository.defaultBranch ?? 'main',
        }
      : null
  const sources = useMemo(
    () => (composeSource ? [composeSource, ...extraSources] : extraSources),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [composeSource?.repository, composeSource?.gitProviderId, extraSources],
  )

  // Suggestions d'images : registry GitLab ou GHCR des dépôts choisis.
  const imageQueries = useQueries({
    queries: sources.map((source) => ({
      queryKey: ['catalog', 'images', source.gitProviderId, source.repository],
      queryFn: () => api.catalog.images(source.gitProviderId, source.repository),
      staleTime: 60_000,
    })),
  })
  const imageSuggestions = imageQueries.flatMap(
    (query) => query.data?.map((image) => image.path) ?? [],
  )

  /** Passage d'étape : prépare les valeurs par défaut de l'étape suivante. */
  function goTo(next: number) {
    if (next === 2 && analysis && !analysis.error && registries.data) {
      // Propose un suivi pour les images venant des registries configurés.
      setServices((previous) =>
        autoMapServices(analysis.services, registries.data, sources, previous),
      )
    }
    if (next === 3) {
      if (!name) {
        const suggested =
          kind === 'single'
            ? single.name
            : kind === 'import' && imported
              ? imported.name
              : (picked?.repository.name ?? 'Mon projet')
        const readable = suggested.replace(/[-_.]+/g, ' ').trim()
        setName(readable.charAt(0).toUpperCase() + readable.slice(1))
      }
      setEnvironments((current) => {
        const withBranches = (env: EnvironmentDraft) => ({
          ...env,
          branches: Object.fromEntries(
            sources.map((source) => [source.key, env.branches[source.key] ?? source.defaultBranch]),
          ),
        })
        if (current.length) return current.map(withBranches)
        return [withBranches({ key: envKey++, name: 'Production', slug: 'prod', branches: {} })]
      })
    }
    setStep(next)
  }

  const effectiveSlug = slugTouched ? slug : slugify(name)
  const usedSources = sources.filter(
    (source) =>
      source.key === 'compose' || services.some((s) => s.tracked && s.sourceKey === source.key),
  )

  const importedVariables =
    kind === 'import' && importVariables && imported?.env && 'variables' in imported.env
      ? imported.env.variables
      : []

  const create = useMutation({
    mutationFn: async () => {
      const project = await api.projects.create({
        name,
        slug: effectiveSlug,
        description: description || undefined,
        type: kind === 'single' ? 'single' : 'compose',
        compose: usesGit
          ? { source: 'git', sourceKey: 'compose', path: path ?? '' }
          : { source: 'inline', content: inlineContent },
        sources: usedSources,
        trackedServices: services
          .filter((service) => service.tracked)
          .map(({ serviceName, sourceKey, registryId, imageRepository }) => ({
            serviceName,
            sourceKey,
            registryId,
            imageRepository,
          })),
        environments: environments.map((env, index) => ({
          name: env.name,
          slug: env.slug,
          sources: usedSources.map((source) => ({
            source: source.key,
            branch: env.branches[source.key] ?? source.defaultBranch,
          })),
          // Le premier environnement reprend le projet d'origine (volumes, conteneurs).
          ...(kind === 'import' && imported && index === 0
            ? {
                migration: {
                  composeProject: imported.name,
                  volumes: Object.fromEntries(
                    imported.volumes.map((volume) => [volume.key, volume.name]),
                  ),
                },
              }
            : {}),
        })),
      })
      if (importedVariables.length) {
        await api.projects.saveVariables(project.id, undefined, {
          variables: importedVariables.map(({ key, value, secret }) => ({ key, value, secret })),
        })
      }
      return project
    },
    onSuccess: (project) => navigate({ to: '/projets/$slug', params: { slug: project.slug } }),
  })

  const canContinue = [
    true,
    // L'analyse doit porter sur le contenu actuel (elle suit la saisie avec un léger délai).
    Boolean(
      analysis &&
      !analysis.error &&
      (kind !== 'import' || imported) &&
      (usesGit || (debouncedInline === inlineContent && !inlineAnalysis.isFetching)),
    ),
    !mappingError(services, sources),
    Boolean(
      name &&
      effectiveSlug &&
      environments.length &&
      environments.every((env) => env.name && env.slug),
    ),
  ][step]

  return (
    <>
      <PageHeader
        title="Nouveau projet"
        description="Un site, une API ou un service, et ses environnements"
      />
      <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-6">
        <ol className="flex flex-wrap gap-2" aria-label="Étapes">
          {STEPS.map((label, index) => (
            <li
              key={label}
              aria-current={index === step ? 'step' : undefined}
              className={cn(
                'flex items-center gap-2 rounded-full border px-3 py-1 text-sm',
                index === step && 'bg-primary text-primary-foreground border-primary',
                index < step && 'text-muted-foreground',
              )}
            >
              <span className="font-mono text-xs">{index + 1}</span>
              {label}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <div className="grid gap-4 sm:grid-cols-3">
            <KindCard
              selected={kind === 'compose'}
              onSelect={() => setKind('compose')}
              icon={<FolderGit2 />}
              title="Projet Compose"
              description="Un site ou une application à plusieurs services (front, back, redis…), décrits par un fichier docker-compose."
            />
            <KindCard
              selected={kind === 'single'}
              onSelect={() => setKind('single')}
              icon={<Boxes />}
              title="Service seul"
              description="Une seule image, par exemple une base de données PostgreSQL partagée par plusieurs projets."
            />
            <KindCard
              selected={kind === 'import'}
              onSelect={() => setKind('import')}
              icon={<FolderInput />}
              title="Projet existant"
              description="Un projet lancé à la main avec docker compose sur cet hôte : Vercio le reprend, ses volumes et ses variables compris."
            />
          </div>
        )}

        {step === 1 && kind === 'import' && (
          <Card>
            <CardHeader>
              <CardTitle>Projet existant</CardTitle>
              <CardDescription>
                Projets Compose lancés hors de Vercio sur cet hôte. Le fichier Compose lu dans leur
                dossier est repris ci-dessous ; vous pouvez aussi le lire depuis son dépôt Git.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ImportPicker
                value={imported}
                importVariables={importVariables}
                onImportVariablesChange={setImportVariables}
                onChange={(project) => {
                  setImported(project)
                  setName('')
                  if ('content' in project.compose) {
                    setMode('inline')
                    setInline(project.compose.content)
                  }
                }}
              />
              {imported && 'error' in imported.compose && (
                <p className="text-warning mt-3 text-sm">
                  {imported.compose.path ?? 'Fichier Compose'} : {imported.compose.error}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {step === 1 && kind !== 'single' && (kind !== 'import' || imported) && (
          <Card>
            <CardHeader>
              <CardTitle>Fichier Compose</CardTitle>
              <CardDescription>
                Lu dans un dépôt (relu à chaque déploiement, sur la branche de l’environnement) ou
                saisi directement.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs value={mode} onValueChange={(value) => setMode(value as ComposeMode)}>
                <TabsList>
                  <TabsTrigger value="git">Depuis un dépôt</TabsTrigger>
                  <TabsTrigger value="inline">Saisir le fichier</TabsTrigger>
                </TabsList>
                <TabsContent value="git" className="space-y-4 pt-4">
                  <RepositoryPicker
                    value={picked}
                    onChange={(value) => {
                      setPicked(value)
                      setChosenPath(null)
                    }}
                  />
                  {picked && composeFiles.isPending && (
                    <p className="text-muted-foreground flex items-center gap-2 text-sm">
                      <Loader2 className="size-4 animate-spin" />
                      Recherche des fichiers Compose du dépôt…
                    </p>
                  )}
                  {picked && composeFiles.data && (
                    <div className="space-y-1.5">
                      <Label htmlFor="compose-path">Fichier Compose</Label>
                      {composeFiles.data.files.length === 0 ? (
                        <p className="text-warning text-sm">
                          Aucun fichier YAML sur la branche {ref} de ce dépôt.
                        </p>
                      ) : (
                        <>
                          {!composeFiles.data.detected && (
                            <p className="text-muted-foreground text-sm">
                              Pas de docker-compose.yml ni de compose.yaml à la racine : choisissez
                              le fichier parmi les {composeFiles.data.files.length} fichiers YAML du
                              dépôt.
                            </p>
                          )}
                          <Select value={path ?? ''} onValueChange={setChosenPath}>
                            <SelectTrigger id="compose-path" className="w-full font-mono text-sm">
                              <SelectValue placeholder="Choisissez un fichier…" />
                            </SelectTrigger>
                            <SelectContent>
                              {composeFiles.data.files.map((file) => (
                                <SelectItem key={file} value={file} className="font-mono text-sm">
                                  {file}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </>
                      )}
                    </div>
                  )}
                  {picked && composeFiles.error && (
                    // Arborescence illisible (droits du token…) : saisie du chemin à la main.
                    <div className="space-y-2">
                      <p role="alert" className="text-destructive text-sm">
                        Liste des fichiers indisponible : {composeFiles.error.message}
                      </p>
                      <div className="flex flex-wrap items-end gap-3">
                        <div className="min-w-0 flex-1 space-y-1.5">
                          <Label htmlFor="compose-manual-path">Chemin du fichier</Label>
                          <Input
                            id="compose-manual-path"
                            className="font-mono text-sm"
                            placeholder="docker-compose.yml"
                            value={manualPath}
                            onChange={(event) => setManualPath(event.target.value)}
                          />
                        </div>
                        <Button
                          variant="secondary"
                          onClick={() => setChosenPath(manualPath.trim())}
                          disabled={!manualPath.trim()}
                        >
                          <FileCode2 />
                          Lire le fichier
                        </Button>
                      </div>
                    </div>
                  )}
                  {composeFile.isFetching && (
                    <p className="text-muted-foreground flex items-center gap-2 text-sm">
                      <Loader2 className="size-4 animate-spin" />
                      Lecture de {path}…
                    </p>
                  )}
                  {composeFile.error && (
                    <p role="alert" className="text-destructive text-sm">
                      {composeFile.error.message}
                    </p>
                  )}
                  {gitFile && (
                    <>
                      <ComposeAnalysisView analysis={gitFile.analysis} />
                      <pre className="bg-muted max-h-64 overflow-auto rounded-lg p-3 font-mono text-xs">
                        {gitFile.content}
                      </pre>
                    </>
                  )}
                </TabsContent>
                <TabsContent value="inline" className="space-y-4 pt-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-muted-foreground text-sm">
                      Collez le contenu, ou importez un fichier de votre ordinateur.
                    </p>
                    <ImportFileButton onImport={(content) => setInline(content)} />
                  </div>
                  <Textarea
                    aria-label="Contenu du fichier Compose"
                    rows={14}
                    spellCheck={false}
                    className="font-mono text-xs"
                    value={inline}
                    onChange={(event) => setInline(event.target.value)}
                  />
                  {inlineAnalysis.data && <ComposeAnalysisView analysis={inlineAnalysis.data} />}
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        )}

        {step === 1 && kind === 'single' && (
          <Card>
            <CardHeader>
              <CardTitle>Service</CardTitle>
              <CardDescription>
                Vercio génère le fichier Compose ; vous pourrez l’ajuster ensuite.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <SingleField
                  label="Image"
                  id="single-image"
                  value={single.image}
                  placeholder="postgres:17"
                  onChange={(image) =>
                    setSingle((s) => ({
                      ...s,
                      image,
                      name: s.name || slugify(image.split(/[:/]/).at(-2) ?? image),
                    }))
                  }
                />
                <SingleField
                  label="Nom du service"
                  id="single-name"
                  value={single.name}
                  onChange={(value) => setSingle((s) => ({ ...s, name: slugify(value) }))}
                />
                <SingleField
                  label="Port publié (facultatif)"
                  id="single-port"
                  value={single.port}
                  placeholder="127.0.0.1:5432:5432"
                  onChange={(port) => setSingle((s) => ({ ...s, port }))}
                />
                <SingleField
                  label="Données persistantes (facultatif)"
                  id="single-data"
                  value={single.dataPath}
                  placeholder="/var/lib/postgresql/data"
                  onChange={(dataPath) => setSingle((s) => ({ ...s, dataPath }))}
                />
              </div>
              <pre className="bg-muted overflow-auto rounded-lg p-3 font-mono text-xs">
                {inlineContent}
              </pre>
              {inlineAnalysis.data && <ComposeAnalysisView analysis={inlineAnalysis.data} />}
            </CardContent>
          </Card>
        )}

        {step === 2 && (
          <Card>
            <CardHeader>
              <CardTitle>Services</CardTitle>
              <CardDescription>
                Pour chaque service : « Version fixe » garde l’image écrite dans le fichier (redis,
                postgres…) ; « Suivre la CI » déploie les images que votre CI construit à chaque
                push, et vous laisse choisir la version (dernier build ou un tag).
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <CodeToImageFlow />
              <ServicesMapping
                services={services}
                onChange={setServices}
                sources={sources}
                registries={registries.data ?? []}
                imageSuggestions={imageSuggestions}
              />
              {services.some((service) => service.tracked) &&
                sources.length === 0 &&
                !addingSource && (
                  <p className="text-warning text-sm">
                    Ajoutez le dépôt Git dont la CI construit ces images.
                  </p>
                )}
              {addingSource ? (
                <div className="space-y-2 rounded-lg border p-3">
                  <p className="text-sm font-medium">Ajouter un autre dépôt Git</p>
                  <p className="text-muted-foreground text-xs">
                    Seulement si une image est construite par la CI d’un autre dépôt que celui du
                    fichier Compose (ex. le front et le back dans deux dépôts séparés).
                  </p>
                  <RepositoryPicker
                    value={null}
                    onChange={({ gitProviderId, repository }) => {
                      const key = `src-${extraSources.length + 1}`
                      const source: SourceDraft = {
                        key,
                        name: repository.name,
                        gitProviderId,
                        repository: repository.fullName,
                        defaultBranch: repository.defaultBranch ?? 'main',
                      }
                      setExtraSources((current) => [...current, source])
                      // Rattache au nouveau dépôt les services suivis qui n'en ont pas.
                      setServices((current) =>
                        current.map((service) =>
                          service.tracked && !sources.some((s) => s.key === service.sourceKey)
                            ? { ...service, sourceKey: key }
                            : service,
                        ),
                      )
                      setAddingSource(false)
                    }}
                  />
                  <Button variant="ghost" size="sm" onClick={() => setAddingSource(false)}>
                    Annuler
                  </Button>
                </div>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => setAddingSource(true)}>
                  <Plus />
                  Ajouter un autre dépôt Git
                </Button>
              )}
              {mappingError(services, sources) && (
                <p className="text-muted-foreground text-xs">{mappingError(services, sources)}</p>
              )}
            </CardContent>
          </Card>
        )}

        {step === 3 && (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Projet</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="project-name">Nom</Label>
                  <Input
                    id="project-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="project-slug">Identifiant</Label>
                  <Input
                    id="project-slug"
                    className="font-mono text-sm"
                    value={effectiveSlug}
                    onChange={(event) => {
                      setSlugTouched(true)
                      setSlug(slugify(event.target.value))
                    }}
                  />
                  <p className="text-muted-foreground text-xs">
                    Utilisé dans les noms Docker ; il ne pourra plus être modifié.
                  </p>
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="project-description">Description (facultatif)</Label>
                  <Input
                    id="project-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Environnements</CardTitle>
                <CardDescription>
                  Chaque environnement est déployé séparément, avec sa propre branche et ses
                  variables. Tous suivent <code>latest</code> au départ ; vous choisirez un tag
                  précis ou le verrouillerez ensuite.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {environments.map((env) => (
                  <div
                    key={env.key}
                    className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_auto]"
                  >
                    <div className="space-y-1">
                      <Label
                        className="text-muted-foreground text-xs"
                        htmlFor={`env-name-${env.key}`}
                      >
                        Nom
                      </Label>
                      <Input
                        id={`env-name-${env.key}`}
                        value={env.name}
                        onChange={(event) =>
                          setEnvironments((current) =>
                            current.map((item) =>
                              item.key === env.key
                                ? {
                                    ...item,
                                    name: event.target.value,
                                    slug: slugify(event.target.value),
                                  }
                                : item,
                            ),
                          )
                        }
                      />
                      <p className="text-muted-foreground font-mono text-xs">
                        vercio_{effectiveSlug || 'projet'}_{env.slug || '…'}
                      </p>
                    </div>
                    <div className="space-y-2">
                      {usedSources.map((source) => (
                        <div key={source.key} className="space-y-1">
                          <Label className="text-muted-foreground text-xs">
                            Branche de {source.repository}
                          </Label>
                          <BranchSelect
                            gitProviderId={source.gitProviderId}
                            repository={source.repository}
                            value={env.branches[source.key] ?? source.defaultBranch}
                            onChange={(branch) =>
                              setEnvironments((current) =>
                                current.map((item) =>
                                  item.key === env.key
                                    ? {
                                        ...item,
                                        branches: { ...item.branches, [source.key]: branch },
                                      }
                                    : item,
                                ),
                              )
                            }
                          />
                        </div>
                      ))}
                      {usedSources.length === 0 && (
                        <p className="text-muted-foreground pt-5 text-xs">
                          Aucun dépôt : image fixe.
                        </p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="self-start sm:mt-5"
                      aria-label={`Retirer ${env.name}`}
                      disabled={environments.length === 1}
                      onClick={() =>
                        setEnvironments((current) => current.filter((item) => item.key !== env.key))
                      }
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setEnvironments((current) => [
                      ...current,
                      {
                        key: envKey++,
                        name: current.length === 1 ? 'Staging' : '',
                        slug: current.length === 1 ? 'staging' : '',
                        branches: Object.fromEntries(sources.map((s) => [s.key, s.defaultBranch])),
                      },
                    ])
                  }
                >
                  <Plus />
                  Ajouter un environnement
                </Button>
              </CardContent>
            </Card>
            {kind === 'import' && imported && environments[0] && (
              <p className="text-muted-foreground text-sm">
                L’environnement « {environments[0].name} » reprend <code>{imported.name}</code> :
                ses conteneurs actuels tournent jusqu’à son premier déploiement, qui les remplace.
                {importedVariables.length > 0 &&
                  ` ${importedVariables.length} variables du .env seront importées.`}
              </p>
            )}
            {create.error && (
              <p role="alert" className="text-destructive text-sm">
                {create.error.message}
                {create.error instanceof ApiError && create.error.field
                  ? ` (${create.error.field})`
                  : ''}
              </p>
            )}
          </>
        )}

        <div className="flex justify-between gap-2">
          <Button
            variant="ghost"
            onClick={() => (step ? goTo(step - 1) : navigate({ to: '/projets' }))}
          >
            <ArrowLeft />
            {step ? 'Précédent' : 'Annuler'}
          </Button>
          {step < STEPS.length - 1 ? (
            <Button onClick={() => goTo(step + 1)} disabled={!canContinue}>
              Suivant
              <ArrowRight />
            </Button>
          ) : (
            <Button onClick={() => create.mutate()} disabled={!canContinue || create.isPending}>
              {create.isPending && <Loader2 className="animate-spin" />}
              Créer le projet
            </Button>
          )}
        </div>
      </div>
    </>
  )
}

function KindCard({
  selected,
  onSelect,
  icon,
  title,
  description,
}: {
  selected: boolean
  onSelect: () => void
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'hover:border-foreground/30 rounded-xl border p-5 text-left transition-colors',
        selected && 'border-primary ring-primary ring-1',
      )}
    >
      <span className="text-muted-foreground [&_svg]:size-6">{icon}</span>
      <p className="mt-3 font-medium">{title}</p>
      <p className="text-muted-foreground mt-1 text-sm">{description}</p>
    </button>
  )
}

function SingleField({
  label,
  id,
  value,
  onChange,
  placeholder,
}: {
  label: string
  id: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        className="font-mono text-sm"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}
