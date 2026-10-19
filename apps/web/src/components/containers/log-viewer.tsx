import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, Pause, Play, RotateCw, Search } from 'lucide-react'
import type { ContainerLogEvent, ContainerLogLine } from '@vercio/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { cn } from '@/lib/utils'

const ALL = '__all__'
const MAX_LINES = 5000

export type StreamState = 'connecting' | 'live' | 'ended' | 'error'

/** Logs en direct d'un environnement (SSE). À monter à nouveau pour changer de filtre. */
export function useContainerLogs(
  projectId: string,
  envId: string,
  service: string | null,
  tail = 300,
) {
  const [lines, setLines] = useState<(ContainerLogLine & { id: number })[]>([])
  const [state, setState] = useState<StreamState>('connecting')

  useEffect(() => {
    let counter = 0
    const source = new EventSource(api.containers.logsUrl(projectId, envId, service, tail))
    source.onopen = () => setState('live')
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as ContainerLogEvent
      if (event.type !== 'log') return
      const line = { ...event.log, id: counter++ }
      setLines((current) => {
        const next = current.length >= MAX_LINES ? current.slice(-MAX_LINES + 1) : [...current]
        // L'historique arrive conteneur par conteneur : chaque ligne est rangée à son heure.
        let index = next.length
        while (index > 0 && line.at && next[index - 1]!.at && next[index - 1]!.at! > line.at) {
          index--
        }
        next.splice(index, 0, line)
        return next
      })
    }
    // Le serveur ferme le flux quand tous les conteneurs suivis sont arrêtés ou recréés.
    source.onerror = () => {
      source.close()
      setState((current) => (current === 'connecting' ? 'error' : 'ended'))
    }
    return () => source.close()
  }, [projectId, envId, service, tail])

  return { lines, state }
}

const SERVICE_COLORS = [
  'text-sky-300',
  'text-violet-300',
  'text-emerald-300',
  'text-amber-300',
  'text-pink-300',
  'text-teal-300',
]

function colorFor(service: string) {
  let hash = 0
  for (const char of service) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return SERVICE_COLORS[hash % SERVICE_COLORS.length]
}

/** Ligne qui ressemble à une erreur : mise en évidence et filtre « erreurs seulement ». */
const ERROR_PATTERN = /\b(error|erreur|fatal|exception|panic|failed|traceback|critical)\b/i

/**
 * Logs en direct d'un environnement, avec filtre par service, recherche, pause et
 * téléchargement. Changer de service remonte le flux (clé du composant parent ou `service`).
 */
export function LogViewer({
  projectId,
  envId,
  service,
  services,
  onServiceChange,
  downloadName,
  className,
}: {
  projectId: string
  envId: string
  service: string | null
  /** Services proposés dans le filtre ; absent : pas de filtre. */
  services?: string[]
  onServiceChange?: (service: string | null) => void
  downloadName: string
  className?: string
}) {
  const [session, setSession] = useState(0)
  return (
    <LogStream
      key={`${envId}-${service}-${session}`}
      projectId={projectId}
      envId={envId}
      service={service}
      services={services}
      onServiceChange={onServiceChange}
      onReconnect={() => setSession((value) => value + 1)}
      downloadName={downloadName}
      className={className}
    />
  )
}

