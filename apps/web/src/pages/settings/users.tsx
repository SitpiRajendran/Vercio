import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  KeyRound,
  Loader2,
  MoreHorizontal,
  Pencil,
  ShieldOff,
  SquareTerminal,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { ROLE_LABELS, ROLES, type Role, type UserView, type UserWithPassword } from '@vercio/shared'
import { CopyField } from '@/components/common/copy-field'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
import { useCurrentUser } from '@/lib/auth'
import { formatDateTime, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'

const QUERY_KEY = ['settings', 'users'] as const

type Dialogs =
  | { kind: 'create' }
  | { kind: 'edit'; user: UserView }
  | { kind: 'confirm'; user: UserView; action: 'reset-password' | 'reset-totp' | 'delete' }
  | { kind: 'password'; result: UserWithPassword; reason: 'create' | 'reset' }
  | null

export function UsersTab() {
  const users = useQuery({ queryKey: QUERY_KEY, queryFn: api.users.list })
  const { data: me } = useCurrentUser()
  const [dialog, setDialog] = useState<Dialogs>(null)
  const close = () => setDialog(null)

  const local = users.data?.filter((user) => user.provider === 'local') ?? []
  const sso = users.data?.filter((user) => user.provider === 'oidc') ?? []

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <Users className="size-4" />
              Comptes locaux
            </CardTitle>
            <CardDescription>
              Créés dans Vercio, avec double authentification obligatoire. Le mot de passe remis à
              la création est temporaire : il est remplacé à la première connexion.
            </CardDescription>
          </div>
          <Button onClick={() => setDialog({ kind: 'create' })}>
            <UserPlus />
            Nouvel utilisateur
          </Button>
        </CardHeader>
        <CardContent>
          {users.isPending && <Skeleton className="h-24 w-full" />}
          {users.error && <p className="text-destructive text-sm">{users.error.message}</p>}
          {local.length > 0 && <UserList users={local} meId={me?.id} onDialog={setDialog} />}
        </CardContent>
      </Card>

      {sso.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Comptes SSO</CardTitle>
            <CardDescription>
              Apparus à leur première connexion. Nom, email et rôles viennent du fournisseur
              (Keycloak) à chaque connexion ; seule la désactivation se gère ici.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <UserList users={sso} meId={me?.id} onDialog={setDialog} />
          </CardContent>
        </Card>
      )}

      {dialog?.kind === 'create' && (
        <UserDialog
          onClose={close}
          onCreated={(result) => setDialog({ kind: 'password', result, reason: 'create' })}
        />
      )}
      {dialog?.kind === 'edit' && (
        <UserDialog user={dialog.user} isSelf={dialog.user.id === me?.id} onClose={close} />
      )}
      {dialog?.kind === 'confirm' && (
        <ConfirmDialog
          user={dialog.user}
          action={dialog.action}
          onClose={close}
          onPassword={(result) => setDialog({ kind: 'password', result, reason: 'reset' })}
        />
      )}
      {dialog?.kind === 'password' && (
        <PasswordDialog result={dialog.result} reason={dialog.reason} onClose={close} />
      )}
      <TerminalAccessCard />
    </div>
  )
}

