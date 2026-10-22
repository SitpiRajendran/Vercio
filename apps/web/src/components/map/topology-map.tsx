import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link as RouterLink } from '@tanstack/react-router'
import { Globe, Lock, Network, ScrollText, Server } from 'lucide-react'
import { ProjectAvatar } from '@/components/projects/project-avatar'
import { envTarget } from '@/components/projects/project-overview-card'
import { Button } from '@/components/ui/button'
import { useWorkbench } from '@/components/workbench/workbench'
import { containerStatus, TONE_DOT, TONE_TEXT } from '@/lib/overview'
import { NETWORK_COLORS, type Link, type Topology } from '@/lib/topology'
import { cn } from '@/lib/utils'

interface Edge {
  key: string
  from: string
  to: string
  kind: 'public' | 'local' | 'expose' | 'join' | 'depends'
  /** Conteneurs concernés : mis en avant au survol. */
  containers: string[]
}

interface Segment extends Edge {
  path: string
}

const EDGE_STYLES: Record<Edge['kind'], string> = {
  public: 'stroke-success',
  local: 'stroke-muted-foreground',
  expose: 'stroke-chart',
  join: 'stroke-chart [stroke-dasharray:5_4]',
  depends: 'stroke-warning [stroke-dasharray:2_4]',
}

/**
 * Carte des échanges : ports ouverts sur l'hôte (à gauche), conteneurs par projet (au
 * centre, pastilles = réseaux internes), réseaux partagés entre projets (à droite).
 * Survoler ou choisir un conteneur montre ce qu'il peut joindre.
 */
