import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { KeyRound, TriangleAlert } from 'lucide-react'
import type { ComposeAnalysis, ProjectView, VariableView } from '@vercio/shared'
import { VariablesEditor } from '@/components/projects/variables-editor'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { useProjectCompose } from '@/lib/project-compose'
import { cn } from '@/lib/utils'

const SHARED = 'shared'

interface Effective {
  key: string
  secret: boolean
  value: string | null
  origin: 'shared' | 'environment' | 'override'
  /** Services qui l'utilisent ; null : tous (service seul, env_file). */
  services: string[]
}

/** Variables réellement appliquées à un environnement, et les services qui s'en servent. */
function effectiveVariables(
  project: ProjectView,
  shared: VariableView[],
  own: VariableView[],
  analysis: ComposeAnalysis | undefined,
): Effective[] {
  const result = new Map<string, Effective>()
  for (const variable of shared) {
    result.set(variable.key, { ...variable, origin: 'shared', services: [] })
  }
  for (const variable of own) {
    result.set(variable.key, {
      ...variable,
      origin: result.has(variable.key) ? 'override' : 'environment',
      services: [],
    })
  }
  const services = analysis?.services ?? []
  for (const item of result.values()) {
    item.services = services
      .filter(
        (service) =>
          project.type === 'single' || service.envFile || service.variables.includes(item.key),
      )
      .map((service) => service.name)
  }
  return [...result.values()].sort((a, b) => a.key.localeCompare(b.key))
}

const ORIGIN_LABELS = {
  shared: 'Partagée',
  environment: 'Cet environnement',
  override: 'Cet environnement (remplace la partagée)',
}

export function VariablesTab({
  project,
  environmentId,
  canEdit,
}: {
  project: ProjectView
  /** Environnement choisi dans l'en-tête. */
  environmentId: string
  canEdit: boolean
}) {
  const environment = project.environments.find((env) => env.id === environmentId)!
  const several = project.environments.length > 1
  const [scope, setScope] = useState(several ? environmentId : SHARED)
  const compose = useProjectCompose(project)
  const shared = useQuery({
    queryKey: ['projects', project.id, 'variables', 'shared'],
    queryFn: () => api.projects.variables(project.id),
  })
  const own = useQuery({
    queryKey: ['projects', project.id, 'variables', environmentId],
    queryFn: () => api.projects.variables(project.id, environmentId),
  })
  const analysis = compose.data?.analysis
  const effective =
    shared.data && own.data
      ? effectiveVariables(project, shared.data, own.data, analysis?.error ? undefined : analysis)
      : null
  const serviceNames = analysis?.services.map((service) => service.name) ?? []
  const unused = effective?.filter((item) => item.services.length === 0) ?? []

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>
            Ce que reçoit chaque service{several ? ` (${environment.name})` : ''}
          </CardTitle>
          <CardDescription>
            {project.type === 'single'
              ? 'Service seul : toutes les variables sont transmises au conteneur.'
              : 'Un service reçoit une variable s’il la cite dans le fichier Compose (${NOM} ou environment: [NOM]), ou s’il lit un env_file.'}{' '}
            Pour voir les valeurs dans un conteneur en marche : « Inspecter » dans son menu.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!effective && <Skeleton className="h-24 w-full" />}
          {effective?.length === 0 && (
            <p className="text-muted-foreground text-sm">Aucune variable définie dans Vercio.</p>
          )}
          {effective && effective.length > 0 && (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="text-muted-foreground text-left text-xs">
                  <tr className="border-b">
                    <th className="px-3 py-2 font-medium">Variable</th>
                    <th className="px-3 py-2 font-medium">Valeur</th>
                    <th className="px-3 py-2 font-medium">Origine</th>
                    <th className="px-3 py-2 font-medium">Utilisée par</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {effective.map((item) => (
                    <tr key={item.key}>
                      <td className="px-3 py-2 font-mono text-xs font-medium">{item.key}</td>
                      <td className="max-w-64 truncate px-3 py-2 font-mono text-xs">
                        {item.secret ? (
                          <span className="text-muted-foreground flex items-center gap-1">
                            <KeyRound className="size-3" />
                            secret
                          </span>
                        ) : (
                          <span title={item.value ?? ''}>{item.value || '(vide)'}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <span
                          className={cn(
                            item.origin === 'override' && 'text-warning',
                            item.origin === 'shared' && 'text-muted-foreground',
                          )}
                        >
                          {ORIGIN_LABELS[item.origin]}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        {item.services.length === 0 ? (
                          <span className="text-warning flex items-center gap-1 text-xs">
                            <TriangleAlert className="size-3" />
                            aucun service
                          </span>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            {item.services.length === serviceNames.length &&
                            serviceNames.length > 1 ? (
                              <Badge variant="secondary">tous les services</Badge>
                            ) : (
                              item.services.map((service) => (
                                <Badge key={service} variant="secondary" className="font-mono">
                                  {service}
                                </Badge>
                              ))
                            )}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {unused.length > 0 && project.type !== 'single' && (
            <p className="text-muted-foreground text-xs">
              Une variable utilisée par aucun service n’atteint aucun conteneur. Pour la
              transmettre, ajoutez-la à l’<code>environment</code> du service dans le fichier
              Compose : <code>- {unused[0]!.key}</code> (la valeur vient de Vercio).
            </p>
          )}
          {compose.error && (
            <p className="text-destructive text-xs">
              Fichier Compose illisible ({compose.error.message}) : services inconnus.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Modifier les variables</CardTitle>
          <CardDescription>
            {several
              ? 'Les variables partagées valent pour tous les environnements ; celles d’un environnement les remplacent. '
              : ''}
            Les secrets sont chiffrés et ne sont plus jamais affichés. Appliquées au prochain
            déploiement.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {several && (
            <div
              role="radiogroup"
              aria-label="Portée"
              className="bg-muted inline-flex rounded-md p-0.5"
            >
              {[
                { id: environmentId, label: `${environment.name} seulement` },
                { id: SHARED, label: 'Partagées (tous les environnements)' },
              ].map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={scope === option.id}
                  onClick={() => setScope(option.id)}
                  className={cn(
                    'rounded px-3 py-1 text-sm',
                    scope === option.id ? 'bg-background shadow-xs' : 'text-muted-foreground',
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
          <VariablesEditor
            key={scope}
            projectId={project.id}
            environmentId={scope === SHARED ? undefined : scope}
            canEdit={canEdit}
          />
        </CardContent>
      </Card>
    </div>
  )
}
