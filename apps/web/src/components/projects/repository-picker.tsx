import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, GitBranch, Loader2, Lock, Search } from 'lucide-react'
import type { RepositorySummary } from '@vercio/shared'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useDebounced } from '@/lib/use-debounced'

export interface PickedRepository {
  gitProviderId: string
  repository: RepositorySummary
}

/** Choix d'un fournisseur Git puis d'un dépôt, avec recherche. */
export function RepositoryPicker({
  value,
  onChange,
}: {
  value: PickedRepository | null
  onChange: (value: PickedRepository) => void
}) {
  const providers = useQuery({
    queryKey: ['catalog', 'git-providers'],
    queryFn: api.catalog.gitProviders,
  })
  const [providerId, setProviderId] = useState<string | null>(value?.gitProviderId ?? null)
  const [search, setSearch] = useState('')
  const query = useDebounced(search, 300)
  const effectiveProvider = providerId ?? providers.data?.[0]?.id ?? null

  const repositories = useQuery({
    queryKey: ['catalog', 'repositories', effectiveProvider, query],
    queryFn: () => api.catalog.repositories(effectiveProvider!, query),
    enabled: Boolean(effectiveProvider),
  })

  if (providers.data?.length === 0) {
    return (
      <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
        Aucun fournisseur Git configuré. Un administrateur doit d’abord ajouter GitLab ou GitHub
        dans les Paramètres.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_1fr]">
        <Select value={effectiveProvider ?? undefined} onValueChange={setProviderId}>
          <SelectTrigger aria-label="Fournisseur Git" className="w-full">
            <SelectValue placeholder="Fournisseur" />
          </SelectTrigger>
          <SelectContent>
            {providers.data?.map((provider) => (
              <SelectItem key={provider.id} value={provider.id}>
                {provider.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative">
          <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
          <Input
            aria-label="Rechercher un dépôt"
            placeholder="Rechercher un dépôt…"
            className="pl-8"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>

      <div className="max-h-64 overflow-y-auto rounded-lg border">
        {repositories.isFetching && !repositories.data && (
          <div className="flex justify-center p-4">
            <Loader2 className="text-muted-foreground size-5 animate-spin" />
          </div>
        )}
        {repositories.error && (
          <p className="text-destructive p-3 text-sm">{repositories.error.message}</p>
        )}
        {repositories.data?.length === 0 && (
          <p className="text-muted-foreground p-3 text-sm">Aucun dépôt trouvé.</p>
        )}
        <ul role="listbox" aria-label="Dépôts">
          {repositories.data?.map((repository) => {
            const selected =
              value?.gitProviderId === effectiveProvider &&
              value.repository.fullName === repository.fullName
            return (
              <li key={repository.fullName}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => onChange({ gitProviderId: effectiveProvider!, repository })}
                  className={cn(
                    'hover:bg-accent flex w-full items-center gap-3 border-b px-3 py-2 text-left text-sm last:border-b-0',
                    selected && 'bg-accent',
                  )}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{repository.fullName}</span>
                    <span className="text-muted-foreground flex items-center gap-1 text-xs">
                      <GitBranch className="size-3" />
                      {repository.defaultBranch ?? 'dépôt vide'}
                      {repository.private && (
                        <>
                          <Lock className="ml-2 size-3" />
                          privé
                        </>
                      )}
                    </span>
                  </span>
                  {selected && <Check className="size-4" />}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
