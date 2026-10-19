import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { AlertCircle, Boxes, KeyRound, Loader2, ShieldCheck } from 'lucide-react'
import { PASSWORD_MIN_LENGTH, SSO_ERRORS, type SsoError } from '@vercio/shared'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { api, ApiError } from '@/lib/api'
import { meQueryKey } from '@/lib/auth'

type Step = 'credentials' | 'totp' | 'totp_setup' | 'password_change'

export function LoginPage() {
  const { erreur } = useSearch({ from: '/connexion' })
  const authConfig = useQuery({
    queryKey: ['auth', 'config'],
    queryFn: api.authConfig,
    retry: 1,
    // Serveur injoignable : on réessaie tout seul, la page se débloque dès qu'il répond.
    refetchInterval: (query) => (query.state.status === 'error' ? 5000 : false),
  })
  const [step, setStep] = useState<Step>('credentials')

  const ssoError = erreur && erreur in SSO_ERRORS ? SSO_ERRORS[erreur as SsoError] : null
  const config = authConfig.data

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center justify-center gap-2">
          <div className="bg-primary text-primary-foreground flex size-9 items-center justify-center rounded-lg">
            <Boxes className="size-5" />
          </div>
          <span className="text-2xl font-semibold tracking-tight">Vercio</span>
        </div>

        {step === 'credentials' && config?.setupRequired && (
          <FirstRun onNext={() => setStep('totp_setup')} />
        )}

        {step === 'credentials' && !config?.setupRequired && (
          <Card>
            <CardHeader>
              <CardTitle>Connexion</CardTitle>
              <CardDescription>Gérez vos projets Docker et leurs déploiements.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {ssoError && <ErrorAlert>{ssoError}</ErrorAlert>}
              {authConfig.isPending && <Loader2 className="mx-auto size-5 animate-spin" />}
              {authConfig.isError && (
                <ServerUnavailable
                  error={authConfig.error}
                  retrying={authConfig.isFetching}
                  onRetry={() => void authConfig.refetch()}
                />
              )}
              {config?.localEnabled && <CredentialsForm onNext={setStep} />}
              {config?.localEnabled && config.oidcEnabled && (
                <div className="flex items-center gap-3">
                  <Separator className="flex-1" />
                  <span className="text-muted-foreground text-xs">ou</span>
                  <Separator className="flex-1" />
                </div>
              )}
              {config?.oidcEnabled && (
                <Button
                  className="w-full"
                  variant={config.localEnabled ? 'outline' : 'default'}
                  asChild
                >
                  <a href="/api/auth/oidc/login">
                    <KeyRound />
                    Se connecter avec {config.oidcProviderName}
                  </a>
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        {step === 'totp' && (
          <TotpVerify
            onCancel={() => setStep('credentials')}
            onPasswordChange={() => setStep('password_change')}
          />
        )}
        {step === 'totp_setup' && (
          <TotpSetup
            onCancel={() => setStep('credentials')}
            onPasswordChange={() => setStep('password_change')}
          />
        )}
        {step === 'password_change' && <InitialPassword onCancel={() => setStep('credentials')} />}
      </div>
    </main>
  )
}

function ServerUnavailable({
  error,
  retrying,
  onRetry,
}: {
  error: Error
  retrying: boolean
  onRetry: () => void
}) {
  // Le proxy de développement ou le reverse proxy répondent 502 / 503 / 504 quand l'API est arrêtée.
  const down = !(error instanceof ApiError) || error.status >= 500
  return (
    <div className="space-y-3">
      <ErrorAlert>
        {down
          ? 'Le serveur Vercio ne répond pas. Vérifiez qu’il est démarré et que sa base de données est joignable (journal du serveur).'
          : error.message}
      </ErrorAlert>
      <Button variant="outline" className="w-full" onClick={onRetry} disabled={retrying}>
        {retrying && <Loader2 className="animate-spin" />}
        Réessayer
      </Button>
      <p className="text-muted-foreground text-center text-xs">
        Nouvel essai automatique toutes les 5 s.
      </p>
    </div>
  )
}

function CredentialsForm({ onNext }: { onNext: (step: Step) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const login = useMutation({
    mutationFn: api.login,
    onSuccess: ({ next }) => onNext(next),
  })

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    login.mutate({ username, password })
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="username">Identifiant</Label>
        <Input
          id="username"
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Mot de passe</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>
      {login.error && <ErrorAlert>{login.error.message}</ErrorAlert>}
      <Button type="submit" className="w-full" disabled={login.isPending}>
        {login.isPending && <Loader2 className="animate-spin" />}
        Continuer
      </Button>
    </form>
  )
}

/** Session ouverte : entre dans l'application. */
function useEnterApp() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  return async () => {
    // Remplace le `null` en cache avant de quitter la page, sinon le layout redirige ici.
    queryClient.setQueryData(meQueryKey, await api.me())
    await navigate({ to: '/' })
  }
}

/** Saisie du code à 6 chiffres ; valide automatiquement au 6e chiffre. */
function useTotpSubmit(onPasswordChange: () => void) {
  const enterApp = useEnterApp()
  const [code, setCode] = useState('')
  const verify = useMutation({
    mutationFn: api.totpVerify,
    onSuccess: async ({ next }) => {
      if (next === 'password_change') onPasswordChange()
      else await enterApp()
    },
    onError: () => setCode(''),
  })
  const onChange = (value: string) => {
    setCode(value)
    if (value.length === 6) verify.mutate({ code: value })
  }
  return { code, onChange, verify }
}

function CodeInput({
  code,
  onChange,
  disabled,
}: {
  code: string
  onChange: (v: string) => void
  disabled: boolean
}) {
  return (
    <div className="flex justify-center">
      <InputOTP
        maxLength={6}
        value={code}
        onChange={onChange}
        disabled={disabled}
        autoFocus
        inputMode="numeric"
        pattern="^[0-9]*$"
        aria-label="Code de vérification"
      >
        <InputOTPGroup>
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <InputOTPSlot key={index} index={index} />
          ))}
        </InputOTPGroup>
      </InputOTP>
    </div>
  )
}

