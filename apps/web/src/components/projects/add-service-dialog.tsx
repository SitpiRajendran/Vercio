import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import type { EnvironmentView, ProjectView } from '@vercio/shared'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api, ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'

interface EnvRow {
  key: string
  value: string
  secret: boolean
}

interface Preset {
  id: string
  label: string
  hint: string
  name: string
  image: string
  port: number | null
  environment: EnvRow[]
  dataPath: string
  /** Outil à ouvrir dans le navigateur : port ouvert proposé. */
  open: boolean
}

function randomSecret(length = 24) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const values = crypto.getRandomValues(new Uint32Array(length))
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join('')
}

const PRESETS: () => Preset[] = () => [
  {
    id: 'drizzle',
    label: 'Drizzle Gateway',
    hint: 'Interface web (Drizzle Studio) pour parcourir et modifier les bases',
    name: 'drizzle-gateway',
    image: 'ghcr.io/drizzle-team/gateway:latest',
    port: 4983,
    environment: [
      { key: 'PORT', value: '4983', secret: false },
      { key: 'STORE_PATH', value: '/app', secret: false },
      { key: 'MASTERPASS', value: randomSecret(), secret: true },
    ],
    dataPath: '/app',
    open: true,
  },
  {
    id: 'adminer',
    label: 'Adminer',
    hint: 'Petite interface web pour PostgreSQL, MySQL, MariaDB',
    name: 'adminer',
    image: 'adminer:latest',
    port: 8080,
    environment: [],
    dataPath: '',
    open: true,
  },
  {
    id: 'custom',
    label: 'Autre image',
    hint: 'N’importe quelle image Docker',
    name: '',
    image: '',
    port: null,
    environment: [],
    dataPath: '',
    open: false,
  },
]

/**
 * Ajoute un service à un projet dont le fichier Compose est géré par Vercio (collé ou « service
 * seul ») : outil d'administration à côté d'une base, cache… Port ouvert et déploiement en option.
 */
