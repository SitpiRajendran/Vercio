import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { VariableView } from '@vercio/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

interface Row {
  id: number
  key: string
  value: string
  secret: boolean
  /** Secret déjà enregistré : vide = valeur conservée. */
  stored: boolean
}

let nextId = 0
const toRows = (variables: VariableView[]): Row[] =>
  variables.map((variable) => ({
    id: nextId++,
    key: variable.key,
    value: variable.value ?? '',
    secret: variable.secret,
    stored: variable.secret,
  }))

/** Nom évocateur (mot de passe, token…) ou URL contenant des identifiants. */
function looksSecret(key: string, value: string): boolean {
  return (
    /SECRET|PASSW|PWD|TOKEN|KEY|CREDENTIAL|PRIVATE/i.test(key) ||
    /:\/\/[^/\s:@]+:[^@\s]+@/.test(value)
  )
}

/** Analyse un bloc `.env` collé : CLE=valeur par ligne, commentaires ignorés. */
function parseDotEnv(text: string): { key: string; value: string }[] {
  return text.split('\n').flatMap((line) => {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!match) return []
    let value = match[2]!
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
    return [{ key: match[1]!, value }]
  })
}

export function VariablesEditor({
  projectId,
  environmentId,
  canEdit,
}: {
  projectId: string
  environmentId?: string
  canEdit: boolean
}) {
  const queryKey = ['projects', projectId, 'variables', environmentId ?? 'shared']
  const variables = useQuery({
    queryKey,
    queryFn: () => api.projects.variables(projectId, environmentId),
  })
  return variables.data ? (
    <Editor
      key={variables.dataUpdatedAt}
      initial={variables.data}
      projectId={projectId}
      environmentId={environmentId}
      canEdit={canEdit}
      queryKey={queryKey}
    />
  ) : variables.error ? (
    <p className="text-destructive text-sm">{variables.error.message}</p>
  ) : (
    <Skeleton className="h-32 w-full" />
  )
}

function Editor({
  initial,
  projectId,
  environmentId,
  canEdit,
  queryKey,
}: {
  initial: VariableView[]
  projectId: string
  environmentId?: string
  canEdit: boolean
  queryKey: string[]
}) {
  const queryClient = useQueryClient()
  const [rows, setRows] = useState<Row[]>(() => toRows(initial))
  const [revealed, setRevealed] = useState<Set<number>>(new Set())
  const [importing, setImporting] = useState(false)
  const [dotenv, setDotenv] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api.projects.saveVariables(projectId, environmentId, {
        variables: rows
          .filter((row) => row.key.trim())
          .map((row) => ({
            key: row.key.trim(),
            value: row.secret && row.stored && row.value === '' ? null : row.value,
            secret: row.secret,
          })),
      }),
    onSuccess: async () => {
      toast.success('Variables enregistrées')
      await queryClient.invalidateQueries({ queryKey })
    },
    onError: (error) => toast.error(error.message),
  })

  const update = (id: number, patch: Partial<Row>) =>
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)))

  function importDotEnv() {
    const parsed = parseDotEnv(dotenv)
    setRows((current) => {
      const next = [...current]
      for (const { key, value } of parsed) {
        const existing = next.find((row) => row.key === key)
        if (existing) Object.assign(existing, { value, stored: false })
        else
          next.push({
            id: nextId++,
            key,
            value,
            secret: looksSecret(key, value),
            stored: false,
          })
      }
      return next
    })
    toast.success(`${parsed.length} variable(s) importée(s)`)
    setDotenv('')
    setImporting(false)
  }

  return (
    <div className="space-y-3">
      {rows.length === 0 && (
        <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-sm">
          Aucune variable.
        </p>
      )}
      {rows.map((row) => (
        <div key={row.id} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          <Input
            aria-label="Nom de la variable"
            className="font-mono text-xs sm:w-56"
            placeholder="NOM"
            value={row.key}
            disabled={!canEdit}
            onChange={(event) => update(row.id, { key: event.target.value.toUpperCase() })}
          />
          <Input
            aria-label={`Valeur de ${row.key || 'la variable'}`}
            className={cn('min-w-0 flex-1 font-mono text-xs')}
            type={row.secret && !revealed.has(row.id) ? 'password' : 'text'}
            placeholder={row.stored ? '•••••• (inchangé)' : 'valeur'}
            value={row.value}
            disabled={!canEdit}
            autoComplete="off"
            onChange={(event) => update(row.id, { value: event.target.value })}
          />
          {row.secret && !row.stored && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Afficher la valeur"
              onClick={() =>
                setRevealed((current) => {
                  const next = new Set(current)
                  if (next.has(row.id)) next.delete(row.id)
                  else next.add(row.id)
                  return next
                })
              }
            >
              {revealed.has(row.id) ? <EyeOff /> : <Eye />}
            </Button>
          )}
          <Button
            type="button"
            variant={row.secret ? 'secondary' : 'ghost'}
            size="sm"
            disabled={!canEdit}
            title="Un secret est chiffré et n’est plus jamais affiché après enregistrement"
            onClick={() => update(row.id, { secret: !row.secret, stored: false })}
          >
            <KeyRound />
            {row.secret ? 'Secret' : 'Visible'}
          </Button>
          {canEdit && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Supprimer ${row.key}`}
              onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))}
            >
              <Trash2 />
            </Button>
          )}
        </div>
      ))}

      {importing && (
        <div className="space-y-2">
          <Textarea
            aria-label="Contenu .env"
            rows={5}
            className="font-mono text-xs"
            placeholder={'NODE_ENV=production\nDB_PASSWORD=…'}
            value={dotenv}
            onChange={(event) => setDotenv(event.target.value)}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={importDotEnv} disabled={!dotenv.trim()}>
              Importer
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setImporting(false)}>
              Annuler
            </Button>
          </div>
        </div>
      )}

      {canEdit && (
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setRows((current) => [
                ...current,
                { id: nextId++, key: '', value: '', secret: false, stored: false },
              ])
            }
          >
            <Plus />
            Ajouter
          </Button>
          {!importing && (
            <Button variant="ghost" size="sm" onClick={() => setImporting(true)}>
              Coller un .env
            </Button>
          )}
          <Button
            size="sm"
            className="ml-auto"
            onClick={() => save.mutate()}
            disabled={save.isPending}
          >
            {save.isPending && <Loader2 className="animate-spin" />}
            Enregistrer les variables
          </Button>
        </div>
      )}
    </div>
  )
}
