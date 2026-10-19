import { useQuery } from '@tanstack/react-query'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { api } from '@/lib/api'

/** Liste des branches d'un dépôt ; la branche par défaut est signalée. */
export function BranchSelect({
  gitProviderId,
  repository,
  value,
  onChange,
  id,
}: {
  gitProviderId: string
  repository: string
  value: string
  onChange: (branch: string) => void
  id?: string
}) {
  const branches = useQuery({
    queryKey: ['catalog', 'branches', gitProviderId, repository],
    queryFn: () => api.catalog.branches(gitProviderId, repository),
    staleTime: 60_000,
  })
  const names = branches.data?.map((branch) => branch.name) ?? []
  // La valeur courante reste sélectionnable même si la branche a disparu ou n'est pas chargée.
  const options = names.includes(value) || !value ? names : [value, ...names]

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full" aria-label={`Branche de ${repository}`}>
        <SelectValue placeholder={branches.isPending ? 'Chargement…' : 'Branche'} />
      </SelectTrigger>
      <SelectContent>
        {options.map((name) => (
          <SelectItem key={name} value={name}>
            {name}
            {branches.data?.find((branch) => branch.name === name)?.isDefault && (
              <span className="text-muted-foreground ml-1 text-xs">(par défaut)</span>
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
