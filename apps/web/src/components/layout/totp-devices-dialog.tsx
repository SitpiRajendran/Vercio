import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plus, Smartphone, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { MAX_TOTP_DEVICES, type TotpDeviceView } from '@vercio/shared'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
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
import { Skeleton } from '@/components/ui/skeleton'
import { api } from '@/lib/api'
import { formatDateTime, formatRelative } from '@/lib/format'

const QUERY_KEY = ['totp-devices']

/**
 * Applications d'authentification du compte connecté : liste, ajout, suppression.
 * Il en reste toujours une ; ajout et suppression demandent le mot de passe actuel.
 */
export function TotpDevicesDialog({ onClose }: { onClose: () => void }) {
  const devices = useQuery({ queryKey: QUERY_KEY, queryFn: api.totpDevices.list })
  const [mode, setMode] = useState<
    { kind: 'list' } | { kind: 'add' } | { kind: 'remove'; device: TotpDeviceView }
  >({ kind: 'list' })
  const back = () => setMode({ kind: 'list' })
  const list = devices.data ?? []

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {mode.kind === 'add' && <AddDevice onDone={back} />}
        {mode.kind === 'remove' && <RemoveDevice device={mode.device} onDone={back} />}
        {mode.kind === 'list' && (
          <>
            <DialogHeader>
              <DialogTitle>Double authentification</DialogTitle>
              <DialogDescription>
                Chacune de ces applications permet de vous connecter. Ajoutez-en une deuxième (un
                autre téléphone, un gestionnaire de mots de passe) pour ne pas perdre l’accès.
              </DialogDescription>
            </DialogHeader>
            {devices.isPending && <Skeleton className="h-16 w-full" />}
            {devices.error && (
              <Alert variant="destructive">
                <AlertDescription>{devices.error.message}</AlertDescription>
              </Alert>
            )}
            <ul className="divide-y rounded-lg border">
              {list.map((device) => (
                <li key={device.id} className="flex items-center gap-3 p-3">
                  <Smartphone className="text-muted-foreground size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{device.name}</p>
                    <p className="text-muted-foreground text-xs">
                      <span title={formatDateTime(device.createdAt)}>
                        Ajoutée {formatRelative(device.createdAt)}
                      </span>
                      {' · '}
                      {device.lastUsedAt ? (
                        <span title={formatDateTime(device.lastUsedAt)}>
                          utilisée {formatRelative(device.lastUsedAt)}
                        </span>
                      ) : (
                        'jamais utilisée'
                      )}
                    </p>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    disabled={list.length <= 1}
                    title={
                      list.length <= 1
                        ? 'Gardez au moins une application : ajoutez-en une autre d’abord'
                        : 'Supprimer'
                    }
                    aria-label={`Supprimer ${device.name}`}
                    onClick={() => setMode({ kind: 'remove', device })}
                  >
                    <Trash2 />
                  </Button>
                </li>
              ))}
            </ul>
            {list.length === 1 && (
              <p className="text-muted-foreground text-xs">
                Une application au moins est obligatoire : pour en changer, ajoutez la nouvelle
                avant de supprimer l’ancienne.
              </p>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                Fermer
              </Button>
              <Button
                onClick={() => setMode({ kind: 'add' })}
                disabled={!devices.data || list.length >= MAX_TOTP_DEVICES}
              >
                <Plus />
                Ajouter une application
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function AddDevice({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient()
  const setup = useQuery({
    queryKey: ['totp-devices', 'setup'],
    queryFn: api.totpDevices.setup,
    // Un nouveau secret à chaque ouverture, jamais réutilisé depuis le cache.
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
    meta: { keep: true },
  })
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const add = useMutation({
    mutationFn: () => api.totpDevices.add({ name: name.trim(), code, currentPassword }),
    onSuccess: (device) => {
      toast.success(`« ${device.name} » ajoutée`)
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      onDone()
    },
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    add.mutate()
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>Ajouter une application</DialogTitle>
        <DialogDescription>
          Scannez le QR code avec la nouvelle application (Google Authenticator, Microsoft
          Authenticator, Bitwarden, 1Password…), puis saisissez le code qu’elle affiche.
        </DialogDescription>
      </DialogHeader>
      {setup.isPending && <Skeleton className="mx-auto size-44" />}
      {setup.error && (
        <Alert variant="destructive">
          <AlertDescription>{setup.error.message}</AlertDescription>
        </Alert>
      )}
      {setup.data && (
        <div className="space-y-2">
          <img
            src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.data.qrSvg)}`}
            alt="QR code de configuration"
            className="mx-auto size-44 rounded-lg bg-white p-2"
          />
          <p className="text-muted-foreground text-center text-xs">
            Ou saisissez cette clé manuellement :
          </p>
          <code className="bg-muted block rounded px-2 py-1 text-center font-mono text-xs break-all select-all">
            {setup.data.secret.match(/.{1,4}/g)?.join(' ')}
          </code>
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="totp-name">Nom</Label>
        <Input
          id="totp-name"
          placeholder="Téléphone personnel, Bitwarden…"
          maxLength={64}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="totp-code">Code affiché par l’application</Label>
        <Input
          id="totp-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="123456"
          maxLength={6}
          className="font-mono tracking-widest"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="totp-password">Mot de passe actuel</Label>
        <Input
          id="totp-password"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
      </div>
      {add.error && (
        <Alert variant="destructive">
          <AlertDescription>{add.error.message}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Retour
        </Button>
        <Button
          type="submit"
          disabled={
            add.isPending || !setup.data || !name.trim() || code.length !== 6 || !currentPassword
          }
        >
          {add.isPending && <Loader2 className="animate-spin" />}
          Ajouter
        </Button>
      </DialogFooter>
    </form>
  )
}

function RemoveDevice({ device, onDone }: { device: TotpDeviceView; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [currentPassword, setCurrentPassword] = useState('')
  const remove = useMutation({
    mutationFn: () => api.totpDevices.remove(device.id, currentPassword),
    onSuccess: () => {
      toast.success(`« ${device.name} » supprimée`)
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      onDone()
    },
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    remove.mutate()
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>Supprimer « {device.name} » ?</DialogTitle>
        <DialogDescription>
          Ses codes ne permettront plus de vous connecter. Pensez à retirer aussi Vercio de
          l’application.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-1.5">
        <Label htmlFor="remove-password">Mot de passe actuel</Label>
        <Input
          id="remove-password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
      </div>
      {remove.error && (
        <Alert variant="destructive">
          <AlertDescription>{remove.error.message}</AlertDescription>
        </Alert>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Retour
        </Button>
        <Button type="submit" variant="destructive" disabled={remove.isPending || !currentPassword}>
          {remove.isPending && <Loader2 className="animate-spin" />}
          Supprimer
        </Button>
      </DialogFooter>
    </form>
  )
}
