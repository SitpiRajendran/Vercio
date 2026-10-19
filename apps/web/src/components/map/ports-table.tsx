import { Globe, Lock, TriangleAlert } from 'lucide-react'
import { PortChip } from '@/components/containers/container-list'
import { ProjectAvatar } from '@/components/projects/project-avatar'
import type { MapPort } from '@/lib/topology'

/** Ports publiés sur l'hôte : qui écoute où, et qui peut y accéder. */
export function PortsTable({
  ports,
  showProject = true,
}: {
  ports: MapPort[]
  showProject?: boolean
}) {
  const hasPublic = ports.some((item) => item.public)
  return (
    <div className="space-y-3">
      {ports.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border border-dashed py-8 text-center text-sm">
          Aucun port ouvert sur l’hôte : les conteneurs ne sont joignables que par les autres
          conteneurs de leurs réseaux.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="text-muted-foreground text-left text-xs">
              <tr className="border-b">
                <th className="px-3 py-2 font-medium">Port de l’hôte</th>
                <th className="px-3 py-2 font-medium">Accessible depuis</th>
                {showProject && <th className="px-3 py-2 font-medium">Projet</th>}
                <th className="px-3 py-2 font-medium">Service</th>
                <th className="px-3 py-2 font-medium">Port du conteneur</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {ports.map(({ item, port, public: open }) => (
                <tr key={`${item.container.id}-${port.ip}-${port.hostPort}-${port.protocol}`}>
                  <td className="px-3 py-2">
                    <PortChip port={port} />
                  </td>
                  <td className="px-3 py-2">
                    {open ? (
                      <span className="flex items-center gap-1.5">
                        <Globe className="text-success size-3.5" />
                        {port.ip ? `l’adresse ${port.ip}` : 'Internet (toutes les interfaces)'}
                      </span>
                    ) : (
                      <span className="text-muted-foreground flex items-center gap-1.5">
                        <Lock className="size-3.5" />
                        l’hôte seulement
                      </span>
                    )}
                  </td>
                  {showProject && (
                    <td className="px-3 py-2">
                      <span className="flex items-center gap-2">
                        <ProjectAvatar project={item.project} size="sm" />
                        {item.project.name}
                        {item.project.environments.length > 1 && (
                          <span className="text-muted-foreground text-xs">{item.env.name}</span>
                        )}
                      </span>
                    </td>
                  )}
                  <td className="px-3 py-2 font-medium">{item.container.service}</td>
                  <td className="text-muted-foreground px-3 py-2 font-mono text-xs">
                    {port.containerPort}/{port.protocol}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {hasPublic && (
        <p className="text-muted-foreground flex gap-2 text-xs">
          <TriangleAlert className="text-warning mt-0.5 size-3.5 shrink-0" />
          <span>
            Docker ouvre lui-même les ports publics dans le pare-feu de l’hôte, même si ufw ou
            firewalld les bloquent. Derrière un proxy (Traefik, nginx), publiez plutôt sur{' '}
            <code>127.0.0.1:PORT:PORT</code>, ou utilisez un réseau partagé avec le proxy.
          </span>
        </p>
      )}
    </div>
  )
}
