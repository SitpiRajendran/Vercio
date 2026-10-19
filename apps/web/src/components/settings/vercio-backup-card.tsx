import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { DatabaseBackup, Download, KeyRound, Loader2, Play, RotateCcw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  type BackupPlanView,
  type BackupSchedule,
  type BackupView,
  type VercioRestoreState,
} from '@vercio/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { formatBytes, formatDateTime, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { ScheduleFields } from '@/pages/projects/backups-tab'

const KEY = ['settings', 'vercio-backup'] as const

const STATUS = {
  running: { label: 'En cours', className: 'text-warning' },
  succeeded: { label: 'Réussie', className: 'text-success' },
  partial: { label: 'Incomplète', className: 'text-warning' },
  failed: { label: 'Échouée', className: 'text-destructive' },
} as const

/**
 * Sauvegarde de la base de Vercio : projets, comptes, réglages, secrets (chiffrés par
 * VERCIO_SECRET_KEY) et historique.
 */
export function VercioBackupCard() {
  const queryClient = useQueryClient()
  const page = useQuery({
    queryKey: KEY,
    queryFn: api.vercioBackup.page,
    refetchInterval: (query) =>
      query.state.data?.backups.some((item) => item.status === 'running') ? 2000 : false,
  })
  const run = useMutation({
    mutationFn: api.vercioBackup.run,
    onSuccess: async () => {
      toast.success('Sauvegarde de Vercio lancée')
      await queryClient.invalidateQueries({ queryKey: KEY })
    },
    onError: (error) => toast.error(error.message),
  })
  const running = page.data?.backups.some((item) => item.status === 'running')
  // Restauration lancée : Vercio va redémarrer ; on attend son retour.
  const [restarting, setRestarting] = useState<string | null>(null)
  const restoreState = page.data?.restore ?? null
  if (restarting || restoreState?.status === 'running') {
    return <RestoreProgress state={restoreState} startedAt={restarting} />
  }

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DatabaseBackup className="size-4" />
          Sauvegarde de Vercio
        </CardTitle>
        <CardDescription>
          La base de Vercio : projets, environnements, variables, comptes, réglages et historique.
          Les secrets y restent chiffrés par <code>VERCIO_SECRET_KEY</code> : gardez cette clé hors
          du serveur, elle est indispensable pour restaurer.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        {page.data && <PlanForm key={JSON.stringify(page.data.plan)} plan={page.data.plan} />}
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium">Dernières sauvegardes</p>
            {page.data?.plan && (
              <Button size="sm" onClick={() => run.mutate()} disabled={run.isPending || running}>
                {run.isPending || running ? <Loader2 className="animate-spin" /> : <Play />}
                {running ? 'En cours…' : 'Sauvegarder maintenant'}
              </Button>
            )}
          </div>
          {page.data?.backups.length === 0 && (
            <p className="text-muted-foreground rounded-lg border border-dashed py-6 text-center text-sm">
              Aucune sauvegarde de Vercio.
            </p>
          )}
          {!!page.data?.backups.length && (
            <ul className="divide-y rounded-lg border">
              {page.data.backups.map((backup) => (
                <BackupLine key={backup.id} backup={backup} onRestore={setRestarting} />
              ))}
            </ul>
          )}
          {restoreState?.status === 'failed' && (
            <div className="border-destructive/40 text-destructive rounded-lg border p-3 text-xs">
              <p className="font-medium">Restauration échouée : {restoreState.error}</p>
              <p className="text-muted-foreground mt-1">La base de Vercio n’a pas été modifiée.</p>
            </div>
          )}
          <details className="text-muted-foreground text-xs">
            <summary className="cursor-pointer">
              Restaurer à la main (si Vercio ne démarre plus)
            </summary>
            <ol className="mt-2 list-decimal space-y-1 pl-4">
              <li>
                Téléchargez la sauvegarde (déjà déchiffrée) : <code>vercio-…-vercio.sql.gz</code>.
              </li>
              <li>
                Sur le serveur, à côté du <code>docker-compose.yml</code> (même{' '}
                <code>VERCIO_SECRET_KEY</code> dans le <code>.env</code>) :{' '}
                <code>docker compose stop vercio</code>
              </li>
              <li>
                <code>
                  gunzip -c vercio-…-vercio.sql.gz | docker compose exec -T db psql -U vercio vercio
                </code>
              </li>
              <li>
                <code>docker compose start vercio</code>
              </li>
            </ol>
          </details>
        </div>
      </CardContent>
    </Card>
  )
}

