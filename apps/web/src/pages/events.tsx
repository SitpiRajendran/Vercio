import { useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Download, History, Loader2, ScrollText } from 'lucide-react'
import {
  AUDIT_ACTION_GROUPS,
  hasRole,
  type ActivityItem,
  type ActivityQuery,
  type AuditEntryView,
  type AuditQuery,
} from '@vercio/shared'
import { ActivityList } from '@/components/events/activity-list'
import { PageHeader } from '@/components/layout/app-layout'
import { StickyTabsList } from '@/components/layout/sticky-tabs-list'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import { Tabs, TabsContent, TabsTrigger } from '@/components/ui/tabs'
import { api } from '@/lib/api'
import { useCurrentUser } from '@/lib/auth'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { EmptyState } from './settings/resource-list'

const ALL = 'all'
const PAGE = 50

export function EventsPage() {
  const { data: user } = useCurrentUser()
  const isAdmin = user ? hasRole(user.roles, 'vercio-admin') : false
  return (
    <>
      <PageHeader title="Événements" description="Déploiements, webhooks et journal d’audit" />
      <div className="p-4 md:p-6">
        <Tabs defaultValue="activity">
          <StickyTabsList>
            <TabsTrigger value="activity">Activité des projets</TabsTrigger>
            {isAdmin && <TabsTrigger value="audit">Journal d’audit</TabsTrigger>}
          </StickyTabsList>
          <TabsContent value="activity" className="pt-4">
            <ActivityTab />
          </TabsContent>
          {isAdmin && (
            <TabsContent value="audit" className="pt-4">
              <AuditTab />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </>
  )
}

function ActivityTab() {
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects.list })
  const [project, setProject] = useState(ALL)
  const [kind, setKind] = useState(ALL)
  const activity = useInfiniteQuery({
    queryKey: ['events', 'activity', project, kind],
    queryFn: ({ pageParam }) =>
      api.events.activity({
        project: project === ALL ? undefined : project,
        kind: kind === ALL ? undefined : (kind as ActivityQuery['kind']),
        before: pageParam,
        limit: PAGE,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: ActivityItem[]) =>
      last.length === PAGE ? last.at(-1)?.at : undefined,
    refetchInterval: 15_000,
  })
  const items = activity.data?.pages.flat() ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="size-4" />
          Activité des projets
        </CardTitle>
        <CardDescription>
          Déploiements, retours de version, pushs, actions sur les conteneurs et pannes, du plus
          récent au plus ancien.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-3">
          <Select value={project} onValueChange={setProject}>
            <SelectTrigger className="w-56" aria-label="Projet">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tous les projets</SelectItem>
              {projects.data?.map((item) => (
                <SelectItem key={item.slug} value={item.slug}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger className="w-64" aria-label="Type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Tout</SelectItem>
              <SelectItem value="deployment">Déploiements</SelectItem>
              <SelectItem value="webhook">Pushs (webhooks)</SelectItem>
              <SelectItem value="action">Démarrages, arrêts, redémarrages</SelectItem>
              <SelectItem value="incident">Pannes</SelectItem>
              <SelectItem value="backup">Sauvegardes</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {activity.isPending && <Skeleton className="h-40 w-full" />}
        {activity.error && <p className="text-destructive text-sm">{activity.error.message}</p>}
        {activity.data && items.length === 0 && (
          <EmptyState icon={<History />} title="Aucune activité">
            Les déploiements, pushs et actions sur les conteneurs apparaîtront ici.
          </EmptyState>
        )}
        {items.length > 0 && <ActivityList items={items} />}
        {activity.hasNextPage && (
          <Button
            variant="secondary"
            onClick={() => activity.fetchNextPage()}
            disabled={activity.isFetchingNextPage}
          >
            {activity.isFetchingNextPage && <Loader2 className="animate-spin" />}
            Plus ancien
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

function AuditTab() {
  const usernames = useQuery({ queryKey: ['audit', 'users'], queryFn: api.audit.users })
  const [username, setUsername] = useState(ALL)
  const [action, setAction] = useState(ALL)
  const [success, setSuccess] = useState(ALL)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const filters: AuditQuery = {
    user: username === ALL ? undefined : username,
    action: action === ALL ? undefined : action,
    success: success === ALL ? undefined : (success as 'true' | 'false'),
    from: from || undefined,
    to: to || undefined,
  }
  const audit = useInfiniteQuery({
    queryKey: ['audit', filters],
    queryFn: ({ pageParam }) => api.audit.list({ ...filters, before: pageParam, limit: 100 }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last: AuditEntryView[]) =>
      last.length === 100 ? last.at(-1)?.id : undefined,
  })
  const entries = audit.data?.pages.flat() ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ScrollText className="size-4" />
          Journal d’audit
        </CardTitle>
        <CardDescription>
          Toutes les actions des utilisateurs : connexions, paramètres, projets, déploiements,
          conteneurs. Le journal ne peut être ni modifié ni effacé depuis Vercio.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <FilterField label="Utilisateur" id="audit-user">
            <Select value={username} onValueChange={setUsername}>
              <SelectTrigger id="audit-user" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Tous</SelectItem>
                {usernames.data?.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>
          <FilterField label="Action" id="audit-action">
            <Select value={action} onValueChange={setAction}>
              <SelectTrigger id="audit-action" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Toutes</SelectItem>
                {AUDIT_ACTION_GROUPS.map((group) => (
                  <SelectItem key={group.prefix} value={group.prefix}>
                    {group.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>
          <FilterField label="Résultat" id="audit-success">
            <Select value={success} onValueChange={setSuccess}>
              <SelectTrigger id="audit-success" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>Tous</SelectItem>
                <SelectItem value="true">Succès</SelectItem>
                <SelectItem value="false">Échecs</SelectItem>
              </SelectContent>
            </Select>
          </FilterField>
          <FilterField label="Du" id="audit-from">
            <Input
              id="audit-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </FilterField>
          <FilterField label="Au" id="audit-to">
            <Input id="audit-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </FilterField>
        </div>
        <div>
          <Button variant="secondary" asChild>
            <a href={api.audit.exportUrl(filters)} download>
              <Download />
              Exporter en CSV
            </a>
          </Button>
        </div>

        {audit.isPending && <Skeleton className="h-40 w-full" />}
        {audit.error && <p className="text-destructive text-sm">{audit.error.message}</p>}
        {audit.data && entries.length === 0 && (
          <p className="text-muted-foreground text-sm">Aucune entrée pour ces filtres.</p>
        )}
        {entries.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-left text-xs">
                <tr className="border-b">
                  <th className="py-2 pr-3 font-medium">Date</th>
                  <th className="py-2 pr-3 font-medium">Utilisateur</th>
                  <th className="py-2 pr-3 font-medium">Action</th>
                  <th className="py-2 pr-3 font-medium">Cible</th>
                  <th className="py-2 pr-3 font-medium">Adresse IP</th>
                  <th className="py-2 font-medium">Résultat</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {entries.map((entry) => (
                  <tr key={entry.id} className="align-top">
                    <td className="py-2 pr-3 text-xs whitespace-nowrap tabular-nums">
                      {formatDateTime(entry.at)}
                    </td>
                    <td className="py-2 pr-3">{entry.username ?? '—'}</td>
                    <td className="py-2 pr-3">
                      <code className="text-xs">{entry.action}</code>
                      {entry.details && (
                        <details className="mt-1">
                          <summary className="text-muted-foreground cursor-pointer text-xs">
                            Détails
                          </summary>
                          <pre className="bg-muted mt-1 max-w-md overflow-x-auto rounded p-2 text-xs">
                            {JSON.stringify(entry.details, null, 2)}
                          </pre>
                        </details>
                      )}
                    </td>
                    <td className="max-w-56 truncate py-2 pr-3" title={entry.target ?? undefined}>
                      {entry.target ?? '—'}
                    </td>
                    <td className="py-2 pr-3 font-mono text-xs">{entry.ip ?? '—'}</td>
                    <td className="py-2">
                      <Badge variant="outline">
                        <span
                          className={cn(
                            'size-2 rounded-full',
                            entry.success ? 'bg-success' : 'bg-destructive',
                          )}
                        />
                        {entry.success ? 'Succès' : 'Échec'}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {audit.hasNextPage && (
          <Button
            variant="secondary"
            onClick={() => audit.fetchNextPage()}
            disabled={audit.isFetchingNextPage}
          >
            {audit.isFetchingNextPage && <Loader2 className="animate-spin" />}
            Plus ancien
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

function FilterField({
  label,
  id,
  children,
}: {
  label: string
  id: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
    </div>
  )
}
