import { ResourceAlertsCard } from '@/components/settings/resource-alerts-card'
import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Bell,
  History,
  KeyRound,
  Loader2,
  Mail,
  MessageSquare,
  Pencil,
  PlugZap,
  Plus,
  Send,
  Trash2,
  Webhook,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  DEFAULT_NOTIFICATION_GROUPS,
  NOTIFICATION_CHANNEL_LABELS,
  NOTIFICATION_GROUP_KEYS,
  NOTIFICATION_GROUPS,
  SMTP_DEFAULT_PORTS,
  SMTP_SECURITY_LABELS,
  type NotificationChannelInput,
  type NotificationChannelType,
  type NotificationChannelView,
  type NotificationDeliveryView,
  type NotificationGroup,
  type SmtpSecurity,
  type SmtpSettingsInput,
  type SmtpSettingsView,
} from '@vercio/shared'
import { CodeBlock, CopyField } from '@/components/common/copy-field'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api, ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ConnectionBadge, ConnectionResult } from './connection-result'
import { Field } from './form-fields'
import { EmptyState } from './resource-list'

const channelsKey = ['settings', 'notifications', 'channels'] as const
const deliveriesKey = ['settings', 'notifications', 'deliveries'] as const
const smtpKey = ['settings', 'smtp'] as const

const TYPE_ICONS: Record<NotificationChannelType, ReactNode> = {
  email: <Mail />,
  teams: <MessageSquare />,
  webhook: <Webhook />,
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
}

export function NotificationsSettingsTab() {
  return (
    <div className="space-y-8">
      <ChannelsSection />
      <ResourceAlertsCard />
      <SmtpSection />
      <DeliveriesSection />
    </div>
  )
}

// --- Canaux ------------------------------------------------------------------------------

function ChannelsSection() {
  const channels = useQuery({ queryKey: channelsKey, queryFn: api.notifications.channels })
  const smtp = useQuery({ queryKey: smtpKey, queryFn: api.smtp.get })
  const [editing, setEditing] = useState<NotificationChannelView | 'new' | null>(null)
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null)

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 font-semibold">
            <Bell className="size-4" />
            Canaux de notification
          </h2>
          <p className="text-muted-foreground max-w-2xl text-sm">
            Email, Microsoft Teams ou webhook sortant : chaque canal choisit ses évènements, ses
            projets et ses environnements.
          </p>
        </div>
        <Button onClick={() => setEditing('new')}>
          <Plus />
          Ajouter un canal
        </Button>
      </div>

      {channels.isPending && <Skeleton className="h-36 w-full" />}
      {channels.error && <p className="text-destructive text-sm">{channels.error.message}</p>}
      {channels.data?.length === 0 && (
        <EmptyState icon={<Bell />} title="Aucun canal">
          Ajoutez un canal pour être prévenu des déploiements en échec, des conteneurs en panne et
          du manque d’espace disque.
        </EmptyState>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {channels.data?.map((channel) => (
          <ChannelCard
            key={channel.id}
            channel={channel}
            smtpConfigured={smtp.data?.configured ?? true}
            onEdit={() => setEditing(channel)}
            onSecret={(value) => setSecret({ name: channel.name, value })}
          />
        ))}
      </div>

      {editing && (
        <ChannelDialog
          channel={editing === 'new' ? null : editing}
          smtpConfigured={smtp.data?.configured ?? true}
          onClose={() => setEditing(null)}
          onCreated={(name, value) => value && setSecret({ name, value })}
        />
      )}
      {secret && (
        <SecretDialog name={secret.name} secret={secret.value} onClose={() => setSecret(null)} />
      )}
    </section>
  )
}

const GROUP_SHORT_LABELS: Record<NotificationGroup, string> = {
  'deployment.succeeded': 'déploiements réussis',
  'deployment.failed': 'déploiements échoués',
  'webhook.rejected': 'webhooks refusés',
  'webhook.ignored': 'builds ignorés',
  'container.failed': 'conteneurs en échec',
  'container.resources': 'CPU ou mémoire saturés',
  'disk.low': 'disque',
  'backup.failed': 'sauvegardes en échec',
}

