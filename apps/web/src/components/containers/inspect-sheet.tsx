import { useQuery } from '@tanstack/react-query'
import { EyeOff } from 'lucide-react'
import type { ContainerInspectView } from '@vercio/shared'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { formatDateTime } from '@/lib/format'

/** `docker inspect` lisible : variables (secrets masqués), montages, réseaux, healthcheck. */
export function InspectSheet({
  projectId,
  envId,
  container,
  onClose,
}: {
  projectId: string
  envId: string
  container: { id: string; name: string; service: string } | null
  onClose: () => void
}) {
  const details = useQuery({
    queryKey: ['containers', envId, 'inspect', container?.id],
    queryFn: () => api.containers.inspect(projectId, envId, container!.id),
    enabled: !!container,
  })

  return (
    <Sheet open={!!container} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>{container?.service || container?.name}</SheetTitle>
          <SheetDescription className="font-mono text-xs break-all">
            {container?.name}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-6 px-4 pb-6">
          {details.isPending && <Skeleton className="h-64 w-full" />}
          {details.error && <p className="text-destructive text-sm">{details.error.message}</p>}
          {details.data && <Details view={details.data} />}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-foreground text-xs">{children}</p>
}

function Details({ view }: { view: ContainerInspectView }) {
  const command = [...view.entrypoint, ...view.command].join(' ')
  const labels = Object.entries(view.labels).sort(([a], [b]) => a.localeCompare(b))
  return (
    <>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Image</dt>
        <dd className="font-mono text-xs break-all">
          {view.image}
          <span className="text-muted-foreground block">{view.imageId}</span>
        </dd>
        <dt className="text-muted-foreground">État</dt>
        <dd>
          {view.state}
          {view.startedAt && view.state === 'running' && (
            <span className="text-muted-foreground">
              {' '}
              depuis le {formatDateTime(view.startedAt)}
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">Redémarrage</dt>
        <dd>
          <code className="text-xs">{view.restartPolicy}</code>
          <span className="text-muted-foreground"> · {view.restartCount} redémarrage(s)</span>
        </dd>
        <dt className="text-muted-foreground">Commande</dt>
        <dd className="font-mono text-xs break-all">{command || '—'}</dd>
        <dt className="text-muted-foreground">Dossier</dt>
        <dd className="font-mono text-xs">{view.workingDir || '/'}</dd>
        <dt className="text-muted-foreground">Utilisateur</dt>
        <dd className="font-mono text-xs">{view.user || 'root (par défaut)'}</dd>
        <dt className="text-muted-foreground">Créé le</dt>
        <dd>{formatDateTime(view.createdAt)}</dd>
      </dl>

      {view.health && (
        <Section title="Healthcheck">
          <p className="text-sm">
            <Badge variant="outline">{view.health.status}</Badge>
            {view.health.failingStreak > 0 && (
              <span className="text-destructive ml-2 text-xs">
                {view.health.failingStreak} échec(s) d’affilée
              </span>
            )}
          </p>
          {view.health.log.length > 0 && (
            <ul className="space-y-1.5">
              {view.health.log
                .slice()
                .reverse()
                .map((entry) => (
                  <li key={entry.start} className="rounded-md border p-2 text-xs">
                    <p className="text-muted-foreground">
                      {entry.start ? formatDateTime(entry.start) : '—'} · code {entry.exitCode}
                    </p>
                    {entry.output.trim() && (
                      <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap">
                        {entry.output.trim()}
                      </pre>
                    )}
                  </li>
                ))}
            </ul>
          )}
        </Section>
      )}

      <Section title={`Variables (${view.env.length})`}>
        {view.env.length ? (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-xs">
              <tbody className="divide-y">
                {view.env.map((item) => (
                  <tr key={item.key}>
                    <td className="px-2 py-1.5 font-mono align-top whitespace-nowrap">
                      {item.key}
                    </td>
                    <td className="px-2 py-1.5 font-mono break-all">
                      {item.masked ? (
                        <span className="text-muted-foreground inline-flex items-center gap-1">
                          <EyeOff className="size-3" />
                          masquée
                        </span>
                      ) : (
                        item.value
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Aucune variable.</Empty>
        )}
        <Empty>
          Les variables secrètes de Vercio et celles dont le nom ressemble à un secret (PASSWORD,
          TOKEN, KEY…) sont masquées.
        </Empty>
      </Section>

      <Section title="Montages">
        {view.mounts.length ? (
          <ul className="space-y-1 text-xs">
            {view.mounts.map((mount) => (
              <li key={mount.destination} className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary">{mount.type === 'volume' ? 'volume' : mount.type}</Badge>
                <code className="break-all">{mount.source}</code>
                <span className="text-muted-foreground">→</span>
                <code className="break-all">{mount.destination}</code>
                {mount.readOnly && <Badge variant="outline">lecture seule</Badge>}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Aucun montage.</Empty>
        )}
      </Section>

      <Section title="Réseaux et ports">
        <ul className="space-y-1 text-xs">
          {view.networks.map((network) => (
            <li key={network.name}>
              <code>{network.name}</code>
              {network.ip && <span className="text-muted-foreground"> · {network.ip}</span>}
              {network.aliases.length > 0 && (
                <span className="text-muted-foreground"> · alias {network.aliases.join(', ')}</span>
              )}
            </li>
          ))}
        </ul>
        {view.ports.length ? (
          <p className="font-mono text-xs">{view.ports.join(', ')}</p>
        ) : (
          <Empty>Aucun port exposé.</Empty>
        )}
      </Section>

      <Section title={`Labels (${labels.length})`}>
        <details>
          <summary className="text-muted-foreground cursor-pointer text-xs">Afficher</summary>
          <ul className="mt-2 space-y-0.5 font-mono text-xs break-all">
            {labels.map(([key, value]) => (
              <li key={key}>
                <span className="text-muted-foreground">{key}=</span>
                {value}
              </li>
            ))}
          </ul>
        </details>
      </Section>
    </>
  )
}
