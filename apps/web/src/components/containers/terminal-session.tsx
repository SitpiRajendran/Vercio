import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Loader2, RotateCw } from 'lucide-react'
import { TERMINAL_SHELLS, type TerminalServerMessage, type TerminalShell } from '@vercio/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api, ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { TerminalStatus, TerminalTab } from '@/components/workbench/workbench'

const SHELL_LABELS: Record<TerminalShell, string> = {
  auto: 'Shell automatique (bash, sinon sh)',
  bash: 'bash',
  sh: 'sh',
  ash: 'ash',
  zsh: 'zsh',
}

/**
 * Sessions du dock : toutes restent montées (le shell continue de tourner), seule
 * l'active est visible. Chargé à la demande avec xterm.js.
 */
export default function TerminalPanes({
  tabs,
  active,
  onStatus,
}: {
  tabs: TerminalTab[]
  active: string | null
  onStatus: (key: string, status: TerminalStatus) => void
}) {
  return (
    <>
      {tabs.map((tab) => (
        <TerminalPane
          key={tab.key}
          tab={tab}
          visible={tab.key === active}
          onStatus={(status) => onStatus(tab.key, status)}
        />
      ))}
    </>
  )
}

/** Cause d'un terminal refusé : session, rôle, conteneur, adresse de Vercio ou reverse proxy. */
async function diagnoseTerminal(projectId: string, envId: string, containerId: string) {
  let check: Awaited<ReturnType<typeof api.containers.terminalCheck>>
  try {
    check = await api.containers.terminalCheck(projectId, envId, containerId)
  } catch (error) {
    return error instanceof ApiError && error.status === 401
      ? 'Session expirée : reconnectez-vous.'
      : 'Vercio est injoignable.'
  }
  if (!check.allowed) return check.reason ?? 'Terminal refusé.'
  if (check.publicOrigin !== window.location.origin) {
    return `Vercio est configuré pour ${check.publicOrigin} (PUBLIC_URL) mais ouvert sur ${window.location.origin} : le terminal n’est accepté que depuis l’adresse configurée. Corrigez PUBLIC_URL dans .env, ou ouvrez Vercio par cette adresse.`
  }
  return 'Le reverse proxy bloque le terminal : il doit laisser passer les WebSockets (en-têtes Upgrade et Connection, voir l’exemple nginx du README).'
}

