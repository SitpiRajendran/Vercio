import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Download, EyeOff, FileCode2 } from 'lucide-react'
import type { ProjectView } from '@vercio/shared'
import { CodeBlock } from '@/components/common/copy-field'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import { formatDateTime, formatRelative } from '@/lib/format'

function download(content: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/yaml;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

/** Fichier Compose de l'environnement choisi : source, ajouts de Vercio, fichier final. */
export function ComposeFileCard({ project, envId }: { project: ProjectView; envId: string }) {
  const environment = project.environments.find((env) => env.id === envId)
  const view = useQuery({
    queryKey: ['compose-file', envId],
    queryFn: () => api.deployments.compose(project.id, envId),
    enabled: Boolean(envId),
  })
  const [tab, setTab] = useState<'source' | 'override' | 'merged'>('merged')
  const data = view.data
  const prefix = `${project.slug}-${environment?.slug ?? 'env'}`

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileCode2 className="size-4" />
          {environment ? `Environnement ${environment.name}` : 'Fichier Compose'}
        </CardTitle>
        <CardDescription>
          {data?.deployed ? (
            <>
              Dernier déploiement{' '}
              <span title={formatDateTime(data.deployed.at)}>
                {formatRelative(data.deployed.at)}
              </span>
              .
            </>
          ) : (
            'Jamais déployé : seul votre fichier est disponible.'
          )}
          {data?.source.location && <> Source : {data.source.location}.</>}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {view.isPending && <Skeleton className="h-64 w-full" />}
        {view.error && (
          <Alert variant="destructive">
            <AlertDescription>{view.error.message}</AlertDescription>
          </Alert>
        )}
        {data && (
          <>
            {data.masked.length > 0 && (
              <p className="text-muted-foreground flex items-start gap-2 text-xs">
                <EyeOff className="mt-0.5 size-3.5 shrink-0" />
                Valeurs masquées : {data.masked.join(', ')}. Les valeurs des variables se gèrent
                dans l’onglet Variables.
              </p>
            )}
            <Tabs
              value={data.deployed ? tab : 'source'}
              onValueChange={(value) => setTab(value as typeof tab)}
            >
              <TabsList>
                <TabsTrigger value="merged" disabled={!data.deployed}>
                  Fichier final
                </TabsTrigger>
                <TabsTrigger value="source">Votre fichier</TabsTrigger>
                <TabsTrigger value="override" disabled={!data.deployed}>
                  Ajouts de Vercio
                </TabsTrigger>
              </TabsList>
              <TabsContent value="merged" className="space-y-2 pt-2">
                <p className="text-muted-foreground text-xs">
                  Ce que Docker a reçu : votre fichier et les ajouts de Vercio fusionnés par{' '}
                  <code>docker compose config</code>. Les <code>${'{VARIABLES}'}</code> restent sous
                  forme de référence.
                </p>
                {data.deployed?.merged ? (
                  <FileView
                    content={data.deployed.merged}
                    filename={`${prefix}-compose.final.yml`}
                  />
                ) : (
                  <Alert>
                    <AlertDescription>
                      Fusion impossible : {data.deployed?.mergeError ?? 'jamais déployé'}. Les deux
                      fichiers restent consultables dans les autres onglets.
                    </AlertDescription>
                  </Alert>
                )}
              </TabsContent>
              <TabsContent value="source" className="space-y-2 pt-2">
                <p className="text-muted-foreground text-xs">
                  {data.source.origin === 'git'
                    ? 'Le fichier du dépôt, tel qu’il est aujourd’hui sur la branche de l’environnement.'
                    : 'Le fichier collé dans Vercio.'}
                </p>
                {data.source.content !== null ? (
                  <FileView content={data.source.content} filename={`${prefix}-compose.yml`} />
                ) : (
                  <Alert variant="destructive">
                    <AlertDescription>{data.source.error}</AlertDescription>
                  </Alert>
                )}
              </TabsContent>
              <TabsContent value="override" className="space-y-2 pt-2">
                <p className="text-muted-foreground text-xs">
                  <code>compose.vercio.yml</code>, ajouté par Vercio : images épinglées par digest,
                  politique de redémarrage, étiquettes, réseaux partagés et liaisons entre projets,
                  ports ouverts depuis Vercio, relais de page d’attente et de mise à jour sans
                  coupure.
                </p>
                {data.deployed && (
                  <FileView
                    content={data.deployed.override}
                    filename={`${prefix}-compose.vercio.yml`}
                  />
                )}
              </TabsContent>
            </Tabs>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function FileView({ content, filename }: { content: string; filename: string }) {
  return (
    <div className="space-y-2">
      <div className="max-h-[32rem] overflow-y-auto">
        <CodeBlock code={content} label={filename} />
      </div>
      <Button variant="outline" size="sm" onClick={() => download(content, filename)}>
        <Download />
        Télécharger
      </Button>
    </div>
  )
}