function PlanForm({ plan }: { plan: BackupPlanView | null }) {
  const queryClient = useQueryClient()
  const destinations = useQuery({
    queryKey: ['backup-destinations', 'choices'],
    queryFn: api.backupDestinations.choices,
  })
  const [destinationId, setDestinationId] = useState(plan?.destination?.id ?? '')
  const [enabled, setEnabled] = useState(plan?.enabled ?? true)
  const [schedule, setSchedule] = useState<BackupSchedule>(
    plan?.schedule ?? { kind: 'daily', time: '02:30' },
  )
  const [keep, setKeep] = useState(String(plan?.keep ?? 14))
  const chosen = destinationId || destinations.data?.[0]?.id || ''
  const save = useMutation({
    mutationFn: () =>
      api.vercioBackup.savePlan({ enabled, destinationId: chosen, schedule, keep: Number(keep) }),
    onSuccess: async () => {
      toast.success('Sauvegarde de Vercio enregistrée')
      await queryClient.invalidateQueries({ queryKey: KEY })
      await queryClient.invalidateQueries({ queryKey: ['settings', 'backup-destinations'] })
    },
    onError: (error) => toast.error(error.message),
  })
  const remove = useMutation({
    mutationFn: api.vercioBackup.removePlan,
    onSuccess: async () => {
      toast.success('Sauvegarde de Vercio désactivée')
      await queryClient.invalidateQueries({ queryKey: KEY })
      await queryClient.invalidateQueries({ queryKey: ['settings', 'backup-destinations'] })
    },
  })

  if (destinations.data?.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Ajoutez d’abord une destination ci-dessous, de préférence hors de ce serveur.
      </p>
    )
  }
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="vb-destination">Destination</Label>
        <Select value={chosen} onValueChange={setDestinationId}>
          <SelectTrigger id="vb-destination" className="w-full">
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
      </div>
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="vb-enabled">Automatique</Label>
        <Switch id="vb-enabled" checked={enabled} onCheckedChange={setEnabled} />
      </div>
      {enabled && <ScheduleFields schedule={schedule} onChange={setSchedule} />}
      <div className="flex items-center gap-2 text-sm">
        <Label htmlFor="vb-keep" className="font-normal">
          Garder les
        </Label>
        <Input
          id="vb-keep"
          type="number"
          className="w-20"
          min={1}
          max={365}
          value={keep}
          onChange={(e) => setKeep(e.target.value)}
        />
        dernières
      </div>
      {plan?.nextRunAt && (
        <p className="text-muted-foreground text-xs">
          Prochaine : {formatDateTime(plan.nextRunAt)}
        </p>
      )}
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
    </div>
  )
}

function BackupLine({
  backup,
  onRestore,
}: {
  backup: BackupView
  /** Restauration acceptée : démarrage du processus actuel, pour voir le redémarrage. */
  onRestore: (startedAt: string) => void
}) {
  const queryClient = useQueryClient()
  const [restoring, setRestoring] = useState(false)
  const status = STATUS[backup.status]
  const ok = backup.items.some((item) => item.status === 'ok')
  const remove = useMutation({
    mutationFn: () => api.vercioBackup.remove(backup.id),
    onSuccess: async () => {
      toast.success('Sauvegarde supprimée')
      await queryClient.invalidateQueries({ queryKey: KEY })
    },
    onError: (error) => toast.error(error.message),
  })
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <p className="truncate" title={formatDateTime(backup.startedAt)}>
          {formatDateTime(backup.startedAt)}
          <span className="text-muted-foreground"> · {formatRelative(backup.startedAt)}</span>
        </p>
        <p className="text-muted-foreground truncate text-xs">
          <span className={status.className}>{status.label}</span>
          {backup.status !== 'running' && ok && ` · ${formatBytes(backup.sizeBytes)}`}
          {backup.trigger === 'schedule' ? ' · planifiée' : ` · par ${backup.username ?? '?'}`}
          {backup.destination && ` · ${backup.destination.name}`}
          {backup.error && <span className="text-destructive"> · {backup.error}</span>}
        </p>
      </div>
      {backup.encrypted && (
        <KeyRound className="text-muted-foreground size-3.5" aria-label="Chiffrée" />
      )}
      {ok && backup.status !== 'running' && (
        <Button size="sm" variant="outline" className="h-7" onClick={() => setRestoring(true)}>
          <RotateCcw />
          Restaurer
        </Button>
      )}
      {restoring && (
        <RestoreDialog backup={backup} onClose={() => setRestoring(false)} onStarted={onRestore} />
      )}
      {ok && (
        <Button size="sm" variant="ghost" className="h-7" asChild>
          <a href={api.vercioBackup.downloadUrl(backup.id)}>
            <Download />
            Télécharger
          </a>
        </Button>
      )}
      {backup.status !== 'running' && (
        <Button
          size="icon"
          variant="ghost"
          className={cn('text-muted-foreground hover:text-destructive size-7')}
          aria-label="Supprimer la sauvegarde"
          onClick={() => remove.mutate()}
          disabled={remove.isPending}
        >
          <Trash2 />
        </Button>
      )}
    </li>
  )
}

