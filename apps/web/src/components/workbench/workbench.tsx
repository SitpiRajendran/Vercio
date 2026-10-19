import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Maximize2, Minimize2, ScrollText, SquareTerminal, X } from 'lucide-react'
import { toast } from 'sonner'
import { hasRole } from '@vercio/shared'
import { LogViewer } from '@/components/containers/log-viewer'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { api } from '@/lib/api'
import { useCurrentUser } from '@/lib/auth'
import { useOverview } from '@/lib/overview'
import { cn } from '@/lib/utils'
import { DeploySheet } from './deploy-sheet'

// xterm.js n'est chargé qu'à l'ouverture d'un premier terminal.
const TerminalPanes = lazy(() => import('@/components/containers/terminal-session'))

/** Environnement visé par une action (logs, terminal, déploiement). */
export interface EnvTarget {
  projectId: string
  projectSlug: string
  projectName: string
  envId: string
  envName: string
}

export interface TerminalTab extends EnvTarget {
  key: string
  container: { id: string; name: string; service: string }
}

export type TerminalStatus =
  | { state: 'connecting' }
  | { state: 'open' }
  | { state: 'exited'; code: number | null }
  | { state: 'error'; message: string }

/** Le serveur refuse au-delà de 5 terminaux par utilisateur. */
const MAX_TERMINALS = 5

interface Workbench {
  canDeploy: boolean
  isAdmin: boolean
  canUseTerminal: boolean
  openLogs: (target: EnvTarget, service?: string | null) => void
  openTerminal: (target: EnvTarget, container: TerminalTab['container']) => void
  openDeploy: (target: EnvTarget) => void
}

const WorkbenchContext = createContext<Workbench | null>(null)

export function useWorkbench(): Workbench {
  const value = useContext(WorkbenchContext)
  if (!value) throw new Error('useWorkbench hors de WorkbenchProvider')
  return value
}

let tabCounter = 0

/**
 * Outils disponibles partout : logs d'un service (panneau latéral), déploiement suivi en
 * direct (panneau latéral) et terminaux (dock en bas, plusieurs onglets).
 */