interface TotpStepProps {
  onCancel: () => void
  onPasswordChange: () => void
}

function TotpVerify({ onCancel, onPasswordChange }: TotpStepProps) {
  const { code, onChange, verify } = useTotpSubmit(onPasswordChange)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-5" />
          Double authentification
        </CardTitle>
        <CardDescription>
          Saisissez le code affiché par votre application d’authentification.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <CodeInput code={code} onChange={onChange} disabled={verify.isPending} />
        {verify.error && <ErrorAlert>{verify.error.message}</ErrorAlert>}
      </CardContent>
      <CardFooter>
        <Button variant="ghost" className="w-full" onClick={onCancel}>
          Retour
        </Button>
      </CardFooter>
    </Card>
  )
}

function TotpSetup({ onCancel, onPasswordChange }: TotpStepProps) {
  const setup = useMutation({ mutationFn: api.totpSetup })
  const { code, onChange, verify } = useTotpSubmit(onPasswordChange)
  const { mutate } = setup

  useEffect(() => {
    mutate()
  }, [mutate])

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-5" />
          Activer la double authentification
        </CardTitle>
        <CardDescription>
          Obligatoire pour les comptes locaux. Scannez ce QR code avec une application comme Google
          Authenticator, Microsoft Authenticator, Bitwarden ou 1Password.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {setup.isPending && <Loader2 className="mx-auto size-6 animate-spin" />}
        {setup.error && <ErrorAlert>{setup.error.message}</ErrorAlert>}
        {setup.data && (
          <>
            <img
              src={`data:image/svg+xml;utf8,${encodeURIComponent(setup.data.qrSvg)}`}
              alt="QR code de configuration"
              className="mx-auto size-44 rounded-lg bg-white p-2"
            />
            <div className="space-y-1 text-center">
              <p className="text-muted-foreground text-xs">Ou saisissez cette clé manuellement :</p>
              <code className="bg-muted block rounded px-2 py-1 font-mono text-xs break-all select-all">
                {setup.data.secret.match(/.{1,4}/g)?.join(' ')}
              </code>
            </div>
            <Separator />
            <p className="text-center text-sm">Puis saisissez le code généré :</p>
            <CodeInput code={code} onChange={onChange} disabled={verify.isPending} />
            {verify.error && <ErrorAlert>{verify.error.message}</ErrorAlert>}
          </>
        )}
      </CardContent>
      <CardFooter>
        <Button variant="ghost" className="w-full" onClick={onCancel}>
          Retour
        </Button>
      </CardFooter>
    </Card>
  )
}

/**
 * Premier lancement : création du premier administrateur. Le code d'installation (fichier .env
 * ou journal du serveur) prouve que la personne a accès au serveur.
 */