export function AddServiceDialog({
  project,
  environment,
  onClose,
}: {
  project: ProjectView
  environment: EnvironmentView
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [preset, setPreset] = useState<Preset | null>(null)
  const [name, setName] = useState('')
  const [image, setImage] = useState('')
  const [port, setPort] = useState('')
  const [rows, setRows] = useState<EnvRow[]>([])
  const [dataPath, setDataPath] = useState('')
  const [open, setOpen] = useState(false)
  const [published, setPublished] = useState('')
  const [deploy, setDeploy] = useState(true)
  const [error, setError] = useState<{ message: string; field?: string } | null>(null)

  function choose(next: Preset) {
    setPreset(next)
    setName(next.name)
    setImage(next.image)
    setPort(next.port ? String(next.port) : '')
    setRows(next.environment.map((row) => ({ ...row })))
    setDataPath(next.dataPath)
    setOpen(next.open)
    setPublished(next.port ? String(next.port) : '')
    setError(null)
  }

  const add = useMutation({
    mutationFn: async () => {
      const targetPort = Number(port) || null
      const result = await api.projects.addService(project.id, {
        name,
        image,
        port: targetPort,
        environment: rows.filter((row) => row.key.trim()),
        dataPath: dataPath.trim() || null,
      })
      if (open && targetPort && Number(published)) {
        await api.projects.ports(project.id, environment.id, {
          ports: [
            ...environment.publishedPorts,
            {
              service: name,
              published: Number(published),
              target: targetPort,
              protocol: 'tcp',
              page: false,
            },
          ],
        })
      }
      const deployment = deploy ? await api.deployments.start(project.id, environment.id) : null
      return { result, deployment }
    },
    onSuccess: async ({ deployment }) => {
      await queryClient.invalidateQueries()
      toast.success(
        `${name} ajouté à ${project.name}${deployment ? ' · déploiement lancé' : ' : déployez pour le démarrer'}`,
      )
      onClose()
    },
    onError: (failure) =>
      setError({
        message: failure.message,
        field: failure instanceof ApiError ? failure.field : undefined,
      }),
  })

  const single = project.type === 'single'
  const valid =
    /^[a-z][a-z0-9_-]{0,39}$/.test(name) &&
    image.trim().length > 0 &&
    rows.every((row) => !row.key || /^[A-Za-z_][A-Za-z0-9_]*$/.test(row.key)) &&
    (!open || (Number(port) > 0 && Number(published) > 0))

  return (
    <Dialog open onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="max-h-[90svh] grid-cols-[minmax(0,1fr)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Ajouter un service à {project.name}</DialogTitle>
          <DialogDescription>
            Le service rejoint le projet : il joint les autres par leur nom (par exemple{' '}
            <code>postgres:5432</code>) sans rien ouvrir de plus.
          </DialogDescription>
        </DialogHeader>

        {!preset ? (
          <div className="grid gap-2">
            {PRESETS().map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => choose(item)}
                className="hover:border-brand hover:bg-brand/5 rounded-lg border p-3 text-left transition-colors"
              >
                <span className="block text-sm font-medium">{item.label}</span>
                <span className="text-muted-foreground block text-xs">{item.hint}</span>
              </button>
            ))}
          </div>
        ) : (
          <form
            className="min-w-0 space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              setError(null)
              add.mutate()
            }}
          >
            <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
              <div className="space-y-1.5">
                <Label htmlFor="service-name">Nom du service</Label>
                <Input
                  id="service-name"
                  className="font-mono"
                  value={name}
                  aria-invalid={error?.field === 'name'}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="service-port">Port</Label>
                <Input
                  id="service-port"
                  className="font-mono"
                  inputMode="numeric"
                  placeholder="80"
                  value={port}
                  onChange={(event) => setPort(event.target.value.replace(/\D/g, ''))}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="service-image">Image</Label>
              <Input
                id="service-image"
                className="font-mono"
                placeholder="ghcr.io/organisation/outil:1.2"
                value={image}
                aria-invalid={error?.field === 'image'}
                onChange={(event) => setImage(event.target.value)}
              />
            </div>

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Variables</legend>
              {rows.map((row, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    aria-label="Nom"
                    className="h-8 w-40 font-mono"
                    value={row.key}
                    onChange={(event) =>
                      setRows(
                        rows.map((item, i) =>
                          i === index ? { ...item, key: event.target.value } : item,
                        ),
                      )
                    }
                  />
                  <Input
                    aria-label="Valeur"
                    className="h-8 min-w-0 flex-1 font-mono"
                    value={row.value}
                    onChange={(event) =>
                      setRows(
                        rows.map((item, i) =>
                          i === index ? { ...item, value: event.target.value } : item,
                        ),
                      )
                    }
                  />
                  <label
                    className="flex items-center gap-1 text-xs"
                    title="Enregistrée chiffrée dans les variables du projet"
                  >
                    <Checkbox
                      checked={row.secret}
                      onCheckedChange={(checked) =>
                        setRows(
                          rows.map((item, i) =>
                            i === index ? { ...item, secret: checked === true } : item,
                          ),
                        )
                      }
                    />
                    secret
                  </label>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    aria-label={`Retirer ${row.key}`}
                    onClick={() => setRows(rows.filter((_, i) => i !== index))}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setRows([...rows, { key: '', value: '', secret: false }])}
              >
                <Plus />
                Ajouter une variable
              </Button>
              <p className="text-muted-foreground text-xs">
                Les valeurs « secret » vont dans les variables du projet (chiffrées) ; le fichier ne
                contient que <code>{'${NOM}'}</code>. Elles ne seront plus affichées ensuite.
              </p>
              {rows.some((row) => row.secret && row.key === 'MASTERPASS') && (
                <p className="text-warning text-xs">
                  Notez MASTERPASS maintenant (gestionnaire de mots de passe) : c’est le mot de
                  passe demandé par Drizzle Gateway à l’ouverture.
                </p>
              )}
            </fieldset>

            <div className="space-y-1.5">
              <Label htmlFor="service-data">Dossier de données conservé (facultatif)</Label>
              <Input
                id="service-data"
                className="font-mono"
                placeholder="/data"
                value={dataPath}
                onChange={(event) => setDataPath(event.target.value)}
              />
            </div>

            <div className={cn('space-y-2 rounded-lg border p-3', open && 'border-warning/40')}>
              <label className="flex items-center gap-2 text-sm font-medium">
                <Checkbox checked={open} onCheckedChange={(checked) => setOpen(checked === true)} />
                Ouvrir sur le serveur, port
                <Input
                  aria-label="Port du serveur"
                  className="h-8 w-24 font-mono"
                  inputMode="numeric"
                  value={published}
                  disabled={!open}
                  onChange={(event) => setPublished(event.target.value.replace(/\D/g, ''))}
                />
              </label>
              {open && (
                <p className="text-warning flex items-start gap-1.5 text-xs">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                  Joignable depuis Internet : un outil d’administration de base doit être protégé
                  par un mot de passe (ici{' '}
                  {preset.id === 'drizzle' ? 'MASTERPASS' : 'celui de l’outil'}), ou laissé fermé et
                  joint par le VPN.
                </p>
              )}
            </div>

            {single && (
              <Alert>
                <AlertDescription className="text-xs">
                  {project.name} devient un projet Compose : ses variables actuelles restent
                  attribuées à son service, et le nouveau service ne reçoit que les siennes.
                </AlertDescription>
              </Alert>
            )}

            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={deploy}
                onCheckedChange={(checked) => setDeploy(checked === true)}
              />
              Déployer {environment.name} maintenant
            </label>

            {error && <p className="text-destructive text-sm">{error.message}</p>}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setPreset(null)}>
                Retour
              </Button>
              <Button type="submit" disabled={add.isPending || !valid}>
                {add.isPending && <Loader2 className="animate-spin" />}
                Ajouter
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
