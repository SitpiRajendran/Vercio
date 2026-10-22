import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Box, Copy, Database, HardDrive, Server, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import type { SystemInfo } from '@vercio/shared'
import { useUpdateStatus } from '@/components/layout/vercio-update'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { formatBytes, formatDateTime } from '@/lib/format'

/** `3 j 4 h 12 min` */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days) return `${days} j ${hours} h ${minutes} min`
  if (hours) return `${hours} h ${minutes} min`
  return `${minutes} min ${seconds % 60} s`
}

/** Infos techniques de l'instance : versions, base de Vercio, Docker, conteneur. */
export function SystemInfoTab() {
  const info = useQuery({
    queryKey: ['system', 'info'],
    queryFn: api.system.info,
    refetchInterval: 10_000,
  })
  const update = useUpdateStatus()
  // Durée de fonctionnement qui avance entre deux relectures.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  if (info.isPending) return <Skeleton className="h-72 w-full" />
  if (info.error) return <p className="text-destructive text-sm">{info.error.message}</p>
  const data: SystemInfo = info.data
  const uptime = Math.max(0, Math.round((now - Date.parse(data.vercio.startedAt)) / 1000))
  const latest = update.data?.latest

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">
          Pour comprendre ce qui tourne, ou le joindre à une demande d’aide. Aucun secret n’est
          affiché.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            void navigator.clipboard
              .writeText(JSON.stringify(data, null, 2))
              .then(() => toast.success('Infos copiées'))
          }
        >
          <Copy />
          Copier tout (JSON)
        </Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Section icon={<Sparkles />} title="Vercio">
          <Row label="Version">
            {data.vercio.version}
            {latest && (update.data?.available ? ` · ${latest.version} disponible` : ' · à jour')}
          </Row>
          <Row label="En marche depuis">
            {formatUptime(uptime)}{' '}
            <span className="text-muted-foreground">({formatDateTime(data.vercio.startedAt)})</span>
          </Row>
          <Row label="Node.js">{data.vercio.node}</Row>
          <Row label="Système">{data.vercio.platform}</Row>
          <Row label="Fuseau horaire">{data.vercio.timezone}</Row>
          <Row label="Adresse publique">{data.vercio.publicUrl}</Row>
          <Row label="Dossier de données">{data.vercio.dataDir}</Row>
          <Row label="Connexion">
            {[data.vercio.localAuth && 'comptes locaux', data.vercio.sso && 'SSO']
              .filter(Boolean)
              .join(' + ') || '—'}
          </Row>
          <Row label="Recherche de mises à jour">
            {data.vercio.updateCheck ? 'activée' : 'désactivée'}
          </Row>
        </Section>

        <Section icon={<Database />} title="Base de données de Vercio">
          {data.database.error ? (
            <p className="text-destructive text-sm">{data.database.error}</p>
          ) : (
            <>
              <Row label="Serveur">{data.database.server ?? '—'}</Row>
              <Row label="Connexion">
                {data.database.user}@{data.database.host}:{data.database.port}/{data.database.name}
              </Row>
              <Row label="Temps de réponse">
                {data.database.latencyMs !== null ? `${data.database.latencyMs} ms` : '—'}
              </Row>
              <Row label="Taille">
                {data.database.sizeBytes !== null ? formatBytes(data.database.sizeBytes) : '—'}
              </Row>
              <Row label="Connexions ouvertes">{data.database.connections ?? '—'}</Row>
              <Row label="Migrations appliquées">{data.database.migrations ?? '—'}</Row>
            </>
          )}
        </Section>

        <Section icon={<Server />} title="Docker">
          {'error' in data.docker ? (
            <p className="text-destructive text-sm">{data.docker.error}</p>
          ) : (
            <>
              <Row label="Version">{data.docker.serverVersion}</Row>
              <Row label="Système">
                {data.docker.operatingSystem} ({data.docker.architecture})
              </Row>
              <Row label="Processeurs">{data.docker.cpus}</Row>
              <Row label="Mémoire">{formatBytes(data.docker.memoryBytes)}</Row>
              <Row label="Conteneurs">
                {data.docker.containers.running} en marche sur {data.docker.containers.total}
              </Row>
              <Row label="Images">{data.docker.images}</Row>
            </>
          )}
        </Section>

        <Section icon={<Box />} title="Conteneur de Vercio">
          {data.container ? (
            <>
              <Row label="Identifiant">{data.container.id}</Row>
              <Row label="Image">{data.container.image}</Row>
              <Row label="Projet Compose">
                {data.container.project ?? '—'}
                {data.container.service ? ` / ${data.container.service}` : ''}
              </Row>
              <Row label="Dossier d’installation">{data.container.workingDir ?? '—'}</Row>
              {data.container.mounts.map((mount) => (
                <Row key={mount.destination} label="Montage">
                  {mount.source} → {mount.destination}
                </Row>
              ))}
            </>
          ) : (
            <p className="text-muted-foreground text-sm">
              Vercio ne tourne pas dans un conteneur (développement).
            </p>
          )}
        </Section>

        <Section icon={<HardDrive />} title="Contenu">
          <Row label="Projets">{data.counts.projects}</Row>
          <Row label="Environnements">{data.counts.environments}</Row>
          <Row label="Déploiements (historique)">{data.counts.deployments}</Row>
          <Row label="Comptes">{data.counts.users}</Row>
          <Row label="Sauvegardes">{data.counts.backups}</Row>
        </Section>
      </div>
    </div>
  )
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 [&_svg]:size-4">
          <span className="text-muted-foreground">{icon}</span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="divide-y text-sm">{children}</dl>
      </CardContent>
    </Card>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-mono text-xs break-all">{children}</dd>
    </div>
  )
}