function groupSummary(groups: NotificationGroup[]): string {
  if (groups.length === NOTIFICATION_GROUP_KEYS.length) return 'Tous les évènements'
  const text = NOTIFICATION_GROUP_KEYS.filter((key) => groups.includes(key))
    .map((key) => GROUP_SHORT_LABELS[key])
    .join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function ChannelCard({
  channel,
  smtpConfigured,
  onEdit,
  onSecret,
}: {
  channel: NotificationChannelView
  smtpConfigured: boolean
  onEdit: () => void
  onSecret: (secret: string) => void
}) {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState<'delete' | 'secret' | null>(null)
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: channelsKey }),
      queryClient.invalidateQueries({ queryKey: deliveriesKey }),
    ])
  const test = useMutation({
    mutationFn: () => api.notifications.test(channel.id),
    onSettled: refresh,
  })
  const remove = useMutation({
    mutationFn: () => api.notifications.remove(channel.id),
    onSuccess: async () => {
      setConfirming(null)
      toast.success(`« ${channel.name} » supprimé`)
      await refresh()
    },
    onError: (error) => toast.error(error.message),
  })
  const regenerate = useMutation({
    mutationFn: () => api.notifications.regenerateSecret(channel.id),
    onSuccess: (result) => {
      setConfirming(null)
      if (result.secret) onSecret(result.secret)
    },
    onError: (error) => toast.error(error.message),
  })

  const scope =
    channel.projectScope === 'all'
      ? 'Tous les projets'
      : channel.projects.length
        ? channel.projects.map((project) => project.name).join(', ')
        : 'Aucun projet (alertes de l’hôte seulement)'

  return (
    <Card className={cn('gap-4', !channel.enabled && 'opacity-70')}>
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2">
          <span className="text-muted-foreground [&_svg]:size-4">{TYPE_ICONS[channel.type]}</span>
          <span className="truncate">{channel.name}</span>
        </CardTitle>
        <CardDescription className="truncate">
          {NOTIFICATION_CHANNEL_LABELS[channel.type]} · {channel.target}
        </CardDescription>
        <CardAction>
          {channel.enabled ? (
            <ConnectionBadge check={channel.lastResult} />
          ) : (
            <Badge variant="outline">Désactivé</Badge>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {channel.failingSince && channel.consecutiveFailures >= 2 && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>En échec depuis le {formatDate(channel.failingSince)}</AlertTitle>
            <AlertDescription>
              {channel.lastResult?.message ?? 'Les envois échouent'}. Vercio réessaie
              automatiquement ; vérifiez la destination si l’échec dure.
            </AlertDescription>
          </Alert>
        )}
        {channel.type === 'email' && !smtpConfigured && (
          <p className="text-warning flex items-start gap-2 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            Aucun serveur SMTP configuré : rien ne partira (voir plus bas).
          </p>
        )}
        <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span>{groupSummary(channel.groups)}</span>
          <span>{scope}</span>
          <span>
            {channel.environmentSlugs.length
              ? `Environnements : ${channel.environmentSlugs.join(', ')}`
              : 'Tous les environnements'}
          </span>
        </div>
        {test.data && <ConnectionResult check={test.data} />}
        {test.error && <p className="text-destructive text-sm">{test.error.message}</p>}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => test.mutate()}
            disabled={test.isPending}
          >
            {test.isPending ? <Loader2 className="animate-spin" /> : <Send />}
            Envoyer un test
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit}>
            <Pencil />
            Modifier
          </Button>
          {channel.type === 'webhook' && (
            <Button size="sm" variant="ghost" onClick={() => setConfirming('secret')}>
              <KeyRound />
              Nouveau secret
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirming('delete')}
          >
            <Trash2 />
            Supprimer
          </Button>
        </div>
      </CardContent>

      <Dialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirming === 'secret'
                ? `Renouveler le secret de « ${channel.name} » ?`
                : `Supprimer « ${channel.name} » ?`}
            </DialogTitle>
            <DialogDescription>
              {confirming === 'secret'
                ? 'L’ancien secret cesse aussitôt d’être utilisé : le récepteur refusera les messages tant que vous n’y aurez pas collé le nouveau.'
                : 'Le canal et son journal d’envois seront effacés. Cette action est définitive.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              Annuler
            </Button>
            {confirming === 'secret' ? (
              <Button onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
                {regenerate.isPending && <Loader2 className="animate-spin" />}
                Renouveler
              </Button>
            ) : (
              <Button
                variant="destructive"
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
              >
                {remove.isPending && <Loader2 className="animate-spin" />}
                Supprimer
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/** Sections de cases à cocher, dans l'ordre de NOTIFICATION_GROUPS. */
const GROUP_SECTIONS = NOTIFICATION_GROUP_KEYS.reduce<
  { section: string; groups: NotificationGroup[] }[]
>((sections, key) => {
  const section = NOTIFICATION_GROUPS[key].section
  const existing = sections.find((item) => item.section === section)
  if (existing) existing.groups.push(key)
  else sections.push({ section, groups: [key] })
  return sections
}, [])

function ChannelDialog({
  channel,
  smtpConfigured,
  onClose,
  onCreated,
}: {
  channel: NotificationChannelView | null
  smtpConfigured: boolean
  onClose: () => void
  onCreated: (name: string, secret: string | null) => void
}) {
  const queryClient = useQueryClient()
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects.list })
  const [type, setType] = useState<NotificationChannelType>(channel?.type ?? 'teams')
  const [name, setName] = useState(channel?.name ?? '')
  const [enabled, setEnabled] = useState(channel?.enabled ?? true)
  const [groups, setGroups] = useState<NotificationGroup[]>(
    channel?.groups ?? DEFAULT_NOTIFICATION_GROUPS,
  )
  const [projectScope, setProjectScope] = useState(channel?.projectScope ?? 'all')
  const [projectIds, setProjectIds] = useState<string[]>(
    channel?.projects.map((project) => project.id) ?? [],
  )
  const [environmentSlugs, setEnvironmentSlugs] = useState<string[]>(
    channel?.environmentSlugs ?? [],
  )
  const [recipients, setRecipients] = useState(channel?.email?.recipients.join('\n') ?? '')
  const [allAdmins, setAllAdmins] = useState(channel?.email?.allAdmins ?? false)
  const [url, setUrl] = useState('')
  const [allowHttp, setAllowHttp] = useState(channel?.webhook?.allowHttp ?? false)

  // Environnements existants (production, staging…), tous projets confondus.
  const environments = useMemo(() => {
    const found = new Map<string, string>()
    for (const project of projects.data ?? []) {
      for (const environment of project.environments) {
        if (!found.has(environment.slug)) found.set(environment.slug, environment.name)
      }
    }
    for (const slug of environmentSlugs) if (!found.has(slug)) found.set(slug, slug)
    return [...found.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [projects.data, environmentSlugs])

  const input = (): NotificationChannelInput => {
    const base = { name, enabled, groups, projectScope, projectIds, environmentSlugs }
    if (type === 'email') {
      return {
        ...base,
        type,
        recipients: recipients
          .split(/[\n,;]+/)
          .map((line) => line.trim())
          .filter(Boolean),
        allAdmins,
      }
    }
    if (type === 'teams') return { ...base, type, url: url || undefined }
    return { ...base, type, url: url || undefined, allowHttp }
  }

  const test = useMutation({
    mutationFn: () => api.notifications.testDraft(input(), channel?.id),
  })
  const save = useMutation({
    mutationFn: async () => {
      if (channel) {
        await api.notifications.update(channel.id, input())
        return null
      }
      return (await api.notifications.create(input())).secret
    },
    onSuccess: async (secret) => {
      toast.success(`« ${name} » enregistré`)
      await queryClient.invalidateQueries({ queryKey: channelsKey })
      onClose()
      if (!channel) onCreated(name, secret)
    },
  })
  const fieldError = (field: string) =>
    save.error instanceof ApiError && save.error.field?.startsWith(field)
      ? save.error.message
      : null

  const toggle = <T,>(list: T[], value: T, checked: boolean) =>
    checked ? [...list, value] : list.filter((item) => item !== value)

  const teamsHostWarning =
    type === 'teams' && url && !/^https:\/\/[^/]*\.powerplatform\.com\//i.test(url)
      ? 'Cette adresse ne ressemble pas à un workflow Teams récent (*.powerplatform.com). Les anciennes URL (logic.azure.com, connecteurs Office 365) cessent de fonctionner.'
      : null
  const canTest = type === 'email' || Boolean(url || channel)

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    save.mutate()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
        <form onSubmit={onSubmit} className="space-y-5">
          <DialogHeader>
            <DialogTitle>
              {channel ? `Modifier « ${channel.name} »` : 'Ajouter un canal'}
            </DialogTitle>
            <DialogDescription>
              Les messages donnent le projet, l’environnement, la version et un lien vers Vercio.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="nc-type" label="Type">
              <Select
                value={type}
                onValueChange={(value) => setType(value as NotificationChannelType)}
                disabled={Boolean(channel)}
              >
                <SelectTrigger id="nc-type" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="teams">Microsoft Teams</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="webhook">Webhook sortant</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field id="nc-name" label="Nom" error={fieldError('name')}>
              <Input
                id="nc-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={type === 'email' ? 'Équipe exploitation' : 'Canal Ops'}
                required
              />
            </Field>
          </div>

          {type === 'teams' && (
            <div className="space-y-2">
              <Field
                id="nc-url"
                label="URL du workflow Teams"
                error={fieldError('url')}
                hint={
                  channel?.teams
                    ? `Enregistrée : ${channel.teams.urlHint} — vide = inchangée.`
                    : 'L’URL contient une signature : elle n’est plus affichée après l’enregistrement.'
                }
              >
                <Input
                  id="nc-url"
                  type="url"
                  autoComplete="off"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://….environment.api.powerplatform.com/powerautomate/…"
                  required={!channel}
                />
              </Field>
              {teamsHostWarning && <p className="text-warning text-xs">{teamsHostWarning}</p>}
              <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-xs">
                <li>
                  Dans Teams, ouvrez <strong>Workflows</strong> et choisissez le modèle « Send
                  webhook alerts to a channel » (ou « Envoyer des alertes webhook à un canal »).
                </li>
                <li>
                  Gardez l’action « Post card in a chat or channel », publiée en tant que{' '}
                  <strong>Flow bot</strong>, et choisissez l’équipe et le canal.
                </li>
                <li>
                  Laissez le déclencheur accessible à « Anyone », enregistrez, puis copiez l’URL du
                  déclencheur ici.
                </li>
              </ol>
            </div>
          )}

          {type === 'email' && (
            <div className="space-y-3">
              {!smtpConfigured && (
                <p className="text-warning flex items-start gap-2 text-xs">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  Configurez d’abord le serveur SMTP (section « Serveur SMTP » de cette page).
                </p>
              )}
              <Field
                id="nc-recipients"
                label="Destinataires"
                hint="Une adresse par ligne, 50 au plus."
                error={fieldError('recipients')}
              >
                <Textarea
                  id="nc-recipients"
                  rows={3}
                  value={recipients}
                  onChange={(e) => setRecipients(e.target.value)}
                  placeholder="exploitation@example.com"
                />
              </Field>
              <SwitchRow
                id="nc-admins"
                label="Tous les administrateurs"
                hint="Ajoute au moment de l’envoi l’adresse des comptes administrateurs actifs."
                checked={allAdmins}
                onChange={setAllAdmins}
              />
            </div>
          )}

          {type === 'webhook' && (
            <div className="space-y-3">
              <Field
                id="nc-url"
                label="URL du récepteur"
                error={fieldError('url')}
                hint={
                  channel?.webhook
                    ? `Enregistrée : ${channel.webhook.url} — vide = inchangée.`
                    : 'Requête POST en JSON, signée (Standard Webhooks). Le secret est affiché après l’enregistrement.'
                }
              >
                <Input
                  id="nc-url"
                  type="url"
                  autoComplete="off"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://supervision.example.com/hooks/vercio"
                  required={!channel}
                />
              </Field>
              <SwitchRow
                id="nc-http"
                label="HTTP non chiffré"
                hint="Seulement pour un récepteur sur votre réseau interne."
                checked={allowHttp}
                onChange={setAllowHttp}
              />
            </div>
          )}

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Évènements</legend>
            {fieldError('groups') && (
              <p className="text-destructive text-xs">{fieldError('groups')}</p>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              {GROUP_SECTIONS.map(({ section, groups: keys }) => (
                <div key={section} className="space-y-2">
                  <p className="text-muted-foreground text-xs font-medium uppercase">{section}</p>
                  {keys.map((key) => (
                    <CheckRow
                      key={key}
                      id={`nc-group-${key}`}
                      label={NOTIFICATION_GROUPS[key].label}
                      checked={groups.includes(key)}
                      onChange={(checked) => setGroups(toggle(groups, key, checked))}
                    />
                  ))}
                </div>
              ))}
            </div>
            <p className="text-muted-foreground text-xs">
              Le rétablissement d’un service ou du disque part avec l’alerte correspondante. Une
              panne de canal est toujours signalée sur les autres canaux.
            </p>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">Projets</legend>
            <Select
              value={projectScope}
              onValueChange={(value) => setProjectScope(value as 'all' | 'selected')}
            >
              <SelectTrigger className="w-full" aria-label="Projets concernés">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Tous les projets, y compris les futurs</SelectItem>
                <SelectItem value="selected">Projets choisis</SelectItem>
              </SelectContent>
            </Select>
            {projectScope === 'selected' && (
              <div className="grid gap-2 rounded-lg border p-3 sm:grid-cols-2">
                {projects.data?.length === 0 && (
                  <p className="text-muted-foreground text-xs">Aucun projet pour le moment.</p>
                )}
                {projects.data?.map((project) => (
                  <CheckRow
                    key={project.id}
                    id={`nc-project-${project.id}`}
                    label={project.name}
                    checked={projectIds.includes(project.id)}
                    onChange={(checked) => setProjectIds(toggle(projectIds, project.id, checked))}
                  />
                ))}
                {projectIds.length === 0 && (projects.data?.length ?? 0) > 0 && (
                  <p className="text-warning text-xs sm:col-span-2">
                    Aucun projet coché : seules les alertes de l’hôte (disque) seront envoyées.
                  </p>
                )}
              </div>
            )}
          </fieldset>

          {environments.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Environnements</legend>
              <p className="text-muted-foreground text-xs">
                Aucun coché : tous les environnements, y compris les futurs.
              </p>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {environments.map(([slug, label]) => (
                  <CheckRow
                    key={slug}
                    id={`nc-env-${slug}`}
                    label={label}
                    checked={environmentSlugs.includes(slug)}
                    onChange={(checked) =>
                      setEnvironmentSlugs(toggle(environmentSlugs, slug, checked))
                    }
                  />
                ))}
              </div>
            </fieldset>
          )}

          <SwitchRow
            id="nc-enabled"
            label="Canal actif"
            hint="Désactivé, le canal ne reçoit plus rien ; sa configuration est gardée."
            checked={enabled}
            onChange={setEnabled}
          />

          {test.data && <ConnectionResult check={test.data} />}
          {test.error && <p className="text-destructive text-sm">{test.error.message}</p>}
          {save.error && !(save.error instanceof ApiError && save.error.field) && (
            <p className="text-destructive text-sm">{save.error.message}</p>
          )}

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => test.mutate()}
              disabled={test.isPending || !canTest}
            >
              {test.isPending ? <Loader2 className="animate-spin" /> : <PlugZap />}
              Envoyer un test
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />}
              Enregistrer
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function CheckRow({
  id,
  label,
  checked,
  onChange,
}: {
  id: string
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start gap-2">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        className="mt-0.5"
      />
      <Label htmlFor={id} className="text-sm leading-snug font-normal">
        {label}
      </Label>
    </div>
  )
}

function SwitchRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string
  label: string
  hint: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
      <div className="space-y-1">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-muted-foreground text-xs">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

const VERIFY_EXAMPLE = `// Node.js — npm install standardwebhooks
import { Webhook } from 'standardwebhooks'

const wh = new Webhook(process.env.VERCIO_WEBHOOK_SECRET) // whsec_…
// En-têtes webhook-id, webhook-timestamp, webhook-signature ; corps brut
const event = wh.verify(rawBody, headers)
// event.id est identique d'un essai à l'autre : ignorez un id déjà traité.`

function SecretDialog({
  name,
  secret,
  onClose,
}: {
  name: string
  secret: string
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Secret de signature de « {name} »</DialogTitle>
          <DialogDescription>
            Copiez-le maintenant dans le récepteur : il ne sera plus affiché. En cas de perte,
            renouvelez-le depuis la carte du canal.
          </DialogDescription>
        </DialogHeader>
        <CopyField value={secret} secret />
        <p className="text-muted-foreground text-xs">
          Chaque requête porte les en-têtes <code>webhook-id</code>, <code>webhook-timestamp</code>{' '}
          et <code>webhook-signature</code> (spécification Standard Webhooks). Refusez un horodatage
          de plus de 5 minutes.
        </p>
        <CodeBlock code={VERIFY_EXAMPLE} label="Exemple de vérification" />
        <DialogFooter>
          <Button onClick={onClose}>J’ai copié le secret</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// --- Serveur SMTP ------------------------------------------------------------------------

function SmtpSection() {
  const smtp = useQuery({ queryKey: smtpKey, queryFn: api.smtp.get })
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="size-4" />
          Serveur SMTP
        </CardTitle>
        <CardDescription>Serveur d’envoi utilisé par les canaux email.</CardDescription>
        {smtp.data?.configured && (
          <CardAction>
            <ConnectionBadge check={smtp.data.lastCheck} />
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        {smtp.isPending && <Skeleton className="h-48 w-full" />}
        {smtp.error && <p className="text-destructive text-sm">{smtp.error.message}</p>}
        {smtp.data && (
          // Remis à zéro après un enregistrement, pas quand seul le résultat du dernier test change.
          <SmtpForm key={JSON.stringify({ ...smtp.data, lastCheck: null })} settings={smtp.data} />
        )}
      </CardContent>
    </Card>
  )
}

function SmtpForm({ settings }: { settings: SmtpSettingsView }) {
  const queryClient = useQueryClient()
  const me = useQuery({
    queryKey: ['settings', 'notifications', 'me'],
    queryFn: api.notifications.me,
  })
  const [host, setHost] = useState(settings.host)
  const [security, setSecurity] = useState<SmtpSecurity>(settings.security)
  const [port, setPort] = useState(String(settings.port))
  const [username, setUsername] = useState(settings.username ?? '')
  const [password, setPassword] = useState('')
  const [from, setFrom] = useState(settings.from)
  const [fromName, setFromName] = useState(settings.fromName)
  const [caCertificate, setCaCertificate] = useState(settings.caCertificate ?? '')
  const [showAdvanced, setShowAdvanced] = useState(Boolean(settings.caCertificate))
  const [to, setTo] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const testTo = to ?? me.data?.email ?? ''

  const input = (): SmtpSettingsInput => ({
    host,
    port: Number(port),
    security,
    username: username || undefined,
    password: password || undefined,
    from,
    fromName,
    caCertificate: caCertificate || undefined,
  })

  const test = useMutation({
    mutationFn: (withEmail: boolean) =>
      api.smtp.test(input(), withEmail ? testTo || undefined : undefined),
    onSettled: () => queryClient.invalidateQueries({ queryKey: smtpKey }),
  })
  const save = useMutation({
    mutationFn: () => api.smtp.save(input()),
    onSuccess: async () => {
      toast.success('Serveur SMTP enregistré')
      await queryClient.invalidateQueries({ queryKey: smtpKey })
    },
  })
  const remove = useMutation({
    mutationFn: api.smtp.remove,
    onSuccess: async () => {
      setConfirmDelete(false)
      toast.success('Serveur SMTP supprimé')
      await queryClient.invalidateQueries({ queryKey: smtpKey })
    },
    onError: (error) => toast.error(error.message),
  })
  const fieldError = (field: string) =>
    save.error instanceof ApiError && save.error.field === field ? save.error.message : null
  const testFieldError =
    test.error instanceof ApiError && test.error.field ? test.error.message : null

  function onSecurityChange(value: SmtpSecurity) {
    // Port usuel du mode choisi, sauf port personnalisé.
    if (Object.values(SMTP_DEFAULT_PORTS).map(String).includes(port)) {
      setPort(String(SMTP_DEFAULT_PORTS[value]))
    }
    setSecurity(value)
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    save.mutate()
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-[1fr_auto_8rem]">
        <Field id="smtp-host" label="Hôte" error={fieldError('host')}>
          <Input
            id="smtp-host"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="smtp.example.com"
            required
          />
        </Field>
        <Field id="smtp-security" label="Chiffrement" error={fieldError('security')}>
          <Select
            value={security}
            onValueChange={(value) => onSecurityChange(value as SmtpSecurity)}
          >
            <SelectTrigger id="smtp-security" className="w-full sm:w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SMTP_SECURITY_LABELS) as SmtpSecurity[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {SMTP_SECURITY_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id="smtp-port" label="Port" error={fieldError('port')}>
          <Input
            id="smtp-port"
            inputMode="numeric"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            required
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id="smtp-username"
          label="Identifiant"
          hint="Vide : relais sans authentification (autorisé par adresse IP)."
          error={fieldError('username')}
        >
          <Input
            id="smtp-username"
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field
          id="smtp-password"
          label="Mot de passe"
          hint={settings.hasPassword ? 'Vide = inchangé (même serveur et même compte).' : undefined}
          error={fieldError('password') ?? testFieldError}
        >
          <Input
            id="smtp-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={!username}
          />
        </Field>
        <Field id="smtp-from" label="Adresse d’expédition" error={fieldError('from')}>
          <Input
            id="smtp-from"
            type="email"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="vercio@example.com"
            required
          />
        </Field>
        <Field id="smtp-from-name" label="Nom d’expéditeur" error={fieldError('fromName')}>
          <Input
            id="smtp-from-name"
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
          />
        </Field>
      </div>

      {showAdvanced ? (
        <Field
          id="smtp-ca"
          label="Certificat de l’autorité interne (PEM)"
          hint="Uniquement si le serveur utilise un certificat signé par une autorité interne."
          error={fieldError('caCertificate')}
        >
          <Textarea
            id="smtp-ca"
            rows={4}
            className="font-mono text-xs"
            value={caCertificate}
            onChange={(e) => setCaCertificate(e.target.value)}
            placeholder="-----BEGIN CERTIFICATE-----"
          />
        </Field>
      ) : (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground text-sm underline-offset-4 hover:underline"
          onClick={() => setShowAdvanced(true)}
        >
          Autorité de certification interne…
        </button>
      )}

      <p className="text-muted-foreground text-xs">
        Microsoft 365 désactive l’authentification SMTP par mot de passe : utilisez un relais SMTP
        ou un connecteur autorisé par adresse IP si l’envoi est refusé (erreur 5.7.139).
      </p>

      {test.data && <ConnectionResult check={test.data} />}
      {test.error && !testFieldError && (
        <p className="text-destructive text-sm">{test.error.message}</p>
      )}
      {save.error && !(save.error instanceof ApiError && save.error.field) && (
        <p className="text-destructive text-sm">{save.error.message}</p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <Button
          type="button"
          variant="secondary"
          onClick={() => test.mutate(false)}
          disabled={test.isPending || !host}
        >
          {test.isPending && test.variables === false ? (
            <Loader2 className="animate-spin" />
          ) : (
            <PlugZap />
          )}
          Tester la connexion
        </Button>
        <div className="flex gap-2">
          <Input
            aria-label="Destinataire de l’email de test"
            type="email"
            className="w-56"
            value={testTo}
            onChange={(e) => setTo(e.target.value)}
            placeholder="vous@example.com"
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => test.mutate(true)}
            disabled={test.isPending || !host || !testTo}
          >
            {test.isPending && test.variables === true ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Send />
            )}
            Envoyer un email de test
          </Button>
        </div>
        <div className="ml-auto flex gap-2">
          {settings.configured && (
            <Button
              type="button"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 />
              Supprimer
            </Button>
          )}
          <Button type="submit" disabled={save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            Enregistrer
          </Button>
        </div>
      </div>

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer le serveur SMTP ?</DialogTitle>
            <DialogDescription>
              Les canaux email ne pourront plus rien envoyer tant qu’un serveur n’est pas configuré.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Annuler
            </Button>
            <Button
              variant="destructive"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              {remove.isPending && <Loader2 className="animate-spin" />}
              Supprimer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </form>
  )
}

// --- Journal -----------------------------------------------------------------------------

const STATUS_LABELS: Record<NotificationDeliveryView['status'], string> = {
  pending: 'En attente',
  sending: 'Envoi…',
  sent: 'Envoyé',
  failed: 'Échec',
  suppressed: 'Écarté',
}

function DeliveryStatus({ delivery }: { delivery: NotificationDeliveryView }) {
  const color =
    delivery.status === 'sent'
      ? 'bg-success'
      : delivery.status === 'failed'
        ? 'bg-destructive'
        : delivery.status === 'pending'
          ? 'bg-warning'
          : 'bg-muted-foreground'
  return (
    <Badge variant="outline">
      <span className={cn('size-2 rounded-full', color)} />
      {delivery.merged ? 'Dans un récapitulatif' : STATUS_LABELS[delivery.status]}
    </Badge>
  )
}

function DeliveriesSection() {
  const deliveries = useQuery({
    queryKey: deliveriesKey,
    queryFn: () => api.notifications.deliveries(),
    refetchInterval: 15_000,
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="size-4" />
          Journal des envois
        </CardTitle>
        <CardDescription>
          Les 100 derniers messages, tous canaux confondus ; gardés 30 jours. Un message en échec
          temporaire est réessayé pendant environ 4 heures.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {deliveries.isPending && <Skeleton className="h-24 w-full" />}
        {deliveries.data?.length === 0 && (
          <p className="text-muted-foreground text-sm">Aucun envoi pour le moment.</p>
        )}
        {deliveries.data && deliveries.data.length > 0 && (
          <ul className="divide-y">
            {deliveries.data.map((delivery) => (
              <li key={delivery.id} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:gap-4">
                <span className="text-muted-foreground w-32 shrink-0 text-xs tabular-nums">
                  {formatDate(delivery.createdAt)}
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="truncate text-sm">{delivery.title}</p>
                  <p className="text-muted-foreground text-xs">
                    {delivery.channelName}
                    {delivery.attempts > 1 && ` · ${delivery.attempts} essais`}
                    {delivery.suppressedCount > 0 &&
                      ` · ${delivery.suppressedCount} répétition(s) regroupée(s)`}
                    {delivery.nextAttemptAt &&
                      delivery.attempts > 0 &&
                      ` · nouvel essai à ${new Date(delivery.nextAttemptAt).toLocaleTimeString('fr-FR', { timeStyle: 'short' })}`}
                  </p>
                  {delivery.error && (
                    <p
                      className={cn(
                        'text-xs break-words',
                        delivery.status === 'sent' ? 'text-warning' : 'text-destructive',
                      )}
                    >
                      {delivery.error}
                    </p>
                  )}
                </div>
                <div className="shrink-0">
                  <DeliveryStatus delivery={delivery} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
