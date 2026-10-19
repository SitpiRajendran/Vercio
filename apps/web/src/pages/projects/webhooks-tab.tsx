import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  ShieldCheck,
  Webhook,
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  AppSourceView,
  EnvironmentSourceView,
  ProjectView,
  WebhookConfigView,
  WebhookEventView,
  WebhookResult,
  WebhookSourceView,
} from '@vercio/shared'
import { CodeBlock, CopyField } from '@/components/common/copy-field'
import { IpAllowlistEditor } from '@/components/projects/ip-allowlist-editor'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
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
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import { formatDateTime, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

export function WebhooksTab({
  project,
  can,
  envId,
}: {
  project: ProjectView
  can: { canDeploy: boolean; isAdmin: boolean }
  /** Environnement choisi dans l'en-tête du projet. */
  envId: string
}) {
  const environment = project.environments.find((env) => env.id === envId)
  const config = useQuery({
    queryKey: ['webhooks', envId],
    queryFn: () => api.webhooks.get(project.id, envId),
    enabled: Boolean(envId),
    refetchInterval: 10_000,
  })

  if (!environment) return <p className="text-muted-foreground text-sm">Aucun environnement.</p>

  return (
    <div className="space-y-4">
      {config.isPending && <Skeleton className="h-60 w-full" />}
      {config.error && <p className="text-destructive text-sm">{config.error.message}</p>}
      {config.data && (
        <>
          {!config.data.enabled && (
            <p className="text-warning rounded-lg border border-dashed p-3 text-sm">
              Webhooks désactivés pour toute l’instance : les URL ci-dessous répondent 404 et rien
              n’est déployé automatiquement. Réactivation dans{' '}
              <Link to="/parametres" hash="webhooks" className="underline underline-offset-4">
                Paramètres → Webhooks
              </Link>
              .
            </p>
          )}
          {project.sources.length === 0 && (
            <p className="text-muted-foreground text-sm">
              Aucun dépôt : ce projet n’a pas d’image suivie, les webhooks sont sans objet.
            </p>
          )}
          {project.sources.map((source) => {
            const envSource = environment.sources.find((item) => item.appSourceId === source.id)
            const hook = config.data.sources.find((item) => item.appSourceId === source.id)
            if (!envSource || !hook) return null
            return (
              <SourceWebhookCard
                key={source.id}
                project={project}
                envId={envId}
                source={source}
                envSource={envSource}
                hook={hook}
                canDeploy={can.canDeploy}
                isAdmin={can.isAdmin}
              />
            )
          })}
          <AllowlistCard
            key={`allowlist-${envId}`}
            project={project}
            envId={envId}
            config={config.data}
            canEdit={can.isAdmin}
          />
          <EventsCard project={project} events={config.data.events} sources={project.sources} />
        </>
      )}
    </div>
  )
}

function SourceWebhookCard({
  project,
  envId,
  source,
  envSource,
  hook,
  canDeploy,
  isAdmin,
}: {
  project: ProjectView
  envId: string
  source: AppSourceView
  envSource: EnvironmentSourceView
  hook: WebhookSourceView
  canDeploy: boolean
  isAdmin: boolean
}) {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const regenerate = useMutation({
    mutationFn: () => api.webhooks.regenerate(project.id, envId, source.id),
    onSuccess: (config) => {
      queryClient.setQueryData(['webhooks', envId], config)
      setConfirming(false)
      toast.success('Nouvelle URL générée : mettez à jour la CI ou le webhook du dépôt')
    },
    onError: (error) => toast.error(error.message),
  })
  const locked = envSource.mode === 'locked'
  const version = envSource.ref === 'latest' ? `latest (${envSource.branch})` : envSource.ref

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2">
            <Webhook className="size-4" />
            {source.repository}
          </CardTitle>
          <CardDescription>
            Branche suivie <span className="font-mono">{envSource.branch}</span> · version{' '}
            <span className="font-mono">{version}</span>
          </CardDescription>
        </div>
        {canDeploy && hook.token && (
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
            <RefreshCw />
            Régénérer
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {locked && (
          <Alert>
            <Lock />
            <AlertTitle>Environnement verrouillé sur {version}</AlertTitle>
            <AlertDescription>
              Les appels sont reçus et journalisés, mais ne déclenchent aucun déploiement.
              Déverrouillez l’environnement (onglet Environnements) pour reprendre les mises à jour
              automatiques.
            </AlertDescription>
          </Alert>
        )}
        {!hook.token && (
          <p className="text-muted-foreground text-sm">
            {canDeploy
              ? 'Aucune URL pour ce dépôt : générez-en une.'
              : 'Les URL de webhook sont visibles des rôles vercio-deployer et vercio-admin.'}
          </p>
        )}
        {!hook.token && canDeploy && (
          <Button onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
            {regenerate.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />}
            Générer l’URL du webhook
          </Button>
        )}
        {hook.urls && hook.secret && (
          <AutoInstall
            project={project}
            envId={envId}
            source={source}
            hook={hook}
            isAdmin={isAdmin}
          />
        )}
        {hook.urls && hook.secret && (
          <Tabs defaultValue={source.gitProviderType === 'github' ? 'github' : 'gitlab'}>
            <TabsList>
              <TabsTrigger value="gitlab">GitLab</TabsTrigger>
              <TabsTrigger value="github">GitHub</TabsTrigger>
              <TabsTrigger value="generic">Générique (CI)</TabsTrigger>
            </TabsList>
            <TabsContent value="gitlab" className="space-y-3 pt-3">
              <p className="text-muted-foreground text-sm">
                Dans GitLab : <em>Paramètres → Webhooks → Ajouter un webhook</em>. Cochez{' '}
                <strong>Évènements de pipeline</strong> (et, si vous voulez,{' '}
                <em>Évènements de push de tag</em> pour rafraîchir la liste des versions). Vercio ne
                réagit qu’aux pipelines réussis.
              </p>
              <Field label="URL" id={`gl-url-${source.id}`} value={hook.urls.gitlab} />
              <Field
                label="Jeton secret (Secret token)"
                id={`gl-secret-${source.id}`}
                value={hook.secret}
                secret
              />
            </TabsContent>
            <TabsContent value="github" className="space-y-3 pt-3">
              <p className="text-muted-foreground text-sm">
                Dans GitHub : <em>Settings → Webhooks → Add webhook</em>, type de contenu{' '}
                <code className="font-mono">application/json</code>. Évènements :{' '}
                <strong>Workflow runs</strong> (et <em>Packages</em> pour les images publiées sur
                GHCR). Vercio vérifie la signature et ne réagit qu’aux workflows réussis.
              </p>
              <Field label="Payload URL" id={`gh-url-${source.id}`} value={hook.urls.github} />
              <Field label="Secret" id={`gh-secret-${source.id}`} value={hook.secret} secret />
            </TabsContent>
            <TabsContent value="generic" className="space-y-3 pt-3">
              <p className="text-muted-foreground text-sm">
                À appeler en fin de pipeline, une fois les images poussées. Enregistrez l’URL dans
                une variable masquée de la CI (<code className="font-mono">VERCIO_WEBHOOK_URL</code>
                ) : elle suffit à déclencher une relecture du registry.
              </p>
              <Field label="URL" id={`generic-url-${source.id}`} value={hook.urls.generic} secret />
              <Label>GitLab CI (.gitlab-ci.yml)</Label>
              <CodeBlock label="Exemple GitLab CI" code={gitlabCiSnippet(envSource.branch)} />
              <Label>GitHub Actions</Label>
              <CodeBlock label="Exemple GitHub Actions" code={githubActionsSnippet()} />
            </TabsContent>
          </Tabs>
        )}
      </CardContent>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Régénérer l’URL et le secret ?</DialogTitle>
            <DialogDescription>
              Les anciennes valeurs cessent de fonctionner immédiatement : il faudra mettre à jour
              le webhook du dépôt ou la variable de la CI.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Annuler
            </Button>
            <Button onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
              {regenerate.isPending && <Loader2 className="animate-spin" />}
              Régénérer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function Field({
  label,
  id,
  value,
  secret,
}: {
  label: string
  id: string
  value: string
  secret?: boolean
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <CopyField id={id} value={value} secret={secret} />
    </div>
  )
}

function gitlabCiSnippet(branch: string) {
  return `vercio:
  stage: .post
  image: curlimages/curl:8.10.1
  rules:
    - if: $CI_COMMIT_BRANCH == "${branch}"
  script:
    - >
      curl --fail-with-body -sS -X POST
      -H "Content-Type: application/json"
      -d "{\\"branch\\": \\"$CI_COMMIT_BRANCH\\"}"
      "$VERCIO_WEBHOOK_URL"`
}

function githubActionsSnippet() {
  return `- name: Prévenir Vercio
  if: success()
  run: >
    curl --fail-with-body -sS -X POST
    -H "Content-Type: application/json"
    -d "{\\"branch\\": \\"\${{ github.ref_name }}\\"}"
    "\${{ secrets.VERCIO_WEBHOOK_URL }}"`
}

function AllowlistCard({
  project,
  envId,
  config,
  canEdit,
}: {
  project: ProjectView
  envId: string
  config: WebhookConfigView
  canEdit: boolean
}) {
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: (rules: string[]) => api.webhooks.saveAllowlist(project.id, envId, rules),
    onSuccess: (updated) => {
      queryClient.setQueryData(['webhooks', envId], updated)
      toast.success('Liste d’IP enregistrée')
    },
    onError: (error) => toast.error(error.message),
  })
  const effective = config.ipAllowlist.length ? config.ipAllowlist : config.globalIpAllowlist

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4" />
          Adresses IP autorisées
        </CardTitle>
        <CardDescription>
          Une adresse ou une plage CIDR par ligne. Vide : la liste globale (Paramètres → Webhooks)
          s’applique.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">
          {effective.length === 0 ? (
            <span className="text-warning">
              Aucune restriction d’adresse : seul le jeton protège ces URL.
            </span>
          ) : (
            <>
              En vigueur ({config.ipAllowlist.length ? 'liste de l’environnement' : 'liste globale'}
              ) : <span className="font-mono text-xs">{effective.join(', ')}</span>
            </>
          )}
        </p>
        <IpAllowlistEditor
          id={`allowlist-${envId}`}
          initial={config.ipAllowlist}
          canEdit={canEdit}
          saving={save.isPending}
          onSave={(rules) => save.mutate(rules)}
          placeholder={config.globalIpAllowlist.join('\n') || undefined}
        />
      </CardContent>
    </Card>
  )
}

export const WEBHOOK_RESULTS: Record<WebhookResult, { label: string; className: string }> = {
  deployed: { label: 'Déployé', className: 'text-success' },
  merged: { label: 'Fusionné', className: 'text-primary' },
  unchanged: { label: 'Inchangé', className: 'text-muted-foreground' },
  ignored: { label: 'Ignoré', className: 'text-muted-foreground' },
  rejected: { label: 'Refusé', className: 'text-destructive' },
  error: { label: 'Erreur', className: 'text-destructive' },
}

/** Libellés du résumé d'un appel ; l'évènement lui-même est affiché seul. */
const DETAIL_LABELS: Record<string, string> = {
  ref: 'réf.',
  branch: 'branche',
  tag: 'tag',
  status: 'statut',
  pipeline: 'pipeline n°',
  workflow: 'workflow',
  conclusion: 'résultat',
  package: 'paquet',
  version: 'version',
}

const KINDS: Record<string, string> = { generic: 'Générique', gitlab: 'GitLab', github: 'GitHub' }

function EventsCard({
  project,
  events,
  sources,
}: {
  project: ProjectView
  events: WebhookEventView[]
  sources: AppSourceView[]
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Derniers appels</CardTitle>
        <CardDescription>Les 50 derniers appels reçus pour cet environnement.</CardDescription>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center text-sm">Aucun appel reçu.</p>
        ) : (
          <div className="divide-y rounded-lg border">
            {events.map((event) => {
              const result = WEBHOOK_RESULTS[event.result] ?? WEBHOOK_RESULTS.ignored
              const source = sources.find((item) => item.id === event.appSourceId)
              const summary = Object.entries(event.details ?? {})
                .filter(([, value]) => value)
                .map(([key, value]) =>
                  DETAIL_LABELS[key] ? `${DETAIL_LABELS[key]} ${value}` : value,
                )
                .join(' · ')
              return (
                <div
                  key={event.id}
                  className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm"
                >
                  <Badge variant="outline" className={cn('w-20 justify-center', result.className)}>
                    {result.label}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate">{event.reason}</p>
                    <p className="text-muted-foreground truncate text-xs">
                      <span title={formatDateTime(event.createdAt)}>
                        {formatRelative(event.createdAt)}
                      </span>
                      {' · '}
                      {KINDS[event.kind] ?? event.kind}
                      {sources.length > 1 && source ? ` · ${source.repository}` : ''}
                      {event.ip ? ` · ${event.ip}` : ''}
                      {summary ? ` · ${summary}` : ''}
                    </p>
                  </div>
                  {event.deploymentId && (
                    <Button variant="ghost" size="sm" asChild>
                      <Link
                        to="/projets/$slug/deploiements/$deploymentId"
                        params={{ slug: project.slug, deploymentId: event.deploymentId }}
                      >
                        Voir le déploiement
                      </Link>
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

const PROVIDER_NAMES = { gitlab: 'GitLab', github: 'GitHub' } as const

/** Création du webhook chez le fournisseur, avec le token de la connexion. */
function AutoInstall({
  project,
  envId,
  source,
  hook,
  isAdmin,
}: {
  project: ProjectView
  envId: string
  source: AppSourceView
  hook: WebhookSourceView
  isAdmin: boolean
}) {
  const queryClient = useQueryClient()
  const name = PROVIDER_NAMES[hook.provider]
  const install = useMutation({
    mutationFn: () => api.webhooks.install(project.id, envId, source.id),
    onSuccess: (config) => {
      queryClient.setQueryData(['webhooks', envId], config)
      toast.success(`Webhook créé dans ${name}`)
    },
  })
  const pageLink = hook.providerHooksUrl && (
    <a
      href={hook.providerHooksUrl}
      target="_blank"
      rel="noreferrer"
      className="text-primary inline-flex items-center gap-1 underline-offset-4 hover:underline"
    >
      Voir dans {name}
      <ExternalLink className="size-3" />
    </a>
  )
  return (
    <div className="space-y-2 rounded-lg border p-3 text-sm">
      {hook.installedAt ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <CheckCircle2 className="text-success size-4" />
          <span>
            Webhook créé dans {name} {formatRelative(hook.installedAt)} : chaque pipeline réussi sur{' '}
            la branche suivie déclenche la mise à jour.
          </span>
          {pageLink}
        </p>
      ) : (
        <p>
          <span className="font-medium">Mise à jour automatique après chaque push.</span>{' '}
          <span className="text-muted-foreground">
            {isAdmin
              ? `Vercio peut créer le webhook dans ${name} avec le token de la connexion (portée ${hook.provider === 'gitlab' ? '« api »' : '« admin:repo_hook »'} nécessaire). Sinon, suivez les étapes ci-dessous.`
              : `Un administrateur peut créer le webhook dans ${name} en un clic, ou suivre les étapes ci-dessous.`}
          </span>
        </p>
      )}
      {isAdmin && (
        <Button
          size="sm"
          variant={hook.installedAt ? 'outline' : 'default'}
          onClick={() => install.mutate()}
          disabled={install.isPending}
        >
          {install.isPending ? <Loader2 className="animate-spin" /> : <Webhook />}
          {hook.installedAt ? 'Recréer le webhook' : `Créer le webhook dans ${name}`}
        </Button>
      )}
      {install.error && (
        <p className="text-destructive text-sm">
          {install.error.message} {pageLink}
        </p>
      )}
    </div>
  )
}
