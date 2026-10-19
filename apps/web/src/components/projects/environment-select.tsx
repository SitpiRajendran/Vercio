import type { ProjectView } from '@vercio/shared'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function EnvironmentSelect({
  project,
  value,
  onChange,
}: {
  project: ProjectView
  value: string
  onChange: (envId: string) => void
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-full sm:w-64" aria-label="Environnement">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {project.environments.map((env) => (
          <SelectItem key={env.id} value={env.id}>
            {env.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