function LogStream({
  projectId,
  envId,
  service,
  services,
  onServiceChange,
  onReconnect,
  downloadName,
  className,
}: {
  projectId: string
  envId: string
  service: string | null
  services?: string[]
  onServiceChange?: (service: string | null) => void
  onReconnect: () => void
  downloadName: string
  className?: string
}) {
  const { lines, state } = useContainerLogs(projectId, envId, service)
  const [search, setSearch] = useState('')
  const [errorsOnly, setErrorsOnly] = useState(false)
  const [paused, setPaused] = useState<typeof lines | null>(null)
  const [timestamps, setTimestamps] = useState(true)
  const container = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)

  const shown = paused ?? lines
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return shown.filter(
      (line) =>
        (!needle || line.line.toLowerCase().includes(needle)) &&
        (!errorsOnly || line.stream === 'stderr' || ERROR_PATTERN.test(line.line)),
    )
  }, [shown, search, errorsOnly])

  useEffect(() => {
    if (follow && container.current) container.current.scrollTop = container.current.scrollHeight
  }, [filtered, follow])

  const download = () => {
    const text = lines
      .map((line) => `${line.at ?? ''} ${line.service} ${line.stream} ${line.line}`.trim())
      .join('\n')
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `${downloadName}-${service ?? 'tous'}.log`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className={cn('flex min-h-0 flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center gap-2">
        {services && onServiceChange && (
          <Select
            value={service ?? ALL}
            onValueChange={(value) => onServiceChange(value === ALL ? null : value)}
          >
            <SelectTrigger className="w-full sm:w-44" aria-label="Service">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tous les services</SelectItem>
              {services.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="relative min-w-40 flex-1">
          <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
          <Input
            aria-label="Rechercher dans les logs"
            placeholder="Rechercher…"
            className="pl-8"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <StreamBadge state={state} paused={Boolean(paused)} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <Switch id={`errors-${envId}`} checked={errorsOnly} onCheckedChange={setErrorsOnly} />
          <Label htmlFor={`errors-${envId}`} className="text-sm font-normal">
            Erreurs seulement
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id={`time-${envId}`} checked={timestamps} onCheckedChange={setTimestamps} />
          <Label htmlFor={`time-${envId}`} className="text-sm font-normal">
            Heure
          </Label>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPaused(paused ? null : lines)}
            disabled={state !== 'live' && !paused}
          >
            {paused ? <Play /> : <Pause />}
            {paused ? 'Reprendre' : 'Pause'}
          </Button>
          <Button variant="outline" size="sm" onClick={download} disabled={!lines.length}>
            <Download />
            Télécharger
          </Button>
          {(state === 'ended' || state === 'error') && (
            <Button variant="outline" size="sm" onClick={onReconnect}>
              <RotateCw />
              Reconnecter
            </Button>
          )}
        </div>
      </div>
      <div
        ref={container}
        role="log"
        aria-label="Logs des conteneurs"
        onScroll={(event) => {
          const el = event.currentTarget
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
        }}
        className="min-h-48 flex-1 overflow-auto rounded-lg border bg-zinc-950 p-3 font-mono text-xs leading-relaxed text-zinc-200"
      >
        {filtered.length === 0 && (
          <p className="text-zinc-500">
            {state === 'connecting'
              ? 'Connexion…'
              : search || errorsOnly
                ? 'Aucune ligne ne correspond au filtre.'
                : state === 'error'
                  ? 'Logs indisponibles.'
                  : 'Aucune ligne pour le moment.'}
          </p>
        )}
        {filtered.map((line) => (
          <div key={line.id} className="flex gap-3 whitespace-pre-wrap">
            {timestamps && (
              <span className="shrink-0 text-zinc-500 select-none">
                {line.at ? new Date(line.at).toLocaleTimeString('fr-FR') : '--:--:--'}
              </span>
            )}
            {!service && (
              <span className={cn('w-20 shrink-0 truncate select-none', colorFor(line.service))}>
                {line.service}
              </span>
            )}
            <span
              className={cn(
                'min-w-0 break-all',
                line.stream === 'stderr' && 'text-amber-300',
                ERROR_PATTERN.test(line.line) && 'text-red-300',
              )}
            >
              {line.line}
            </span>
          </div>
        ))}
      </div>
      {state === 'ended' && (
        <p className="text-muted-foreground text-xs">
          Flux terminé : les conteneurs ont été arrêtés ou recréés. Cliquez sur « Reconnecter ».
        </p>
      )}
    </div>
  )
}

export function StreamBadge({ state, paused }: { state: StreamState; paused: boolean }) {
  if (paused) return <Badge variant="outline">En pause</Badge>
  if (state === 'live') {
    return (
      <Badge variant="outline" className="text-success gap-1.5">
        <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
        En direct
      </Badge>
    )
  }
  if (state === 'connecting') return <Badge variant="outline">Connexion…</Badge>
  if (state === 'error') {
    return (
      <Badge variant="outline" className="text-destructive">
        Erreur
      </Badge>
    )
  }
  return <Badge variant="outline">Terminé</Badge>
}