export function TopologyMap({
  topology,
  sharedActions,
}: {
  topology: Topology
  /** Sous la colonne des réseaux partagés : partager un service, rejoindre un réseau. */
  sharedActions?: React.ReactNode
}) {
  const workbench = useWorkbench()
  const wrapper = useRef<HTMLDivElement>(null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [hovered, setHovered] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const focus = hovered ?? selected

  const publicPorts = topology.ports.filter((item) => item.public)
  const localPorts = topology.ports.filter((item) => !item.public)

  const edges = useMemo<Edge[]>(() => {
    const result: Edge[] = []
    for (const item of topology.ports) {
      const id = item.item.container.id
      result.push({
        key: `p-${id}-${item.port.hostPort}-${item.port.protocol}-${item.port.ip}`,
        from: `port:${id}:${item.port.hostPort}:${item.port.protocol}:${item.port.ip}`,
        to: `c:${id}`,
        kind: item.public ? 'public' : 'local',
        containers: [id],
      })
    }
    for (const network of topology.shared) {
      for (const { container, env } of topology.byId.values()) {
        if (!container.networks.includes(network.dockerName)) continue
        const exposer =
          network.exposedBy.environmentId === env.id &&
          network.exposedBy.service === container.service
        result.push({
          key: `n-${network.id}-${container.id}`,
          from: `c:${container.id}`,
          to: `n:${network.id}`,
          kind: exposer ? 'expose' : 'join',
          containers: [container.id],
        })
      }
    }
    for (const group of topology.groups) {
      for (const container of group.containers) {
        for (const service of container.dependsOn) {
          const target = group.containers.find((item) => item.service === service)
          if (!target) continue
          result.push({
            key: `d-${container.id}-${target.id}`,
            from: `c:${container.id}`,
            to: `c:${target.id}`,
            kind: 'depends',
            containers: [container.id, target.id],
          })
        }
      }
    }
    return result
  }, [topology])

  // Tracés recalculés à chaque changement de taille : les nœuds sont du HTML ordinaire.
  useLayoutEffect(() => {
    const element = wrapper.current
    if (!element) return
    const compute = () => {
      const origin = element.getBoundingClientRect()
      const rect = (id: string) => {
        const node = element.querySelector<HTMLElement>(`[data-node="${CSS.escape(id)}"]`)
        if (!node || node.offsetParent === null) return null
        const box = node.getBoundingClientRect()
        return {
          left: box.left - origin.left,
          right: box.right - origin.left,
          top: box.top - origin.top,
          mid: box.top - origin.top + box.height / 2,
        }
      }
      // Sur petit écran, les colonnes sont empilées : pas de traits.
      if (element.offsetWidth < 900) {
        setSegments([])
        return
      }
      const next: Segment[] = []
      for (const edge of edges) {
        const a = rect(edge.from)
        const b = rect(edge.to)
        if (!a || !b) continue
        let path: string
        if (edge.kind === 'depends') {
          // Arc à droite de la carte du projet, du dépendant vers sa dépendance.
          const x = Math.max(a.right, b.right) + 28
          path = `M ${a.right} ${a.mid} C ${x} ${a.mid}, ${x} ${b.mid}, ${b.right} ${b.mid}`
        } else {
          const x1 = a.right
          const x2 = b.left
          const bend = Math.max(30, (x2 - x1) / 2)
          path = `M ${x1} ${a.mid} C ${x1 + bend} ${a.mid}, ${x2 - bend} ${b.mid}, ${x2} ${b.mid}`
        }
        next.push({ ...edge, path })
      }
      setSegments(next)
    }
    compute()
    const observer = new ResizeObserver(compute)
    observer.observe(element)
    return () => observer.disconnect()
  }, [edges])

  const links: Link[] = selected ? topology.links(selected) : []
  const reachable = new Set(
    focus ? topology.links(focus).flatMap((link) => (link.peer ? [link.peer] : [])) : [],
  )
  const selectedItem = selected ? topology.byId.get(selected) : null

  if (topology.groups.length === 0) {
    return (
      <p className="text-muted-foreground rounded-lg border border-dashed py-10 text-center text-sm">
        Aucun conteneur à afficher : déployez un projet pour voir ses liens.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <div ref={wrapper} className="relative">
        <svg
          className="pointer-events-none absolute inset-0 size-full overflow-visible"
          aria-hidden
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M0,0 L8,4 L0,8 z" className="fill-muted-foreground" />
            </marker>
          </defs>
          {segments.map((segment) => {
            const active = !focus || segment.containers.includes(focus)
            return (
              <path
                key={segment.key}
                d={segment.path}
                fill="none"
                strokeWidth={segment.kind === 'expose' ? 2.5 : 1.5}
                markerEnd={segment.kind === 'depends' ? 'url(#arrow)' : undefined}
                className={cn(
                  EDGE_STYLES[segment.kind],
                  'transition-opacity',
                  active ? 'opacity-90' : 'opacity-10',
                )}
              />
            )
          })}
        </svg>

        <div className="relative grid gap-6 lg:grid-cols-[12rem_minmax(0,1fr)_14rem] lg:gap-16">
          {/* Accès depuis l'extérieur et depuis l'hôte. */}
          <div className="space-y-4">
            <Column
              icon={<Globe className="size-4" />}
              title="Internet"
              hint="Ports ouverts sur toutes les interfaces de l’hôte"
            >
              {publicPorts.length === 0 && <Empty>Aucun port public.</Empty>}
              {publicPorts.map(({ item, port }) => (
                <PortNode
                  key={`${item.container.id}-${port.hostPort}-${port.protocol}-${port.ip}`}
                  id={`port:${item.container.id}:${port.hostPort}:${port.protocol}:${port.ip}`}
                  label={`${port.ip ? `${port.ip}:` : ':'}${port.hostPort}`}
                  detail={`→ ${item.container.service} (${item.project.name})`}
                  dim={!!focus && focus !== item.container.id}
                  onHover={(on) => setHovered(on ? item.container.id : null)}
                />
              ))}
            </Column>
            <Column
              icon={<Lock className="size-4" />}
              title="Hôte seulement"
              hint="Ports réservés à la machine (127.0.0.1) : proxy, sauvegardes, accès SSH…"
            >
              {localPorts.length === 0 && <Empty>Aucun port local.</Empty>}
              {localPorts.map(({ item, port }) => (
                <PortNode
                  key={`${item.container.id}-${port.hostPort}-${port.protocol}-${port.ip}`}
                  id={`port:${item.container.id}:${port.hostPort}:${port.protocol}:${port.ip}`}
                  label={`${port.ip}:${port.hostPort}`}
                  detail={`→ ${item.container.service} (${item.project.name})`}
                  dim={!!focus && focus !== item.container.id}
                  onHover={(on) => setHovered(on ? item.container.id : null)}
                />
              ))}
            </Column>
          </div>

          {/* Projets et leurs conteneurs. */}
          <div className="space-y-4">
            {topology.groups.map((group) => (
              <section
                key={group.env.id}
                className="bg-card rounded-xl border p-3 lg:mr-6"
                aria-label={`${group.project.name} ${group.env.name}`}
              >
                <header className="mb-2 flex flex-wrap items-center gap-2">
                  <ProjectAvatar project={group.project} size="sm" />
                  <RouterLink
                    to="/projets/$slug"
                    params={{ slug: group.project.slug }}
                    search={{ env: group.env.slug, onglet: 'carte' }}
                    className="text-sm font-semibold hover:underline"
                  >
                    {group.project.name}
                  </RouterLink>
                  {group.showEnv && (
                    <span className="text-muted-foreground text-xs">{group.env.name}</span>
                  )}
                  {group.networks.length > 0 && (
                    <span className="text-muted-foreground ml-auto flex flex-wrap items-center gap-x-2 text-xs">
                      {group.networks.map((network, index) => (
                        <span
                          key={network.name}
                          className="flex items-center gap-1"
                          title={network.name}
                        >
                          <span
                            className={cn(
                              'size-2 rounded-full',
                              NETWORK_COLORS[index % NETWORK_COLORS.length],
                            )}
                          />
                          {network.label}
                        </span>
                      ))}
                    </span>
                  )}
                </header>
                <ul className="space-y-1">
                  {group.containers.map((container) => {
                    const status = containerStatus(container)
                    const id = container.id
                    return (
                      <li key={id}>
                        <button
                          type="button"
                          data-node={`c:${id}`}
                          onMouseEnter={() => setHovered(id)}
                          onMouseLeave={() => setHovered(null)}
                          onFocus={() => setHovered(id)}
                          onBlur={() => setHovered(null)}
                          onClick={() => setSelected(selected === id ? null : id)}
                          aria-pressed={selected === id}
                          className={cn(
                            'hover:bg-accent flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-sm transition-opacity',
                            selected === id && 'border-primary ring-primary ring-1',
                            focus && focus !== id && !reachable.has(id) && 'opacity-40',
                            focus && reachable.has(id) && 'border-chart',
                          )}
                        >
                          <span
                            className={cn('size-2 shrink-0 rounded-full', TONE_DOT[status.tone])}
                          />
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {container.service}
                          </span>
                          {container.dependsOn.length > 0 && (
                            <span className="text-muted-foreground hidden truncate text-xs sm:inline">
                              après {container.dependsOn.join(', ')}
                            </span>
                          )}
                          <span className="flex shrink-0 gap-1" aria-label="Réseaux internes">
                            {group.networks.map((network, index) =>
                              container.networks.includes(network.name) ? (
                                <span
                                  key={network.name}
                                  title={`Réseau ${network.label}`}
                                  className={cn(
                                    'size-2 rounded-full',
                                    NETWORK_COLORS[index % NETWORK_COLORS.length],
                                  )}
                                />
                              ) : null,
                            )}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>

          {/* Réseaux partagés entre projets. */}
          <Column
            icon={<Network className="size-4" />}
            title="Réseaux partagés"
            hint="Un service d’un projet, joignable par les autres sous un nom"
          >
            {topology.shared.length === 0 && <Empty>Aucun réseau partagé.</Empty>}
            {sharedActions}
            {topology.shared.map((network) => (
              <div
                key={network.id}
                data-node={`n:${network.id}`}
                className="bg-card rounded-lg border p-2 text-sm"
              >
                <p className="font-mono font-medium">{network.alias}</p>
                <p className="text-muted-foreground text-xs">
                  {network.exposedBy.service} de {network.exposedBy.projectName}
                  {' · '}
                  {network.subscribers.length} abonné{network.subscribers.length > 1 ? 's' : ''}
                </p>
              </div>
            ))}
          </Column>
        </div>
      </div>

      <Legend />

      {selectedItem && (
        <section className="bg-card space-y-2 rounded-xl border p-4" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <ProjectAvatar project={selectedItem.project} size="sm" />
            <h3 className="font-semibold">
              {selectedItem.container.service}
              <span className="text-muted-foreground font-normal">
                {' '}
                · {selectedItem.project.name}
              </span>
            </h3>
            <span
              className={cn('text-xs', TONE_TEXT[containerStatus(selectedItem.container).tone])}
            >
              {containerStatus(selectedItem.container).label}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() =>
                workbench.openLogs(
                  envTarget(selectedItem.project, selectedItem.env),
                  selectedItem.container.service,
                )
              }
            >
              <ScrollText />
              Logs
            </Button>
          </div>
          {links.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Isolé : aucun port ouvert, aucun autre service sur ses réseaux.
            </p>
          ) : (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {links.map((link, index) => (
                <li key={index}>{link.text}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}

function Column({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode
  title: string
  hint: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2">
      <div>
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          {icon}
          {title}
        </p>
        <p className="text-muted-foreground text-xs">{hint}</p>
      </div>
      <div className="space-y-1.5">{children}</div>
    </section>
  )
}

function PortNode({
  id,
  label,
  detail,
  dim,
  onHover,
}: {
  id: string
  label: string
  detail: string
  dim: boolean
  onHover: (on: boolean) => void
}) {
  return (
    <div
      data-node={id}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      className={cn(
        'bg-card rounded-md border px-2 py-1 text-xs transition-opacity',
        dim && 'opacity-40',
      )}
    >
      <span className="font-mono font-medium">{label}</span>{' '}
      <span className="text-muted-foreground">{detail}</span>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-xs">{children}</p>
}

function Legend() {
  const item = (className: string, label: string, dashed?: string) => (
    <span className="flex items-center gap-1.5">
      <svg width="28" height="8" aria-hidden>
        <path d="M0 4 H28" strokeWidth="2" className={cn(className, dashed)} />
      </svg>
      {label}
    </span>
  )
  return (
    <div className="text-muted-foreground flex flex-wrap gap-x-5 gap-y-1 text-xs">
      {item('stroke-success', 'port ouvert à tous')}
      {item('stroke-muted-foreground', 'port réservé à l’hôte')}
      {item('stroke-chart', 'service exposé à d’autres projets')}
      {item('stroke-chart', 'rejoint un réseau partagé', '[stroke-dasharray:5_4]')}
      {item('stroke-warning', 'démarre après', '[stroke-dasharray:2_4]')}
      <span className="flex items-center gap-1.5">
        <Server className="size-3" />
        pastilles colorées : réseaux internes (les services d’un même réseau se joignent par leur
        nom)
      </span>
    </div>
  )
}
