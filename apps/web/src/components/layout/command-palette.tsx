import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  History,
  LayoutGrid,
  Network,
  Plus,
  Rocket,
  ScrollText,
  Search,
  Server,
  Settings,
  SquareTerminal,
} from 'lucide-react'
import { ProjectAvatar } from '@/components/projects/project-avatar'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useWorkbench, type EnvTarget } from '@/components/workbench/workbench'
import { containerStatus, TONE_DOT, useOverview } from '@/lib/overview'
import { cn } from '@/lib/utils'

const OPEN_EVENT = 'vercio:command-palette'

/** Ouvre la recherche rapide (aussi : Ctrl K, ⌘ K). */
export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT))
}

interface Command {
  id: string
  group: string
  label: string
  hint?: string
  icon: ReactNode
  /** Mots recherchés en plus du libellé. */
  keywords?: string
  run: () => void
}

/** Sans accents ni majuscules : « déployer » trouve « Deployer ». */
const normalize = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const navigate = useNavigate()
  const overview = useOverview()
  const workbench = useWorkbench()
  const list = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((current) => !current)
      }
    }
    const onOpen = () => setOpen(true)
    // Phase de capture : le terminal (xterm) garde sinon les touches pour lui.
    window.addEventListener('keydown', onKey, true)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener(OPEN_EVENT, onOpen)
    }
  }, [])

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => void navigate({ to })
    const pages: Command[] = [
      { id: 'p-home', group: 'Pages', label: 'Projets', icon: <LayoutGrid />, run: go('/') },
      {
        id: 'p-activity',
        group: 'Pages',
        label: 'Activité',
        keywords: 'historique evenements deploiements push',
        icon: <History />,
        run: go('/evenements'),
      },
      {
        id: 'p-map',
        group: 'Pages',
        label: 'Carte et ports',
        keywords: 'reseaux flux ports',
        icon: <Network />,
        run: go('/carte'),
      },
      {
        id: 'p-host',
        group: 'Pages',
        label: 'Hôte',
        keywords: 'conteneurs disque nettoyage docker',
        icon: <Server />,
        run: go('/conteneurs'),
      },
      {
        id: 'p-settings',
        group: 'Pages',
        label: 'Paramètres',
        keywords: 'gitlab github registry utilisateurs notifications',
        icon: <Settings />,
        run: go('/parametres'),
      },
      ...(workbench.isAdmin
        ? [
            {
              id: 'p-new',
              group: 'Pages',
              label: 'Nouveau projet',
              icon: <Plus />,
              run: go('/projets/nouveau'),
            },
          ]
        : []),
    ]
    const projectCommands: Command[] = []
    const containerCommands: Command[] = []
    for (const project of overview.data?.projects ?? []) {
      const several = project.environments.length > 1
      projectCommands.push({
        id: `project-${project.id}`,
        group: 'Projets',
        label: project.name,
        hint: project.description ?? undefined,
        icon: <ProjectAvatar project={project} size="sm" />,
        keywords: project.slug,
        run: () => void navigate({ to: '/projets/$slug', params: { slug: project.slug } }),
      })
      for (const env of project.environments) {
        const target: EnvTarget = {
          projectId: project.id,
          projectSlug: project.slug,
          projectName: project.name,
          envId: env.id,
          envName: env.name,
        }
        const where = several ? `${project.name} · ${env.name}` : project.name
        if (workbench.canDeploy) {
          projectCommands.push({
            id: `deploy-${env.id}`,
            group: 'Projets',
            label: `${env.current ? 'Mettre à jour' : 'Déployer'} ${where}`,
            keywords: 'deployer pull',
            icon: <Rocket />,
            run: () => workbench.openDeploy(target),
          })
        }
        for (const container of env.containers) {
          const status = containerStatus(container)
          const dot = <span className={cn('size-2 rounded-full', TONE_DOT[status.tone])} />
          containerCommands.push({
            id: `logs-${container.id}`,
            group: 'Conteneurs',
            label: `Logs de ${container.service}`,
            hint: `${where} · ${status.label}`,
            keywords: `${container.name} ${project.slug}`,
            icon: (
              <span className="flex items-center gap-1.5">
                {dot}
                <ScrollText />
              </span>
            ),
            run: () => workbench.openLogs(target, container.service),
          })
          if (workbench.canUseTerminal && container.state === 'running') {
            containerCommands.push({
              id: `terminal-${container.id}`,
              group: 'Conteneurs',
              label: `Terminal dans ${container.service}`,
              hint: where,
              keywords: `shell ${container.name} ${project.slug}`,
              icon: (
                <span className="flex items-center gap-1.5">
                  {dot}
                  <SquareTerminal />
                </span>
              ),
              run: () =>
                workbench.openTerminal(target, {
                  id: container.id,
                  name: container.name,
                  service: container.service,
                }),
            })
          }
        }
      }
    }
    return [...projectCommands, ...containerCommands, ...pages]
  }, [overview.data, workbench, navigate])

  const results = useMemo(() => {
    const words = normalize(query).split(/\s+/).filter(Boolean)
    return commands
      .filter((command) => {
        const haystack = normalize(
          `${command.label} ${command.hint ?? ''} ${command.keywords ?? ''}`,
        )
        return words.every((word) => haystack.includes(word))
      })
      .slice(0, 60)
  }, [commands, query])

  const run = (command: Command | undefined) => {
    if (!command) return
    setOpen(false)
    setQuery('')
    command.run()
  }

  useEffect(() => {
    list.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        setOpen(value)
        if (!value) setQuery('')
      }}
    >
      <DialogContent
        className="top-[20%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Recherche rapide</DialogTitle>
        <DialogDescription className="sr-only">
          Projets, logs, terminaux et pages. Flèches pour choisir, Entrée pour ouvrir.
        </DialogDescription>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="text-muted-foreground size-4" />
          <input
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls="command-results"
            aria-activedescendant={results[selected] ? `command-${selected}` : undefined}
            placeholder="Projet, service, « logs backend », « terminal »…"
            className="h-11 w-full bg-transparent text-sm outline-none"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setSelected(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSelected((index) => Math.min(index + 1, results.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSelected((index) => Math.max(index - 1, 0))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                run(results[selected])
              }
            }}
          />
        </div>
        <ul
          ref={list}
          id="command-results"
          role="listbox"
          aria-label="Résultats"
          className="max-h-[min(60vh,26rem)] overflow-y-auto p-1"
        >
          {results.length === 0 && (
            <li className="text-muted-foreground px-3 py-6 text-center text-sm">Aucun résultat.</li>
          )}
          {results.map((command, index) => (
            <li key={command.id}>
              {(index === 0 || results[index - 1]!.group !== command.group) && (
                <p className="text-muted-foreground px-2 pt-2 pb-1 text-xs font-medium">
                  {command.group}
                </p>
              )}
              <button
                type="button"
                id={`command-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === selected}
                onMouseMove={() => setSelected(index)}
                onClick={() => run(command)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm',
                  index === selected && 'bg-accent text-accent-foreground',
                )}
              >
                <span className="text-muted-foreground flex shrink-0 items-center [&_svg]:size-4">
                  {command.icon}
                </span>
                <span className="min-w-0 flex-1 truncate">{command.label}</span>
                {command.hint && (
                  <span className="text-muted-foreground max-w-[45%] truncate text-xs">
                    {command.hint}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
