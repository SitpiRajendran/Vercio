import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Database, FolderInput, HardDrive, Loader2, RefreshCw } from 'lucide-react'
import type { ExternalComposeProject } from '@vercio/shared'
import { CodeBlock } from '@/components/common/copy-field'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/** Choix d'un projet Compose lancé hors de Vercio, avec ce que la reprise va changer. */
export function ImportPicker({
  value,
  onChange,
  importVariables,
  onImportVariablesChange,
}: {
  value: ExternalComposeProject | null
  onChange: (project: ExternalComposeProject) => void
  importVariables: boolean
  onImportVariablesChange: (value: boolean) => void
}) {
  const projects = useQuery({
    queryKey: ['projects', 'imports'],
    queryFn: api.projects.imports,
    retry: false,
  })

  if (projects.isPending) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" />
        Recherche des projets Compose de l’hôte…
      </p>
    )
  }
  if (projects.error) {
    return <p className="text-destructive text-sm">{projects.error.message}</p>
  }
  if (projects.data.length === 0) {
    return (
      <div className="space-y-3 rounded-lg border border-dashed p-6 text-center">
        <FolderInput className="text-muted-foreground mx-auto size-8" />
        <p className="font-medium">Aucun projet Compose lancé hors de Vercio</p>
        <p className="text-muted-foreground text-sm">
          Vercio liste les projets démarrés avec <code>docker compose up</code> sur cet hôte, y
          compris arrêtés.
        </p>
        <Button variant="secondary" size="sm" onClick={() => projects.refetch()}>
          <RefreshCw />
          Rechercher à nouveau
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {projects.data.map((project) => {
          const running = project.services.filter((service) => service.state === 'running')
          return (
            <button
              key={project.name}
              type="button"
              aria-pressed={value?.name === project.name}
              onClick={() => onChange(project)}
              className={cn(
                'hover:border-foreground/30 rounded-lg border p-3 text-left transition-colors',
                value?.name === project.name && 'border-primary ring-primary ring-1',
              )}
            >
              <p className="font-mono text-sm font-medium">{project.name}</p>
              <p className="text-muted-foreground truncate text-xs">
                {project.workingDir ?? 'dossier inconnu'}
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                {project.services.length} service(s), {running.length} en marche
              </p>
            </button>
          )
        })}
      </div>
      {value && (
        <MigrationReport
          project={value}
          importVariables={importVariables}
          onImportVariablesChange={onImportVariablesChange}
        />
      )}
    </div>
  )
}

function MigrationReport({
  project,
  importVariables,
  onImportVariablesChange,
}: {
  project: ExternalComposeProject
  importVariables: boolean
  onImportVariablesChange: (value: boolean) => void
}) {
  const ports = project.services.flatMap((service) =>
    service.ports.map((port) => `${service.name} ${port}`),
  )
  return (
    <div className="space-y-4 rounded-lg border p-4 text-sm">
      <p className="font-medium">Ce que fera la reprise de « {project.name} »</p>
      <ul className="text-muted-foreground list-disc space-y-1.5 pl-5">
        <li>
          Le projet devient un projet Vercio : ses conteneurs sont recréés sous le nom{' '}
          <code>vercio_&lt;projet&gt;_&lt;environnement&gt;</code> au premier déploiement.
        </li>
        <li>
          À ce moment, les conteneurs actuels sont <strong>arrêtés</strong> (ce qui libère leurs
          ports{ports.length ? ` : ${ports.join(', ')}` : ''}), puis supprimés si le déploiement
          réussit, ou relancés s’il échoue.
        </li>
        <li>Rien ne change avant ce premier déploiement.</li>
      </ul>

      <div className="space-y-2">
        <p className="flex items-center gap-2 font-medium">
          <Database className="size-4" />
          Volumes
        </p>
        {project.volumes.length ? (
          <ul className="space-y-1">
            {project.volumes.map((volume) => (
              <li key={volume.name} className="flex flex-wrap items-center gap-2">
                <code className="text-xs">{volume.key}</code>
                <span className="text-muted-foreground text-xs">→ volume existant</span>
                <code className="text-xs">{volume.name}</code>
                <Badge variant="secondary">repris tel quel, sans copie</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-xs">Aucun volume nommé.</p>
        )}
      </div>

      {project.relativeBinds.length > 0 && (
        <div className="space-y-2">
          <p className="text-warning flex items-center gap-2 font-medium">
            <HardDrive className="size-4" />
            Dossiers montés depuis le dossier d’origine : à copier
          </p>
          <p className="text-muted-foreground text-xs">
            Vercio résout les chemins relatifs du fichier Compose dans le dossier de l’environnement
            (<code>VERCIO_DATA_DIR/envs/&lt;projet&gt;/&lt;environnement&gt;</code>
            ). Copiez ces dossiers avant le premier déploiement, ou remplacez-les par un chemin
            absolu dans le fichier :
          </p>
          <ul className="text-xs">
            {project.relativeBinds.map((bind) => (
              <li key={`${bind.service}-${bind.source}`}>
                <code>{bind.source}</code> → {bind.service}:<code>{bind.target}</code>
              </li>
            ))}
          </ul>
          {project.workingDir && (
            <CodeBlock
              label="Copie des dossiers"
              code={[...new Set(project.relativeBinds.map((bind) => bind.source))]
                .map(
                  (source) =>
                    `cp -a "${project.workingDir}/${source.slice(2)}" "$VERCIO_DATA_DIR/envs/<projet>/<environnement>/${source.slice(2)}"`,
                )
                .join('\n')}
            />
          )}
        </div>
      )}

      <div className="space-y-2">
        <p className="font-medium">Variables (.env)</p>
        {project.env === null ? (
          <p className="text-muted-foreground text-xs">Pas de fichier .env dans le dossier.</p>
        ) : 'error' in project.env ? (
          <p className="text-warning flex items-start gap-2 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {project.env.path} : {project.env.error} Vous pourrez saisir les variables dans l’onglet
            Variables.
          </p>
        ) : (
          <>
            <div className="flex items-start gap-2">
              <Checkbox
                id="import-variables"
                checked={importVariables}
                onCheckedChange={(checked) => onImportVariablesChange(checked === true)}
                className="mt-0.5"
              />
              <Label htmlFor="import-variables" className="font-normal">
                Importer les {project.env.variables.length} variables de {project.env.path}{' '}
                (chiffrées dans Vercio ; communes à tous les environnements)
              </Label>
            </div>
            <ul className="flex flex-wrap gap-1.5">
              {project.env.variables.map((variable) => (
                <li key={variable.key}>
                  <Badge variant="outline" className="font-mono">
                    {variable.key}
                    {variable.secret && <span className="text-muted-foreground">· secrète</span>}
                  </Badge>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