export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const { data: user } = useCurrentUser()
  const isAdmin = user ? hasRole(user.roles, 'vercio-admin') : false
  const canDeploy = user ? hasRole(user.roles, 'vercio-deployer') : false
  // Terminal : administrateurs, et déployeurs si un administrateur l'a autorisé.
  const terminalSettings = useQuery({
    queryKey: ['settings', 'terminal'],
    queryFn: api.terminalSettings.get,
    enabled: canDeploy && !isAdmin,
  })
  const canUseTerminal = isAdmin || (canDeploy && !!terminalSettings.data?.deployers)

  const [logs, setLogs] = useState<(EnvTarget & { service: string | null }) | null>(null)
  const [deploy, setDeploy] = useState<EnvTarget | null>(null)
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<Record<string, TerminalStatus['state']>>({})
  const [size, setSize] = useState<'min' | 'normal' | 'max'>('normal')

  const openTerminal = useCallback(
    (target: EnvTarget, container: TerminalTab['container']) => {
      const open = tabs.filter((tab) => statuses[tab.key] !== 'exited')
      if (open.length >= MAX_TERMINALS) {
        toast.error(`${MAX_TERMINALS} terminaux au plus : fermez-en un d’abord.`)
        return
      }
      const tab = { ...target, container, key: `t${++tabCounter}` }
      setTabs((current) => [...current, tab])
      setActive(tab.key)
      setSize((current) => (current === 'min' ? 'normal' : current))
    },
    [tabs, statuses],
  )

  const closeTab = (key: string) => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.key !== key)
      if (active === key) setActive(next.at(-1)?.key ?? null)
      return next
    })
  }

  const value = useMemo<Workbench>(
    () => ({
      canDeploy,
      isAdmin,
      canUseTerminal,
      openLogs: (target, service = null) => setLogs({ ...target, service }),
      openTerminal,
      openDeploy: setDeploy,
    }),
    [canDeploy, isAdmin, canUseTerminal, openTerminal],
  )

  return (
    <WorkbenchContext.Provider value={value}>
      <div className="flex h-svh min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* Pages : défilement propre, le dock reste visible en bas. */}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {tabs.length > 0 && (
          <section
            aria-label="Terminaux"
            className={cn(
              'bg-background flex shrink-0 flex-col border-t',
              size === 'min' && 'h-10',
              size === 'normal' && 'h-[42svh] min-h-64',
              size === 'max' && 'h-[85svh]',
            )}
          >
            <div className="flex items-center gap-1 overflow-x-auto border-b px-2">
              {tabs.map((tab) => (
                <div
                  key={tab.key}
                  className={cn(
                    'flex shrink-0 items-center border-b-2 border-transparent',
                    tab.key === active && size !== 'min' && 'border-primary',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      setActive(tab.key)
                      if (size === 'min') setSize('normal')
                    }}
                    className="flex items-center gap-2 px-2 py-2 text-xs"
                    title={`${tab.container.name} · ${tab.projectName} / ${tab.envName}`}
                  >
                    <span
                      className={cn(
                        'size-1.5 rounded-full',
                        statuses[tab.key] === 'open'
                          ? 'bg-success'
                          : statuses[tab.key] === 'connecting'
                            ? 'bg-warning'
                            : 'bg-muted-foreground/50',
                      )}
                      aria-hidden
                    />
                    <SquareTerminal className="size-3.5" />
                    <span className="font-medium">{tab.container.service}</span>
                    <span className="text-muted-foreground hidden sm:inline">
                      {tab.projectName}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => closeTab(tab.key)}
                    aria-label={`Fermer le terminal ${tab.container.service}`}
                    className="text-muted-foreground hover:text-foreground rounded p-0.5"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
              <div className="ml-auto flex shrink-0 items-center">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={size === 'min' ? 'Afficher les terminaux' : 'Réduire les terminaux'}
                  onClick={() => setSize(size === 'min' ? 'normal' : 'min')}
                >
                  <Minimize2 className={cn(size === 'min' && 'rotate-180')} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={size === 'max' ? 'Taille normale' : 'Agrandir les terminaux'}
                  onClick={() => setSize(size === 'max' ? 'normal' : 'max')}
                >
                  <Maximize2 />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label="Fermer tous les terminaux"
                  onClick={() => {
                    setTabs([])
                    setActive(null)
                  }}
                >
                  <X />
                </Button>
              </div>
            </div>
            <div className={cn('flex min-h-0 flex-1 flex-col p-2', size === 'min' && 'hidden')}>
              <Suspense fallback={null}>
                <TerminalPanes
                  tabs={tabs}
                  active={active}
                  onStatus={(key, status) =>
                    setStatuses((current) => ({ ...current, [key]: status.state }))
                  }
                />
              </Suspense>
            </div>
          </section>
        )}
      </div>
      <LogsSheet target={logs} onClose={() => setLogs(null)} />
      <DeploySheet target={deploy} onClose={() => setDeploy(null)} />
    </WorkbenchContext.Provider>
  )
}

function LogsSheet({
  target,
  onClose,
}: {
  target: (EnvTarget & { service: string | null }) | null
  onClose: () => void
}) {
  const overview = useOverview()
  const [service, setService] = useState<string | null>(null)
  const [opened, setOpened] = useState(target)
  // Nouvelle demande : on repart du service demandé.
  if (target !== opened) {
    setOpened(target)
    setService(target?.service ?? null)
  }
  const env = overview.data?.projects
    .find((project) => project.id === target?.projectId)
    ?.environments.find((item) => item.id === target?.envId)
  const services = [...new Set(env?.containers.map((container) => container.service) ?? [])].sort()

  return (
    <Sheet open={!!target} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-3xl">
        {target && (
          <>
            <SheetHeader className="pr-10">
              <SheetTitle className="flex items-center gap-2">
                <ScrollText className="size-4" />
                Logs {service ? `· ${service}` : ''}
              </SheetTitle>
              <SheetDescription>
                <Link
                  to="/projets/$slug"
                  params={{ slug: target.projectSlug }}
                  search={{ onglet: 'logs' }}
                  className="hover:underline"
                  onClick={onClose}
                >
                  {target.projectName} · {target.envName}
                </Link>
              </SheetDescription>
            </SheetHeader>
            <LogViewer
              className="min-h-0 flex-1 px-4 pb-4"
              projectId={target.projectId}
              envId={target.envId}
              service={service}
              services={services}
              onServiceChange={setService}
              downloadName={`${target.projectSlug}-${target.envName}`}
            />
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
