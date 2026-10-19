import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  ChevronDown,
  Database,
  Download,
  HardDrive,
  History,
  KeyRound,
  Loader2,
  Play,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  DATABASE_ENGINE_LABELS,
  DEFAULT_BACKUP_KEEP,
  DEFAULT_BACKUP_SCHEDULE,
  isBackupItemIncluded,
  type BackupCandidate,
  type BackupEnvironmentPage,
  type BackupPlanView,
  type BackupSchedule,
  type BackupStatus,
  type BackupView,
  type ProjectView,
} from '@vercio/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import { api } from '@/lib/api'
import { formatBytes, formatDateTime, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

const STATUS: Record<BackupStatus, { label: string; dot: string; text: string }> = {
  running: { label: 'En cours', dot: 'bg-warning animate-pulse', text: 'text-warning' },
  succeeded: { label: 'Réussie', dot: 'bg-success', text: 'text-success' },
  partial: { label: 'Incomplète', dot: 'bg-warning', text: 'text-warning' },
  failed: { label: 'Échouée', dot: 'bg-destructive', text: 'text-destructive' },
}

export function scheduleLabel(schedule: BackupSchedule): string {
  return schedule.kind === 'daily'
    ? `chaque jour à ${schedule.time.replace(':', ' h ')}`
    : `toutes les ${schedule.hours} h`
}

/** Sauvegardes d'un environnement : réglage, lancement, historique et restauration. */
export function BackupsTab({
  project,
  envId,
  envName,
  can,
}: {
  project: ProjectView
  envId: string
  envName: string
  can: { canDeploy: boolean; isAdmin: boolean }
}) {
  const queryClient = useQueryClient()
  const key = ['backups', envId]
  const page = useQuery({
    queryKey: key,
    queryFn: () => api.backups.page(project.id, envId),
    refetchInterval: (query) =>
      query.state.data?.backups.some(
        (item) => item.status === 'running' || item.lastRestore?.status === 'running',
      )
        ? 2000
        : false,
  })
  const run = useMutation({
    mutationFn: () => api.backups.run(project.id, envId),
    onSuccess: async () => {
      toast.success('Sauvegarde lancée')
      await queryClient.invalidateQueries({ queryKey: key })
    },
    onError: (error) => toast.error(error.message),
  })

  if (page.isPending) return <Skeleton className="h-48 w-full" />
  if (page.error) return <p className="text-destructive text-sm">{page.error.message}</p>
  const data = page.data
  const running = data.backups.some((item) => item.status === 'running')

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <section className="min-w-0 space-y-3 xl:order-2">
        {can.isAdmin ? (
          <PlanForm key={JSON.stringify(data.plan)} project={project} envId={envId} page={data} />
        ) : (
          <PlanSummary plan={data.plan} />
        )}
      </section>
      <section className="min-w-0 space-y-3 xl:order-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <History className="size-4" />
            Historique
          </h2>
          {can.canDeploy && data.plan && (
            <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending || running}>
              {run.isPending || running ? <Loader2 className="animate-spin" /> : <Play />}
              {running ? 'Sauvegarde en cours…' : 'Sauvegarder maintenant'}
            </Button>
          )}
        </div>
        {data.backups.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border border-dashed py-8 text-center text-sm">
            {data.plan
              ? 'Aucune sauvegarde pour l’instant.'
              : 'Sauvegarde non configurée pour cet environnement.'}
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {data.backups.map((backup) => (
              <BackupRow
                key={backup.id}
                project={project}
                envId={envId}
                envName={envName}
                backup={backup}
                isAdmin={can.isAdmin}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function PlanSummary({ plan }: { plan: BackupPlanView | null }) {
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="text-base">Sauvegarde automatique</CardTitle>
        <CardDescription>
          {!plan
            ? 'Non configurée. Un administrateur peut l’activer.'
            : plan.enabled
              ? `${scheduleLabel(plan.schedule)} vers « ${plan.destination?.name} », ${plan.keep} conservées`
              : `Désactivée : sauvegardes à la demande vers « ${plan.destination?.name} »`}
        </CardDescription>
      </CardHeader>
      {plan?.nextRunAt && (
        <CardContent className="text-muted-foreground text-xs">
          Prochaine : {formatDateTime(plan.nextRunAt)}
        </CardContent>
      )}
    </Card>
  )
}

function PlanForm({
  project,
  envId,
  page,
}: {
  project: ProjectView
  envId: string
  page: BackupEnvironmentPage
}) {
  const queryClient = useQueryClient()
  const plan = page.plan
  const destinations = useQuery({
    queryKey: ['backup-destinations', 'choices'],
    queryFn: api.backupDestinations.choices,
  })
  const [destinationId, setDestinationId] = useState(plan?.destination?.id ?? '')
  const [enabled, setEnabled] = useState(plan?.enabled ?? true)
  const [schedule, setSchedule] = useState<BackupSchedule>(
    plan?.schedule ?? DEFAULT_BACKUP_SCHEDULE,
  )
  const [keep, setKeep] = useState(String(plan?.keep ?? DEFAULT_BACKUP_KEEP))
  const [selection, setSelection] = useState<Record<string, boolean>>(plan?.selection ?? {})
  const chosen = destinationId || destinations.data?.[0]?.id || ''

  const save = useMutation({
    mutationFn: () =>
      api.backups.savePlan(project.id, envId, {
        enabled,
        destinationId: chosen,
        schedule,
        keep: Number(keep),
        selection,
      }),
    onSuccess: async () => {
      toast.success('Sauvegarde enregistrée')
      await queryClient.invalidateQueries({ queryKey: ['backups', envId] })
    },
    onError: (error) => toast.error(error.message),
  })
  const remove = useMutation({
    mutationFn: () => api.backups.removePlan(project.id, envId),
    onSuccess: async () => {
      toast.success('Sauvegarde désactivée')
      await queryClient.invalidateQueries({ queryKey: ['backups', envId] })
    },
    onError: (error) => toast.error(error.message),
  })

  const included = page.candidates.filter((item) => isBackupItemIncluded(item, selection))

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="text-base">Sauvegarde de l’environnement</CardTitle>
        <CardDescription>
          {plan?.nextRunAt
            ? `Prochaine : ${formatDateTime(plan.nextRunAt)}`
            : 'Bases de données (export) et volumes Docker (archive).'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {destinations.data?.length === 0 ? (
          <p className="text-sm">
            Ajoutez d’abord une destination (bucket S3 ou dossier) dans{' '}
            <Link to="/parametres" hash="sauvegardes" className="underline underline-offset-4">
              Paramètres → Sauvegardes
            </Link>
            .
          </p>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="bk-destination">Destination</Label>
              <Select value={chosen} onValueChange={setDestinationId}>
                <SelectTrigger id="bk-destination" className="w-full">
                  <SelectValue placeholder="Choisir…" />
                </SelectTrigger>
                <SelectContent>
                  {destinations.data?.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.name}
                      {item.encrypted ? ' · chiffrée' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                <Link to="/parametres" hash="sauvegardes" className="hover:underline">
                  Gérer les destinations
                </Link>
              </p>
            </div>

            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="bk-enabled">Automatique</Label>
              <Switch id="bk-enabled" checked={enabled} onCheckedChange={setEnabled} />
            </div>
            {enabled && <ScheduleFields schedule={schedule} onChange={setSchedule} />}
            <div className="flex items-center gap-2 text-sm">
              <Label htmlFor="bk-keep" className="font-normal">
                Garder les
              </Label>
              <Input
                id="bk-keep"
                type="number"
                className="w-20"
                min={1}
                max={365}
                value={keep}
                onChange={(e) => setKeep(e.target.value)}
              />
              dernières
            </div>

            <fieldset className="space-y-2">
              <legend className="mb-2 text-sm font-medium">
                À sauvegarder ({included.length}/{page.candidates.length})
              </legend>
              {page.dockerError && <p className="text-destructive text-xs">{page.dockerError}</p>}
              {page.candidates.length === 0 && !page.dockerError && (
                <p className="text-muted-foreground text-xs">
                  Aucun volume ni base détecté : l’environnement est-il démarré ? Les dossiers de
                  l’hôte (bind mounts) ne sont pas sauvegardés.
                </p>
              )}
              {page.candidates.map((item) => (
                <CandidateRow
                  key={item.key}
                  item={item}
                  checked={isBackupItemIncluded(item, selection)}
                  onChange={(value) =>
                    setSelection((current) => ({ ...current, [item.key]: value }))
                  }
                />
              ))}
            </fieldset>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => save.mutate()} disabled={save.isPending || !chosen}>
                {save.isPending && <Loader2 className="animate-spin" />}
                Enregistrer
              </Button>
              {plan && (
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  onClick={() => remove.mutate()}
                  disabled={remove.isPending}
                >
                  Ne plus sauvegarder
                </Button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** Fréquence : chaque jour à une heure donnée, ou toutes les N heures. */
export function ScheduleFields({
  schedule,
  onChange,
}: {
  schedule: BackupSchedule
  onChange: (schedule: BackupSchedule) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Select
        value={schedule.kind}
        onValueChange={(kind) =>
          onChange(kind === 'daily' ? DEFAULT_BACKUP_SCHEDULE : { kind: 'interval', hours: 6 })
        }
      >
        <SelectTrigger className="w-40" aria-label="Fréquence">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="daily">Chaque jour à</SelectItem>
          <SelectItem value="interval">Toutes les</SelectItem>
        </SelectContent>
      </Select>
      {schedule.kind === 'daily' ? (
        <>
          <Input
            type="time"
            aria-label="Heure"
            className="w-32"
            value={schedule.time}
            onChange={(e) => e.target.value && onChange({ kind: 'daily', time: e.target.value })}
          />
          {/* Fuseau du serveur (variable TZ), pas celui du navigateur. */}
          <span className="text-muted-foreground text-xs">heure du serveur</span>
        </>
      ) : (
        <>
          <Input
            type="number"
            aria-label="Heures"
            className="w-20"
            min={1}
            max={168}
            value={schedule.hours}
            onChange={(e) => onChange({ kind: 'interval', hours: Number(e.target.value) || 1 })}
          />
          heures
        </>
      )}
    </div>
  )
}

function CandidateRow({
  item,
  checked,
  onChange,
}: {
  item: BackupCandidate
  checked: boolean
  onChange: (value: boolean) => void
}) {
  const id = `bk-${item.key}`
  return (
    <div className="flex items-start gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      <div className="min-w-0 space-y-0.5">
        <Label htmlFor={id} className="flex items-center gap-1.5 font-normal">
          {item.kind === 'database' ? (
            <Database className="size-3.5" />
          ) : (
            <HardDrive className="size-3.5" />
          )}
          <span className="truncate">
            {item.kind === 'database'
              ? `Base ${item.name} (${DATABASE_ENGINE_LABELS[item.engine!]})`
              : item.name}
          </span>
        </Label>
        <p className="text-muted-foreground text-xs">
          {item.kind === 'database'
            ? 'Export complet, cohérent, sans arrêt du service'
            : item.coveredBy
              ? `Fichiers de la base ${item.coveredBy}, déjà exportée : une copie à chaud peut être incohérente`
              : `Volume de ${item.services.join(', ')}`}
        </p>
      </div>
    </div>
  )
}

function BackupRow({
  project,
  envId,
  envName,
  backup,
  isAdmin,
}: {
  project: ProjectView
  envId: string
  envName: string
  backup: BackupView
  isAdmin: boolean
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const status = STATUS[backup.status]
  const ok = backup.items.filter((item) => item.status === 'ok')
  const detail = useQuery({
    queryKey: ['backups', envId, backup.id],
    queryFn: () => api.backups.detail(project.id, envId, backup.id),
    enabled: open,
    refetchInterval:
      open && (backup.status === 'running' || backup.lastRestore?.status === 'running')
        ? 2000
        : false,
  })
  const remove = useMutation({
    mutationFn: () => api.backups.remove(project.id, envId, backup.id),
    onSuccess: async () => {
      setDeleting(false)
      toast.success('Sauvegarde supprimée')
      await queryClient.invalidateQueries({ queryKey: ['backups', envId] })
    },
    onError: (error) => toast.error(error.message),
  })
  const restore = backup.lastRestore

  return (
    <li className="text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex min-w-0 flex-1 basis-60 items-center gap-3 text-left"
          aria-expanded={open}
        >
          <span className={cn('size-2 shrink-0 rounded-full', status.dot)} aria-hidden />
          <span className="min-w-0">
            <span className="block truncate font-medium" title={formatDateTime(backup.startedAt)}>
              {formatDateTime(backup.startedAt)}
              <span className="text-muted-foreground font-normal">
                {' '}
                · {formatRelative(backup.startedAt)}
              </span>
            </span>
            <span className="text-muted-foreground block truncate text-xs">
              <span className={status.text}>{status.label}</span>
              {backup.status !== 'running' && ` · ${formatBytes(backup.sizeBytes)}`}
              {` · ${ok.length} élément${ok.length > 1 ? 's' : ''}`}
              {backup.trigger === 'schedule' ? ' · planifiée' : ` · par ${backup.username ?? '?'}`}
              {backup.destination && ` · ${backup.destination.name}`}
            </span>
          </span>
          {backup.encrypted && (
            <KeyRound className="text-muted-foreground size-3.5 shrink-0" aria-label="Chiffrée" />
          )}
          <ChevronDown
            className={cn('text-muted-foreground ml-auto size-4 shrink-0', open && 'rotate-180')}
          />
        </button>
        {isAdmin && backup.status !== 'running' && (
          <div className="flex shrink-0 items-center">
            {ok.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                onClick={() => setRestoring(true)}
                disabled={restore?.status === 'running'}
              >
                {restore?.status === 'running' ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <RotateCcw />
                )}
                Restaurer
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              className="text-muted-foreground hover:text-destructive size-7"
              aria-label="Supprimer la sauvegarde"
              onClick={() => setDeleting(true)}
            >
              <Trash2 />
            </Button>
          </div>
        )}
      </div>
      {backup.error && backup.status !== 'running' && (
        <p className="text-destructive px-3 pb-2 pl-8 text-xs">{backup.error}</p>
      )}
      {restore && (
        <p
          className={cn(
            'px-3 pb-2 pl-8 text-xs',
            restore.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {restore.status === 'running'
            ? 'Restauration en cours…'
            : restore.status === 'succeeded'
              ? `Restaurée ${formatRelative(restore.finishedAt ?? restore.startedAt)} par ${restore.username ?? '?'}`
              : `Restauration échouée : ${restore.error}`}
        </p>
      )}
      {open && (
        <div className="bg-muted/30 space-y-3 border-t px-3 py-3 pl-8">
          <ul className="space-y-1">
            {backup.items.map((item) => (
              <li key={item.key} className="flex flex-wrap items-center gap-2 text-xs">
                {item.kind === 'database' ? (
                  <Database className="size-3.5" />
                ) : (
                  <HardDrive className="size-3.5" />
                )}
                <span className="font-medium">
                  {item.kind === 'database' ? `Base ${item.name}` : item.name}
                </span>
                {item.status === 'ok' ? (
                  <span className="text-muted-foreground">{formatBytes(item.sizeBytes)}</span>
                ) : (
                  <span className="text-destructive">{item.error ?? 'en échec'}</span>
                )}
                {isAdmin && item.status === 'ok' && (
                  <a
                    href={api.backups.downloadUrl(project.id, envId, backup.id, item.key)}
                    className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 underline-offset-4 hover:underline"
                  >
                    <Download className="size-3" />
                    Télécharger
                  </a>
                )}
              </li>
            ))}
          </ul>
          {detail.data && (
            <>
              <Journal title="Journal" lines={detail.data.logs} />
              {detail.data.restoreLogs.length > 0 && (
                <Journal title="Dernière restauration" lines={detail.data.restoreLogs} />
              )}
            </>
          )}
          <p className="text-muted-foreground font-mono text-[11px] break-all">{backup.location}</p>
        </div>
      )}
      {restoring && (
        <RestoreDialog
          project={project}
          envId={envId}
          envName={envName}
          backup={backup}
          onClose={() => setRestoring(false)}
        />
      )}
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer cette sauvegarde ?</DialogTitle>
            <DialogDescription>
              Les fichiers du {formatDateTime(backup.startedAt)} sont effacés de la destination.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
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
    </li>
  )
}

function Journal({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium">{title}</p>
      <pre className="bg-background max-h-56 overflow-auto rounded-md border p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {lines
          .map((line) => {
            const [at, ...rest] = line.split(' ')
            const time = new Date(at!)
            return Number.isNaN(time.getTime())
              ? line
              : `${time.toLocaleTimeString('fr-FR')}  ${rest.join(' ')}`
          })
          .join('\n')}
      </pre>
    </div>
  )
}

function RestoreDialog({
  project,
  envId,
  envName,
  backup,
  onClose,
}: {
  project: ProjectView
  envId: string
  envName: string
  backup: BackupView
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const available = backup.items.filter((item) => item.status === 'ok')
  const [items, setItems] = useState(() => new Set(available.map((item) => item.key)))
  const [confirm, setConfirm] = useState('')
  const restore = useMutation({
    mutationFn: () =>
      api.backups.restore(project.id, envId, backup.id, { items: [...items], confirm }),
    onSuccess: async () => {
      toast.success('Restauration lancée')
      await queryClient.invalidateQueries({ queryKey: ['backups', envId] })
      onClose()
    },
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Restaurer la sauvegarde du {formatDateTime(backup.startedAt)}</DialogTitle>
          <DialogDescription>
            Les données actuelles de {project.name} / {envName} sont <strong>remplacées</strong> :
            tout ce qui a changé depuis cette date est perdu. L’application est arrêtée pendant
            l’opération puis relancée ; les bases restent en marche pour l’import.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {available.map((item) => (
            <div key={item.key} className="flex items-center gap-2">
              <Checkbox
                id={`rs-${item.key}`}
                checked={items.has(item.key)}
                onCheckedChange={(value) =>
                  setItems((current) => {
                    const next = new Set(current)
                    if (value === true) next.add(item.key)
                    else next.delete(item.key)
                    return next
                  })
                }
              />
              <Label htmlFor={`rs-${item.key}`} className="font-normal">
                {item.kind === 'database' ? `Base ${item.name}` : `Volume ${item.name}`}
                <span className="text-muted-foreground"> · {formatBytes(item.sizeBytes)}</span>
              </Label>
            </div>
          ))}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rs-confirm">
            Tapez <span className="font-mono">{project.name}</span> pour confirmer
          </Label>
          <Input
            id="rs-confirm"
            autoComplete="off"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>
        {restore.error && <p className="text-destructive text-sm">{restore.error.message}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button
            variant="destructive"
            onClick={() => restore.mutate()}
            disabled={restore.isPending || confirm.trim() !== project.name || items.size === 0}
          >
            {restore.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            Restaurer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