function FirstRun({ onNext }: { onNext: () => void }) {
  const [setupCode, setSetupCode] = useState('')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const create = useMutation({ mutationFn: api.firstRun, onSuccess: onNext })
  const fieldError = (field: string) =>
    create.error instanceof ApiError && create.error.field === field ? create.error.message : null
  const otherError =
    create.error && !(create.error instanceof ApiError && create.error.field)
      ? create.error.message
      : null
  const tooShort = password.length > 0 && password.length < PASSWORD_MIN_LENGTH
  const mismatch = confirmation.length > 0 && confirmation !== password

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    create.mutate({ setupCode, username, email, password })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bienvenue dans Vercio</CardTitle>
        <CardDescription>
          Créez le compte administrateur. Vous configurerez ensuite la double authentification avec
          une application sur votre téléphone.
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="space-y-4">
          <Field id="setup-code" label="Code d’installation" error={fieldError('setupCode')}>
            <Input
              id="setup-code"
              autoComplete="off"
              autoFocus
              className="font-mono"
              value={setupCode}
              onChange={(event) => setSetupCode(event.target.value)}
              aria-invalid={Boolean(fieldError('setupCode'))}
            />
            <p className="text-muted-foreground text-xs">
              Affiché à la fin de l’installation (<code>VERCIO_SETUP_CODE</code> du fichier .env),
              ou dans le journal du serveur.
            </p>
          </Field>
          <Separator />
          <Field id="setup-username" label="Identifiant" error={fieldError('username')}>
            <Input
              id="setup-username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value.toLowerCase())}
              placeholder="prenom.nom"
              aria-invalid={Boolean(fieldError('username'))}
            />
          </Field>
          <Field id="setup-email" label="Email" error={fieldError('email')}>
            <Input
              id="setup-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={Boolean(fieldError('email'))}
            />
          </Field>
          <Field id="setup-password" label="Mot de passe" error={fieldError('password')}>
            <Input
              id="setup-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={tooShort}
            />
            <p className={tooShort ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
              {PASSWORD_MIN_LENGTH} caractères minimum. Une phrase de plusieurs mots est idéale.
            </p>
          </Field>
          <Field id="setup-confirmation" label="Confirmation du mot de passe">
            <Input
              id="setup-confirmation"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              aria-invalid={mismatch}
            />
            {mismatch && (
              <p className="text-destructive text-xs">Les deux mots de passe sont différents.</p>
            )}
          </Field>
          {otherError && <ErrorAlert>{otherError}</ErrorAlert>}
        </CardContent>
        <CardFooter className="mt-6">
          <Button
            type="submit"
            className="w-full"
            disabled={
              create.isPending ||
              !setupCode.trim() ||
              !username.trim() ||
              !email.trim() ||
              password.length < PASSWORD_MIN_LENGTH ||
              confirmation !== password
            }
          >
            {create.isPending && <Loader2 className="animate-spin" />}
            Créer le compte et continuer
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string
  label: string
  error?: string | null
  children: ReactNode
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && <p className="text-destructive text-xs">{error}</p>}
    </div>
  )
}

/** Mot de passe temporaire (création du compte, réinitialisation) à remplacer avant d'entrer. */
function InitialPassword({ onCancel }: { onCancel: () => void }) {
  const enterApp = useEnterApp()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const change = useMutation({ mutationFn: api.initialPassword, onSuccess: enterApp })
  const tooShort = password.length > 0 && password.length < PASSWORD_MIN_LENGTH
  const mismatch = confirmation.length > 0 && confirmation !== password

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    change.mutate(password)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-5" />
          Choisissez votre mot de passe
        </CardTitle>
        <CardDescription>
          Votre mot de passe actuel est temporaire. Remplacez-le pour terminer la connexion.
        </CardDescription>
      </CardHeader>
      <form onSubmit={onSubmit}>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-password">Nouveau mot de passe</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={tooShort}
            />
            <p className={tooShort ? 'text-destructive text-xs' : 'text-muted-foreground text-xs'}>
              {PASSWORD_MIN_LENGTH} caractères minimum. Une phrase de plusieurs mots est idéale.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password">Confirmation</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              aria-invalid={mismatch}
            />
            {mismatch && (
              <p className="text-destructive text-xs">Les deux mots de passe sont différents.</p>
            )}
          </div>
          {change.error && <ErrorAlert>{change.error.message}</ErrorAlert>}
        </CardContent>
        <CardFooter className="mt-6 flex-col gap-2">
          <Button
            type="submit"
            className="w-full"
            disabled={
              change.isPending || password.length < PASSWORD_MIN_LENGTH || confirmation !== password
            }
          >
            {change.isPending && <Loader2 className="animate-spin" />}
            Enregistrer et continuer
          </Button>
          <Button type="button" variant="ghost" className="w-full" onClick={onCancel}>
            Retour
          </Button>
        </CardFooter>
      </form>
    </Card>
  )
}

function ErrorAlert({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive" role="alert">
      <AlertCircle />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}