function TerminalPane({
  tab,
  visible,
  onStatus,
}: {
  tab: TerminalTab
  visible: boolean
  onStatus: (status: TerminalStatus) => void
}) {
  const [shell, setShell] = useState<TerminalShell>('auto')
  // Incrémenté pour ouvrir une nouvelle session.
  const [session, setSession] = useState(0)
  const [status, setStatus] = useState<TerminalStatus>({ state: 'connecting' })
  // `onStatus` ne dépend que de la clé de l'onglet : la première version suffit.
  const update = (next: TerminalStatus) => {
    setStatus(next)
    onStatus(next)
  }

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-2', !visible && 'hidden')}>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={shell}
          onValueChange={(value) => {
            setShell(value as TerminalShell)
            setSession((current) => current + 1)
          }}
        >
          <SelectTrigger size="sm" className="w-64" aria-label="Shell">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TERMINAL_SHELLS.map((name) => (
              <SelectItem key={name} value={name}>
                {SHELL_LABELS[name]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <StatusBadge status={status} />
        {(status.state === 'exited' || status.state === 'error') && (
          <Button variant="outline" size="sm" onClick={() => setSession((current) => current + 1)}>
            <RotateCw />
            Nouvelle session
          </Button>
        )}
        {status.state === 'error' && (
          <span className="text-destructive text-xs">{status.message}</span>
        )}
        <span className="text-muted-foreground ml-auto hidden text-xs sm:inline">
          Session journalisée (ouverture et fermeture, pas son contenu).
        </span>
      </div>
      <TerminalView
        key={`${shell}-${session}`}
        visible={visible}
        diagnose={() => diagnoseTerminal(tab.projectId, tab.envId, tab.container.id)}
        url={(cols, rows) =>
          api.containers.terminalUrl(tab.projectId, tab.envId, tab.container.id, {
            shell,
            cols,
            rows,
          })
        }
        onStatus={update}
      />
    </div>
  )
}

function StatusBadge({ status }: { status: TerminalStatus }) {
  if (status.state === 'connecting') {
    return (
      <Badge variant="outline">
        <Loader2 className="animate-spin" />
        Connexion…
      </Badge>
    )
  }
  if (status.state === 'open') {
    return (
      <Badge variant="outline" className="text-success">
        <span className="size-1.5 rounded-full bg-current" aria-hidden />
        Connecté
      </Badge>
    )
  }
  if (status.state === 'exited') {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        Session terminée{status.code !== null ? ` (code ${status.code})` : ''}
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="text-destructive">
      Erreur
    </Badge>
  )
}

function TerminalView({
  url,
  diagnose,
  visible,
  onStatus,
}: {
  url: (cols: number, rows: number) => string
  /** Raison d'une connexion refusée, que le navigateur ne donne pas. */
  diagnose: () => Promise<string>
  visible: boolean
  onStatus: (status: TerminalStatus) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<{ terminal: Terminal; fit: () => void } | null>(null)
  // Adresse lue à l'ouverture seulement : une nouvelle session passe par une nouvelle clé.
  const initial = useRef({ url, onStatus, diagnose })

  useEffect(() => {
    const { url, onStatus, diagnose } = initial.current
    const element = container.current
    if (!element) return
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: { background: '#09090b', foreground: '#e4e4e7', cursor: '#e4e4e7' },
    })
    const addon = new FitAddon()
    terminal.loadAddon(addon)
    terminal.open(element)
    // Un onglet masqué n'a pas de taille : on ne l'ajuste qu'une fois visible.
    const fit = () => {
      if (element.offsetWidth === 0 || element.offsetHeight === 0) return
      try {
        addon.fit()
      } catch {
        // Panneau en cours de fermeture.
      }
    }
    terminalRef.current = { terminal, fit }
    fit()
    terminal.focus()

    onStatus({ state: 'connecting' })
    let finished = false
    const socket = new WebSocket(url(terminal.cols, terminal.rows))
    socket.binaryType = 'arraybuffer'
    const send = (message: object) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        terminal.write(new Uint8Array(event.data as ArrayBuffer))
        return
      }
      const message = JSON.parse(event.data) as TerminalServerMessage
      if (message.type === 'ready') onStatus({ state: 'open' })
      else if (message.type === 'exit') {
        finished = true
        onStatus({ state: 'exited', code: message.code })
      } else {
        finished = true
        onStatus({ state: 'error', message: message.message })
      }
    }
    let opened = false
    socket.onopen = () => {
      opened = true
    }
    socket.onclose = () => {
      if (finished) return
      finished = true
      if (opened) {
        onStatus({ state: 'error', message: 'Connexion au terminal interrompue.' })
        return
      }
      onStatus({ state: 'error', message: 'Connexion refusée : recherche de la cause…' })
      void diagnose().then((message) => onStatus({ state: 'error', message }))
    }
    const input = terminal.onData((data) => send({ type: 'input', data }))
    const resize = terminal.onResize(({ cols, rows }) => send({ type: 'resize', cols, rows }))
    const observer = new ResizeObserver(fit)
    observer.observe(element)

    return () => {
      finished = true
      observer.disconnect()
      input.dispose()
      resize.dispose()
      socket.close()
      terminal.dispose()
      terminalRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!visible || !terminalRef.current) return
    terminalRef.current.fit()
    terminalRef.current.terminal.focus()
  }, [visible])

  return (
    <div className="min-h-0 flex-1 overflow-hidden rounded-md bg-[#09090b] p-2">
      <div ref={container} className="h-full w-full" />
    </div>
  )
}