/** Terminal web : réservé aux administrateurs, ouvert aux déployeurs sur décision explicite. */
function TerminalAccessCard() {
  const queryClient = useQueryClient()
  const settings = useQuery({
    queryKey: ['settings', 'terminal'],
    queryFn: api.terminalSettings.get,
  })
  const update = useMutation({
    mutationFn: api.terminalSettings.update,
    onSuccess: (data) => {
      queryClient.setQueryData(['settings', 'terminal'], data)
      toast.success(
        data.deployers ? 'Terminal ouvert aux déployeurs' : 'Terminal réservé aux administrateurs',
      )
    },
    onError: (error) => toast.error(error.message),
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SquareTerminal className="size-4" />
          Terminal web
        </CardTitle>
        <CardDescription>
          Le terminal donne un shell dans les conteneurs : leurs fichiers, leurs secrets et le
          réseau interne. Dans un conteneur qui monte le socket Docker ou des dossiers de l’hôte,
          c’est l’équivalent d’un accès root au serveur. Il est réservé aux administrateurs ; chaque
          ouverture est inscrite au journal d’audit.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-start gap-3">
          <Switch
            id="terminal-deployers"
            checked={settings.data?.deployers ?? false}
            disabled={!settings.data || update.isPending}
            onCheckedChange={(deployers) => update.mutate({ deployers })}
          />
          <Label htmlFor="terminal-deployers" className="font-normal">
            Autoriser aussi les déployeurs (rôle <code>vercio-deployer</code>) à ouvrir un terminal
          </Label>
        </div>
      </CardContent>
    </Card>
  )
}

function UserList({
  users,
  meId,
  onDialog,
}: {
  users: UserView[]
  meId: string | undefined
  onDialog: (dialog: Dialogs) => void
}) {
  return (
    <div className="divide-y rounded-lg border">
      {users.map((user) => (
        <UserRow key={user.id} user={user} isSelf={user.id === meId} onDialog={onDialog} />
      ))}
    </div>
  )
}

function UserRow({
  user,
  isSelf,
  onDialog,
}: {
  user: UserView
  isSelf: boolean
  onDialog: (dialog: Dialogs) => void
}) {
  const queryClient = useQueryClient()
  const toggle = useMutation({
    mutationFn: () =>
      api.users.update(user.id, {
        displayName: user.displayName,
        email: user.email ?? '',
        role: user.roles[0] ?? 'vercio-viewer',
        disabled: !user.disabled,
      }),
    onSuccess: async (updated) => {
      toast.success(`${updated.displayName} ${updated.disabled ? 'désactivé' : 'réactivé'}`)
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY })
    },
    onError: (error) => toast.error(error.message),
  })
  const isLocal = user.provider === 'local'

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm',
        user.disabled && 'opacity-60',
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">
          {user.displayName}
          {isSelf && <span className="text-muted-foreground ml-2 text-xs font-normal">(vous)</span>}
        </p>
        <p className="text-muted-foreground truncate text-xs">
          {user.username}
          {user.email ? ` · ${user.email}` : ''}
          {' · '}
          {user.lastLoginAt ? (
            <span title={formatDateTime(user.lastLoginAt)}>
              connecté {formatRelative(user.lastLoginAt)}
            </span>
          ) : (
            'jamais connecté'
          )}
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {user.roles.map((role) => (
          <Badge key={role} variant="secondary">
            {ROLE_LABELS[role].label}
          </Badge>
        ))}
        {user.disabled && <Badge variant="outline">Désactivé</Badge>}
        {isLocal && user.passwordChangeRequired && !user.disabled && (
          <Badge variant="outline" className="text-warning">
            Mot de passe temporaire
          </Badge>
        )}
        {isLocal && !user.totpEnabled && !user.disabled && (
          <Badge variant="outline" className="text-muted-foreground">
            2FA à configurer
          </Badge>
        )}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label={`Actions sur ${user.username}`}>
            {toggle.isPending ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {isLocal && (
            <DropdownMenuItem onSelect={() => onDialog({ kind: 'edit', user })}>
              <Pencil />
              Modifier
            </DropdownMenuItem>
          )}
          {isLocal && !isSelf && (
            <>
              <DropdownMenuItem
                onSelect={() => onDialog({ kind: 'confirm', user, action: 'reset-password' })}
              >
                <KeyRound />
                Réinitialiser le mot de passe
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!user.totpEnabled}
                onSelect={() => onDialog({ kind: 'confirm', user, action: 'reset-totp' })}
              >
                <ShieldOff />
                Réinitialiser la double authentification
              </DropdownMenuItem>
            </>
          )}
          {!isSelf && (
            <DropdownMenuItem onSelect={() => toggle.mutate()}>
              {user.disabled ? 'Réactiver' : 'Désactiver'}
            </DropdownMenuItem>
          )}
          {!isSelf && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => onDialog({ kind: 'confirm', user, action: 'delete' })}
              >
                <Trash2 />
                Supprimer
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function UserDialog({
  user,
  isSelf = false,
  onClose,
  onCreated,
}: {
  user?: UserView
  isSelf?: boolean
  onClose: () => void
  onCreated?: (result: UserWithPassword) => void
}) {
  const queryClient = useQueryClient()
  const [username, setUsername] = useState(user?.username ?? '')
  const [displayName, setDisplayName] = useState(user?.displayName ?? '')
  const [email, setEmail] = useState(user?.email ?? '')
  const [role, setRole] = useState<Role>(user?.roles[0] ?? 'vercio-deployer')
  const [disabled, setDisabled] = useState(user?.disabled ?? false)

  const save = useMutation({
    mutationFn: async () => {
      if (user) {
        await api.users.update(user.id, { displayName, email, role, disabled })
        return null
      }
      return api.users.create({ username, displayName, email, role })
    },
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      if (created) onCreated?.(created)
      else {
        toast.success('Utilisateur enregistré')
        onClose()
      }
    },
  })
  const fieldError = (field: string) =>
    save.error instanceof ApiError && save.error.field === field ? save.error.message : null
  const generalError = save.error && !(save.error instanceof ApiError && save.error.field)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            save.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>{user ? `Modifier ${user.username}` : 'Nouvel utilisateur'}</DialogTitle>
            <DialogDescription>
              {user
                ? 'Le changement de rôle s’applique dès la prochaine requête de l’utilisateur.'
                : 'Un mot de passe temporaire sera généré et affiché une seule fois.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="user-username">Identifiant</Label>
            <Input
              id="user-username"
              autoComplete="off"
              className="font-mono"
              value={username}
              disabled={Boolean(user)}
              onChange={(event) => setUsername(event.target.value.toLowerCase())}
              placeholder="prenom.nom"
              aria-invalid={Boolean(fieldError('username'))}
            />
            {fieldError('username') && (
              <p className="text-destructive text-xs">{fieldError('username')}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="user-name">Nom affiché</Label>
            <Input
              id="user-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Prénom Nom"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="user-email">Email (facultatif)</Label>
            <Input
              id="user-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={Boolean(fieldError('email'))}
            />
            {fieldError('email') && (
              <p className="text-destructive text-xs">{fieldError('email')}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="user-role">Rôle</Label>
            <Select
              value={role}
              onValueChange={(value) => setRole(value as Role)}
              disabled={isSelf}
            >
              <SelectTrigger id="user-role" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[...ROLES].map((value) => (
                  <SelectItem key={value} value={value}>
                    {ROLE_LABELS[value].label} — {ROLE_LABELS[value].description}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isSelf && (
              <p className="text-muted-foreground text-xs">
                Vous ne pouvez pas modifier votre propre rôle.
              </p>
            )}
          </div>
          {user && !isSelf && (
            <div className="flex items-center gap-2">
              <Switch id="user-disabled" checked={disabled} onCheckedChange={setDisabled} />
              <Label htmlFor="user-disabled" className="font-normal">
                Compte désactivé (connexion refusée, sessions fermées)
              </Label>
            </div>
          )}
          {generalError && (
            <Alert variant="destructive">
              <AlertDescription>{save.error!.message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Annuler
            </Button>
            <Button
              type="submit"
              disabled={save.isPending || !displayName.trim() || (!user && !username.trim())}
            >
              {save.isPending && <Loader2 className="animate-spin" />}
              {user ? 'Enregistrer' : 'Créer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const CONFIRM = {
  'reset-password': {
    title: 'Réinitialiser le mot de passe de',
    description:
      'Un nouveau mot de passe temporaire est généré ; ses sessions en cours sont fermées.',
    button: 'Réinitialiser',
  },
  'reset-totp': {
    title: 'Réinitialiser la double authentification de',
    description:
      'À sa prochaine connexion, l’utilisateur scannera un nouveau QR code (téléphone perdu ou changé). Ses sessions en cours sont fermées.',
    button: 'Réinitialiser',
  },
  delete: {
    title: 'Supprimer',
    description:
      'Le compte est supprimé définitivement ; l’historique des déploiements et l’audit sont conservés. Pour un compte SSO, préférez la désactivation : il serait recréé à sa prochaine connexion.',
    button: 'Supprimer',
  },
} as const

function ConfirmDialog({
  user,
  action,
  onClose,
  onPassword,
}: {
  user: UserView
  action: 'reset-password' | 'reset-totp' | 'delete'
  onClose: () => void
  onPassword: (result: UserWithPassword) => void
}) {
  const queryClient = useQueryClient()
  const run = useMutation({
    mutationFn: async () => {
      if (action === 'reset-password') return api.users.resetPassword(user.id)
      if (action === 'reset-totp') await api.users.resetTotp(user.id)
      else await api.users.remove(user.id)
      return null
    },
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      if (result) return onPassword(result)
      toast.success(
        action === 'delete'
          ? `${user.displayName} supprimé`
          : `Double authentification de ${user.displayName} réinitialisée`,
      )
      onClose()
    },
    onError: (error) => toast.error(error.message),
  })
  const text = CONFIRM[action]
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {text.title} « {user.displayName} » ?
          </DialogTitle>
          <DialogDescription>{text.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button
            variant={action === 'delete' ? 'destructive' : 'default'}
            disabled={run.isPending}
            onClick={() => run.mutate()}
          >
            {run.isPending && <Loader2 className="animate-spin" />}
            {text.button}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PasswordDialog({
  result,
  reason,
  onClose,
}: {
  result: UserWithPassword
  reason: 'create' | 'reset'
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {reason === 'create' ? 'Compte créé' : 'Mot de passe réinitialisé'} :{' '}
            {result.user.username}
          </DialogTitle>
          <DialogDescription>
            Transmettez ce mot de passe temporaire à {result.user.displayName} par un canal sûr. Il
            ne sera plus jamais affiché. À la première connexion, l’utilisateur configurera la
            double authentification puis choisira son propre mot de passe.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="temporary-password">Mot de passe temporaire</Label>
          <CopyField id="temporary-password" value={result.temporaryPassword} />
        </div>
        <DialogFooter>
          <Button onClick={onClose}>J’ai transmis le mot de passe</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
