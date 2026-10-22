import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowUpCircle, Check, ExternalLink, Loader2, RefreshCw } from 'lucide-react'
import type { UpdatePhase, UpdateStatus } from '@vercio/shared'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SidebarMenuButton } from '@/components/ui/sidebar'
import { api } from '@/lib/api'
import { formatDateTime, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

export const UPDATE_RUNNING: UpdatePhase[] = ['backup', 'starting', 'pulling', 'restarting']
const RUNNING = UPDATE_RUNNING

/** État des mises à jour ; interrogé souvent pendant une mise à jour, rarement sinon. */
export function useUpdateStatus() {
  return useQuery({
    queryKey: ['system', 'update'],
    queryFn: api.system.update,
    staleTime: 10 * 60_000,
    refetchInterval: (query) =>
      query.state.data?.run && RUNNING.includes(query.state.data.run.phase) ? 2000 : 30 * 60_000,
    retry: false,
  })
}

/** Bas de la barre latérale : nouvelle version disponible. */
export function UpdateNotice({ onOpen }: { onOpen: () => void }) {
  const status = useUpdateStatus()
  if (!status.data?.available) return null
  return (
    <SidebarMenuButton
      onClick={onOpen}
      tooltip={`Vercio ${status.data.latest!.version} disponible`}
      className="text-primary hover:text-primary bg-primary/10 hover:bg-primary/15"
    >
      <ArrowUpCircle />
      <span>Vercio {status.data.latest!.version} disponible</span>
    </SidebarMenuButton>
  )
}

/** Version, nouveautés et mise à jour en un clic (administrateurs). */
export function UpdateDialog({ isAdmin, onClose }: { isAdmin: boolean; onClose: () => void }) {
  const queryClient = useQueryClient()
  const status = useUpdateStatus()
  const check = useMutation({
    mutationFn: api.system.checkUpdate,
    onSuccess: (data) => queryClient.setQueryData(['system', 'update'], data),
  })
  const start = useMutation({
    mutationFn: (version: string) => api.system.startUpdate(version),
    onSuccess: (data) => queryClient.setQueryData(['system', 'update'], data),
  })
  const data = status.data
  const run = data?.run
  if (run && RUNNING.includes(run.phase)) return <UpdateProgress status={data!} />

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {data?.available ? `Vercio ${data.latest!.version} est disponible` : 'Vercio'}
          </DialogTitle>
          <DialogDescription>
            Version en service : <span className="font-mono">{data?.current ?? '…'}</span>
            {data?.checkedAt && <> · vérifié {formatRelative(data.checkedAt)}</>}
          </DialogDescription>
        </DialogHeader>

        {run?.phase === 'done' && run.finishedAt && (
          <Alert>
            <Check className="text-success" />
            <AlertDescription>
              Mis à jour de {run.from} vers {run.to} le {formatDateTime(run.finishedAt)}.
            </AlertDescription>
          </Alert>
        )}
        {(run?.phase === 'failed' || run?.phase === 'rolled_back') && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription>
              {run.phase === 'rolled_back'
                ? `La mise à jour vers ${run.to} a échoué : la version ${run.from} a été remise en place.`
                : `La mise à jour vers ${run.to} a échoué.`}{' '}
              {run.message}
              {run.backup && <> Sauvegarde faite avant : {run.backup}.</>}
            </AlertDescription>
          </Alert>
        )}
        {data?.error && (
          <p className="text-destructive text-sm">Vérification impossible : {data.error}</p>
        )}

        {data?.available && data.latest && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="font-medium">Nouveautés</span>
              <a
                href={data.latest.url}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
              >
                Voir sur GitHub
                <ExternalLink className="size-3" />
              </a>
            </div>
            <ReleaseNotes notes={data.latest.notes} />
          </div>
        )}
        {data && !data.available && !data.error && (
          <p className="text-muted-foreground text-sm">Vous avez la dernière version.</p>
        )}

        {data?.available && isAdmin && !data.canUpdate && (
          <div className="text-muted-foreground space-y-1 text-xs">
            <p>Mise à jour depuis l’interface impossible : {data.reason}.</p>
            <p>
              Sur le serveur, dans le dossier de Vercio :{' '}
              <code className="text-foreground">docker compose pull && docker compose up -d</code>
            </p>
          </div>
        )}
        {data?.available && isAdmin && data.canUpdate && (
          <p className="text-muted-foreground text-xs">
            Vercio sauvegarde d’abord sa base, puis redémarre sur la nouvelle version (moins d’une
            minute, les sites ne sont pas arrêtés). Si elle ne démarre pas, l’ancienne est remise en
            place.
          </p>
        )}
        {data?.available && !isAdmin && (
          <p className="text-muted-foreground text-xs">
            Un administrateur peut faire la mise à jour.
          </p>
        )}
        {start.error && <p className="text-destructive text-sm">{start.error.message}</p>}

        <DialogFooter>
          {isAdmin && (
            <Button
              variant="ghost"
              onClick={() => check.mutate()}
              disabled={check.isPending}
              className="sm:mr-auto"
            >
              <RefreshCw className={cn(check.isPending && 'animate-spin')} />
              Vérifier maintenant
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Fermer
          </Button>
          {data?.available && isAdmin && data.canUpdate && (
            <Button onClick={() => start.mutate(data.latest!.version)} disabled={start.isPending}>
              {start.isPending ? <Loader2 className="animate-spin" /> : <ArrowUpCircle />}
              Mettre à jour vers {data.latest!.version}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const STEPS: { phase: UpdatePhase; label: string }[] = [
  { phase: 'backup', label: 'Sauvegarde de la base de Vercio' },
  { phase: 'pulling', label: 'Téléchargement de la nouvelle version' },
  { phase: 'restarting', label: 'Redémarrage de Vercio' },
]

/**
 * Pendant la mise à jour : étapes, puis attente du redémarrage. La page se recharge dès que
 * la nouvelle version répond.
 */
function UpdateProgress({ status }: { status: UpdateStatus }) {
  const run = status.run!
  const health = useQuery({
    queryKey: ['health', 'update'],
    queryFn: api.health,
    refetchInterval: 2000,
    retry: false,
  })
  const updated = health.data?.version === run.to
  useEffect(() => {
    if (!updated) return
    const timer = window.setTimeout(() => window.location.reload(), 1500)
    return () => window.clearTimeout(timer)
  }, [updated])
  // Le serveur ne répond plus : il est en train d'être remplacé.
  const phase: UpdatePhase = updated ? 'done' : health.isError ? 'restarting' : run.phase
  const index = phase === 'starting' ? 1 : STEPS.findIndex((step) => step.phase === phase)

  return (
    <Dialog open>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {updated ? `Vercio ${run.to} est en service` : `Mise à jour vers ${run.to}…`}
          </DialogTitle>
          <DialogDescription>
            {updated
              ? 'Rechargement de la page…'
              : 'Ne fermez pas cette page : elle se rechargera toute seule.'}
          </DialogDescription>
        </DialogHeader>
        <ol className="space-y-2 text-sm">
          {STEPS.map((step, position) => {
            const done = updated || position < index
            const current = !updated && position === index
            return (
              <li key={step.phase} className="flex items-center gap-2">
                {done ? (
                  <Check className="text-success size-4" />
                ) : current ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <span className="border-muted-foreground/40 size-4 rounded-full border" />
                )}
                <span className={cn(!done && !current && 'text-muted-foreground')}>
                  {step.label}
                </span>
              </li>
            )
          })}
        </ol>
      </DialogContent>
    </Dialog>
  )
}

/** Notes de version : titres, listes et `code` du changelog, sans dépendance Markdown. */
function ReleaseNotes({ notes }: { notes: string }) {
  const blocks = notes.split('\n').filter((line) => line.trim())
  if (!blocks.length) return null
  return (
    <div className="bg-muted/40 max-h-72 space-y-1 overflow-y-auto rounded-md border p-3 text-sm">
      {blocks.map((line, index) => {
        const heading = /^#{1,4}\s+(.*)$/.exec(line)
        if (heading) {
          return (
            <p key={index} className="pt-1 font-medium first:pt-0">
              {inline(heading[1]!)}
            </p>
          )
        }
        const item = /^\s*[-*]\s+(.*)$/.exec(line)
        if (item) {
          return (
            <p key={index} className="text-muted-foreground flex gap-2">
              <span aria-hidden>•</span>
              <span>{inline(item[1]!)}</span>
            </p>
          )
        }
        return (
          <p key={index} className="text-muted-foreground">
            {inline(line)}
          </p>
        )
      })}
    </div>
  )
}

function inline(text: string) {
  return text.split(/(`[^`]+`)/).map((part, index) =>
    part.startsWith('`') && part.endsWith('`') ? (
      <code key={index} className="text-foreground text-xs">
        {part.slice(1, -1)}
      </code>
    ) : (
      part.replace(/\*\*([^*]+)\*\*/g, '$1')
    ),
  )
}
