import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Cloud,
  HardDrive,
  KeyRound,
  Loader2,
  LockOpen,
  Pencil,
  Plus,
  PlugZap,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  BACKUP_DESTINATION_LABELS,
  type BackupDestinationInput,
  type BackupDestinationType,
  type BackupDestinationView,
  type LocalDestinationConfig,
  type S3DestinationConfig,
} from '@vercio/shared'
import { VercioBackupCard } from '@/components/settings/vercio-backup-card'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api, ApiError } from '@/lib/api'
import { ConnectionResult } from './connection-result'
import { Field } from './form-fields'
import { EmptyState } from './resource-list'

export const backupDestinationsKey = ['settings', 'backup-destinations'] as const

/** Paramètres → Sauvegardes : où partent les sauvegardes des environnements. */
export function BackupsSettingsTab() {
  const destinations = useQuery({
    queryKey: backupDestinationsKey,
    queryFn: api.backupDestinations.list,
  })
  const [editing, setEditing] = useState<BackupDestinationView | 'new' | null>(null)

  return (
    <div className="space-y-4">
      <VercioBackupCard />
      <h2 className="pt-2 text-base font-semibold">Destinations</h2>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground max-w-2xl text-sm">
          Où envoyer les sauvegardes. Choisissez ensuite, dans chaque projet (onglet « Sauvegardes
          »), quoi sauvegarder et à quelle fréquence. Préférez un stockage hors de ce serveur : un
          disque qui lâche emporterait aussi des sauvegardes locales.
        </p>
        <Button onClick={() => setEditing('new')}>
          <Plus />
          Ajouter une destination
        </Button>
      </div>
      {destinations.isPending && <Skeleton className="h-36 w-full" />}
      {destinations.error && (
        <p className="text-destructive text-sm">{destinations.error.message}</p>
      )}
      {destinations.data?.length === 0 && (
        <EmptyState icon={<HardDrive />} title="Aucune destination">
          Ajoutez un bucket S3 (AWS, Scaleway, OVH, MinIO…) ou un dossier du serveur, par exemple un
          disque réseau monté.
        </EmptyState>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {destinations.data?.map((destination) => (
          <DestinationCard
            key={destination.id}
            destination={destination}
            onEdit={() => setEditing(destination)}
          />
        ))}
      </div>
      {editing && (
        <DestinationDialog
          destination={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function DestinationCard({
  destination,
  onEdit,
}: {
  destination: BackupDestinationView
  onEdit: () => void
}) {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const remove = useMutation({
    mutationFn: () => api.backupDestinations.remove(destination.id),
    onSuccess: async () => {
      setConfirming(false)
      toast.success(`« ${destination.name} » supprimée`)
      await queryClient.invalidateQueries({ queryKey: backupDestinationsKey })
    },
    onError: (error) => toast.error(error.message),
  })
  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2">
          <span className="text-muted-foreground [&_svg]:size-4">
            {destination.type === 's3' ? <Cloud /> : <HardDrive />}
          </span>
          <span className="truncate">{destination.name}</span>
        </CardTitle>
        <CardDescription className="truncate font-mono text-xs">
          {destination.location}
        </CardDescription>
        <CardAction>
          {destination.encrypted ? (
            <span className="text-success flex items-center gap-1 text-xs">
              <KeyRound className="size-3.5" />
              Chiffrée
            </span>
          ) : (
            <span className="text-muted-foreground flex items-center gap-1 text-xs">
              <LockOpen className="size-3.5" />
              En clair
            </span>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {destination.hostPath === null && (
          <p className="text-destructive flex items-start gap-1.5 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Ce dossier est à l’intérieur du conteneur de Vercio, pas sur le serveur : les
              sauvegardes seraient perdues à sa prochaine recréation (mise à jour). Choisissez un
              dossier sous <code>/var/lib/vercio</code>, ou montez-en un dans docker-compose.yml.
            </span>
          </p>
        )}
        {destination.hostPath && (
          <p className="text-muted-foreground text-xs">
            Sur le serveur :{' '}
            <span className="text-foreground font-mono">{destination.hostPath}</span>
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          {BACKUP_DESTINATION_LABELS[destination.type]} ·{' '}
          {destination.plans > 0
            ? `Utilisée par ${destination.plans} sauvegarde${destination.plans > 1 ? 's' : ''} planifiée${destination.plans > 1 ? 's' : ''}`
            : 'Non utilisée'}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" onClick={onEdit}>
            <Pencil />
            Modifier
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirming(true)}
            disabled={destination.plans > 0}
            title={
              destination.plans > 0 ? 'Utilisée par des sauvegardes (projets ou Vercio)' : undefined
            }
          >
            <Trash2 />
            Supprimer
          </Button>
        </div>
      </CardContent>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer « {destination.name} » ?</DialogTitle>
            <DialogDescription>
              Les fichiers déjà envoyés restent dans la destination ; Vercio oublie seulement les
              identifiants et la phrase de chiffrement. Gardez-la si vous voulez relire ces
              sauvegardes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Annuler
            </Button>
            <Button
              variant="destructive"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              {remove.isPending && <Loader2 className="animate-spin" />}
              Supprimer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function DestinationDialog({
  destination,
  onClose,
}: {
  destination: BackupDestinationView | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const s3Config = destination?.type === 's3' ? (destination.config as S3DestinationConfig) : null
  const [type, setType] = useState<BackupDestinationType>(destination?.type ?? 's3')
  const [name, setName] = useState(destination?.name ?? '')
  const [path, setPath] = useState(
    destination?.type === 'local'
      ? (destination.config as LocalDestinationConfig).path
      : '/var/lib/vercio/sauvegardes',
  )
  const [endpoint, setEndpoint] = useState(s3Config?.endpoint ?? '')
  const [region, setRegion] = useState(s3Config?.region ?? 'us-east-1')
  const [bucket, setBucket] = useState(s3Config?.bucket ?? '')
  const [prefix, setPrefix] = useState(s3Config?.prefix ?? 'vercio')
  const [pathStyle, setPathStyle] = useState(s3Config?.pathStyle ?? false)
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [encrypt, setEncrypt] = useState(destination ? destination.encrypted : true)
  const [passphrase, setPassphrase] = useState('')

  const input = (): BackupDestinationInput => {
    // Chiffrement : nouvelle phrase si saisie, sinon inchangée (ou retirée si décoché).
    const phrase = !encrypt
      ? null
      : passphrase
        ? passphrase
        : destination?.encrypted
          ? undefined
          : ''
    const common = { name, ...(phrase === undefined ? {} : { passphrase: phrase }) }
    if (type === 'local') return { ...common, type, config: { path } }
    return {
      ...common,
      type,
      config: { endpoint, region, bucket, prefix, pathStyle },
      ...(accessKeyId || secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    }
  }

  const test = useMutation({
    mutationFn: () => api.backupDestinations.test(input(), destination?.id),
  })
  const save = useMutation({
    mutationFn: () =>
      destination
        ? api.backupDestinations.update(destination.id, input())
        : api.backupDestinations.create(input()),
    onSuccess: async (saved) => {
      toast.success(`« ${saved.name} » enregistrée`)
      await queryClient.invalidateQueries({ queryKey: backupDestinationsKey })
      onClose()
    },
  })
  const fieldError = (field: string) =>
    save.error instanceof ApiError && save.error.field?.endsWith(field) ? save.error.message : null
  const passphraseChanged = destination?.encrypted && encrypt && passphrase

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault()
            save.mutate()
          }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>
              {destination ? `Modifier « ${destination.name} »` : 'Ajouter une destination'}
            </DialogTitle>
            <DialogDescription>
              Vercio y écrit, relit (restauration) et efface les sauvegardes trop anciennes.
            </DialogDescription>
          </DialogHeader>
          <Field id="bd-type" label="Type">
            <Select
              value={type}
              onValueChange={(value) => setType(value as BackupDestinationType)}
              disabled={!!destination}
            >
              <SelectTrigger id="bd-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="s3">{BACKUP_DESTINATION_LABELS.s3}</SelectItem>
                <SelectItem value="local">{BACKUP_DESTINATION_LABELS.local}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field id="bd-name" label="Nom" error={fieldError('name')}>
            <Input
              id="bd-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={type === 's3' ? 'Bucket Scaleway' : 'Disque de sauvegarde'}
              required
            />
          </Field>
          {type === 'local' ? (
            <Field
              id="bd-path"
              label="Dossier"
              error={fieldError('path')}
              hint="Chemin vu par Vercio. /var/lib/vercio est sur le serveur au même chemin : /var/lib/vercio/sauvegardes, par exemple. Pour un autre disque ou un partage réseau, montez-le dans docker-compose.yml."
            >
              <Input
                id="bd-path"
                className="font-mono"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                required
              />
            </Field>
          ) : (
            <>
              <Field
                id="bd-endpoint"
                label="Adresse du service"
                error={fieldError('endpoint')}
                hint="Vide pour AWS. Ex. https://s3.fr-par.scw.cloud, https://s3.gra.io.cloud.ovh.net, http://minio:9000"
              >
                <Input
                  id="bd-endpoint"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://…"
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="bd-bucket" label="Bucket" error={fieldError('bucket')}>
                  <Input
                    id="bd-bucket"
                    value={bucket}
                    onChange={(e) => setBucket(e.target.value)}
                    required
                  />
                </Field>
                <Field id="bd-region" label="Région" error={fieldError('region')}>
                  <Input
                    id="bd-region"
                    value={region}
                    onChange={(e) => setRegion(e.target.value)}
                  />
                </Field>
              </div>
              <Field
                id="bd-prefix"
                label="Dossier dans le bucket"
                error={fieldError('prefix')}
                hint="Les sauvegardes vont dans <dossier>/<projet>/<environnement>/<date>."
              >
                <Input id="bd-prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="bd-key" label="Clé d’accès">
                  <Input
                    id="bd-key"
                    autoComplete="off"
                    value={accessKeyId}
                    onChange={(e) => setAccessKeyId(e.target.value)}
                    placeholder={destination?.hasCredentials ? 'Inchangée' : ''}
                    required={!destination?.hasCredentials}
                  />
                </Field>
                <Field id="bd-secret" label="Clé secrète">
                  <Input
                    id="bd-secret"
                    type="password"
                    autoComplete="off"
                    value={secretAccessKey}
                    onChange={(e) => setSecretAccessKey(e.target.value)}
                    placeholder={destination?.hasCredentials ? 'Inchangée' : ''}
                    required={!destination?.hasCredentials || !!accessKeyId}
                  />
                </Field>
              </div>
              <p className="text-muted-foreground text-xs">
                Droits nécessaires sur le bucket : lister, lire, écrire et supprimer des objets.
              </p>
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <Label htmlFor="bd-path-style">Adresse « chemin » (path-style)</Label>
                  <p className="text-muted-foreground text-xs">MinIO et certains hébergeurs.</p>
                </div>
                <Switch id="bd-path-style" checked={pathStyle} onCheckedChange={setPathStyle} />
              </div>
            </>
          )}

          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor="bd-encrypt">Chiffrer les sauvegardes</Label>
                <p className="text-muted-foreground text-xs">
                  Chiffrées avant l’envoi (AES-256) : l’hébergeur ne peut pas les lire.
                </p>
              </div>
              <Switch id="bd-encrypt" checked={encrypt} onCheckedChange={setEncrypt} />
            </div>
            {encrypt && (
              <Field
                id="bd-passphrase"
                label="Phrase de chiffrement"
                error={fieldError('passphrase')}
                hint={
                  destination?.encrypted
                    ? 'Vide = inchangée.'
                    : 'Notez-la hors de Vercio (gestionnaire de mots de passe) : sans elle, une sauvegarde chiffrée est illisible si ce serveur est perdu.'
                }
              >
                <Input
                  id="bd-passphrase"
                  type="password"
                  autoComplete="new-password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  placeholder={destination?.encrypted ? 'Inchangée' : '12 caractères au moins'}
                  required={!destination?.encrypted}
                  minLength={12}
                />
              </Field>
            )}
            {passphraseChanged && (
              <p className="text-warning text-xs">
                Les sauvegardes déjà faites restent chiffrées avec l’ancienne phrase : Vercio ne
                pourra plus les restaurer.
              </p>
            )}
          </div>

          {test.data && <ConnectionResult check={test.data} />}
          {test.error && <p className="text-destructive text-sm">{test.error.message}</p>}
          {save.error && !(save.error instanceof ApiError && save.error.field) && (
            <p className="text-destructive text-sm">{save.error.message}</p>
          )}
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => test.mutate()}
              disabled={test.isPending}
            >
              {test.isPending ? <Loader2 className="animate-spin" /> : <PlugZap />}
              Tester
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Loader2 className="animate-spin" />}
              Enregistrer
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