function RestoreDialog({
  backup,
  onClose,
  onStarted,
}: {
  backup: BackupView
  onClose: () => void
  onStarted: (startedAt: string) => void
}) {
  const queryClient = useQueryClient()
  const [confirm, setConfirm] = useState('')
  const restore = useMutation({
    mutationFn: async () => {
      // Démarrage actuel de Vercio : un autre, plus tard, signifie qu'il a redémarré.
      const { startedAt } = await api.health()
      await api.vercioBackup.restore(backup.id, confirm.trim())
      return startedAt ?? ''
    },
    onSuccess: async (startedAt) => {
      onClose()
      onStarted(startedAt)
      await queryClient.invalidateQueries({ queryKey: KEY })
    },
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Restaurer Vercio au {formatDateTime(backup.startedAt)} ?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2">
              <p>
                Toute la configuration de Vercio revient à cette date : projets, environnements,
                variables, comptes, connexions, réglages. Ce qui a changé depuis est perdu ;
                l’historique des sauvegardes est gardé.
              </p>
              <p>
                Vercio fait d’abord une <strong>sauvegarde de sécurité</strong> de l’état actuel
                (pour revenir en arrière), importe la base en une seule fois (en cas d’erreur, rien
                ne change), puis <strong>redémarre</strong> : reconnectez-vous ensuite. Les
                conteneurs de vos projets ne sont pas touchés.
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="vr-confirm">
            Tapez <span className="font-mono">vercio</span> pour confirmer
          </Label>
          <Input
            id="vr-confirm"
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
            disabled={restore.isPending || confirm.trim() !== 'vercio'}
          >
            {restore.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            Restaurer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Suivi de la restauration, puis attente du redémarrage avant de renvoyer à la connexion. */
function RestoreProgress({
  state,
  startedAt,
}: {
  state: VercioRestoreState | null
  startedAt: string | null
}) {
  const health = useQuery({
    queryKey: ['health', 'restart'],
    queryFn: api.health,
    refetchInterval: 2000,
    retry: false,
  })
  const back = !!startedAt && !!health.data?.startedAt && health.data.startedAt !== startedAt
  useEffect(() => {
    if (!back) return
    // Base remplacée : sessions et état repartent de la sauvegarde.
    const timer = window.setTimeout(() => window.location.assign('/connexion'), 1500)
    return () => window.clearTimeout(timer)
  }, [back])
  const lines = state?.logs ?? []
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {back ? (
            <RotateCcw className="text-success size-4" />
          ) : (
            <Loader2 className="size-4 animate-spin" />
          )}
          {back
            ? 'Vercio restauré : reconnexion…'
            : health.isError
              ? 'Vercio redémarre…'
              : 'Restauration de Vercio en cours…'}
        </CardTitle>
        <CardDescription>
          Ne fermez pas cette page. Elle vous renverra à la connexion dès que Vercio aura redémarré
          (quelques dizaines de secondes).
        </CardDescription>
      </CardHeader>
      {lines.length > 0 && (
        <CardContent>
          <pre className="bg-muted/40 max-h-56 overflow-auto rounded-md border p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {lines.map((line) => line.replace(/^\S+ /, '')).join('\n')}
          </pre>
        </CardContent>
      )}
    </Card>
  )
}
