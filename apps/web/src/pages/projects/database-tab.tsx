import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Database,
  KeyRound,
  Loader2,
  Play,
  Search,
  Table2,
  TriangleAlert,
} from 'lucide-react'
import type { QueryResult, TableInfo } from '@vercio/shared'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { formatBytes } from '@/lib/format'
import { cn } from '@/lib/utils'

/** Services PostgreSQL de l'environnement : l'onglet n'apparaît que s'il y en a. */
export function useDatabaseServices(projectId: string, envId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['database', envId],
    queryFn: () => api.database.services(projectId, envId),
    enabled,
    staleTime: 60_000,
  })
}

const tableKey = (table: TableInfo) => `${table.schema}.${table.name}`

/**
 * Explorateur de base : tables et lignes en lecture, console SQL pour les administrateurs.
 * Tout passe par le conteneur de la base, avec ses propres identifiants : rien à ouvrir.
 */
export function DatabaseTab({
  projectId,
  envId,
  isAdmin,
}: {
  projectId: string
  envId: string
  isAdmin: boolean
}) {
  const services = useDatabaseServices(projectId, envId, true)
  const [service, setService] = useState('')
  const current = services.data?.find((item) => item.service === service) ?? services.data?.[0]
  const databases = useQuery({
    queryKey: ['database', envId, current?.service, 'databases'],
    queryFn: () => api.database.databases(projectId, envId, current!.service),
    enabled: Boolean(current?.running),
  })
  const [database, setDatabase] = useState('')
  // Par défaut : la première base d'application (pas la base d'administration « postgres »).
  const db =
    database ||
    databases.data?.find((item) => item.name !== 'postgres')?.name ||
    databases.data?.[0]?.name ||
    ''
  const tables = useQuery({
    queryKey: ['database', envId, current?.service, db, 'tables'],
    queryFn: () => api.database.tables(projectId, envId, current!.service, db),
    enabled: Boolean(current?.running && db),
  })
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const table = tables.data?.find((item) => tableKey(item) === selected) ?? tables.data?.[0] ?? null
  const shown = (tables.data ?? []).filter((item) =>
    tableKey(item).toLowerCase().includes(filter.toLowerCase()),
  )

  if (services.isPending) return <Skeleton className="h-96 w-full" />
  if (!current) {
    return (
      <p className="text-muted-foreground text-sm">
        Aucune base PostgreSQL dans cet environnement.
      </p>
    )
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <Card className="h-fit gap-3 py-4">
        <CardContent className="space-y-3 px-4">
          {services.data!.length > 1 && (
            <Select
              value={current.service}
              onValueChange={(value) => {
                setService(value)
                setDatabase('')
                setSelected(null)
              }}
            >
              <SelectTrigger className="w-full" aria-label="Service">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {services.data!.map((item) => (
                  <SelectItem key={item.service} value={item.service}>
                    {item.service}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {!current.running ? (
            <p className="text-warning text-sm">
              {current.service} est arrêté : démarrez-le pour explorer la base.
            </p>
          ) : (
            <>
              <Select
                value={db}
                onValueChange={(value) => {
                  setDatabase(value)
                  setSelected(null)
                }}
              >
                <SelectTrigger className="w-full" aria-label="Base">
                  <Database className="size-4" />
                  <SelectValue placeholder={databases.isPending ? 'Lecture…' : 'Base'} />
                </SelectTrigger>
                <SelectContent>
                  {databases.data?.map((item) => (
                    <SelectItem key={item.name} value={item.name}>
                      {item.name}
                      <span className="text-muted-foreground">
                        {' '}
                        · {formatBytes(item.sizeBytes)}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {databases.error && (
                <p className="text-destructive text-xs">{databases.error.message}</p>
              )}
              <div className="relative">
                <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
                <Input
                  className="h-9 pl-8"
                  placeholder="Filtrer les tables"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </div>
              {tables.isPending && <Skeleton className="h-40 w-full" />}
              {tables.error && <p className="text-destructive text-xs">{tables.error.message}</p>}
              {tables.data && !tables.data.length && (
                <p className="text-muted-foreground text-xs">Aucune table dans « {db} ».</p>
              )}
              <ul className="max-h-[60svh] space-y-0.5 overflow-y-auto">
                {shown.map((item) => (
                  <li key={tableKey(item)}>
                    <button
                      type="button"
                      onClick={() => setSelected(tableKey(item))}
                      className={cn(
                        'hover:bg-muted flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                        table && tableKey(table) === tableKey(item) && 'bg-muted font-medium',
                      )}
                    >
                      <Table2 className="text-muted-foreground size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        {item.schema !== 'public' && (
                          <span className="text-muted-foreground">{item.schema}.</span>
                        )}
                        {item.name}
                      </span>
                      <span className="text-muted-foreground text-xs tabular-nums">
                        ~{item.rows}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      {current.running && db && (
        <Tabs defaultValue="table" className="min-w-0">
          <TabsList>
            <TabsTrigger value="table">Contenu</TabsTrigger>
            {isAdmin && <TabsTrigger value="sql">Requête SQL</TabsTrigger>}
          </TabsList>
          <TabsContent value="table" className="pt-2">
            {table ? (
              <TableView
                key={`${db}/${tableKey(table)}`}
                projectId={projectId}
                envId={envId}
                service={current.service}
                database={db}
                table={table}
              />
            ) : (
              <p className="text-muted-foreground text-sm">Choisissez une table.</p>
            )}
          </TabsContent>
          {isAdmin && (
            <TabsContent value="sql" className="pt-2">
              <SqlConsole
                projectId={projectId}
                envId={envId}
                service={current.service}
                database={db}
                initial={
                  table
                    ? `SELECT * FROM ${table.schema === 'public' ? '' : `"${table.schema}".`}"${table.name}" LIMIT 100;`
                    : 'SELECT 1;'
                }
              />
            </TabsContent>
          )}
        </Tabs>
      )}
    </div>
  )
}

function TableView({
  projectId,
  envId,
  service,
  database,
  table,
}: {
  projectId: string
  envId: string
  service: string
  database: string
  table: TableInfo
}) {
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<string | undefined>()
  const [dir, setDir] = useState<'asc' | 'desc'>('asc')
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const size = 50
  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(search)
      setPage(1)
    }, 400)
    return () => clearTimeout(timer)
  }, [search])
  const rows = useQuery({
    queryKey: ['database', envId, service, database, table.schema, table.name, page, sort, dir, q],
    queryFn: () =>
      api.database.rows(projectId, envId, service, {
        database,
        schema: table.schema,
        table: table.name,
        page,
        size,
        sort,
        dir,
        q,
      }),
    placeholderData: keepPreviousData,
    meta: { keep: true },
  })
  const data = rows.data
  const pages = data ? Math.max(1, Math.ceil(data.total / size)) : 1
  const types = useMemo(
    () => new Map(data?.columnInfo.map((column) => [column.name, column]) ?? []),
    [data],
  )

  function toggleSort(column: string) {
    if (sort === column) setDir(dir === 'asc' ? 'desc' : 'asc')
    else {
      setSort(column)
      setDir('asc')
    }
    setPage(1)
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search className="text-muted-foreground absolute top-2.5 left-2.5 size-4" />
          <Input
            className="h-9 pl-8"
            placeholder={`Chercher dans ${table.name}`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <span className="text-muted-foreground text-sm">
          {data ? `${data.total.toLocaleString('fr-FR')} ligne${data.total > 1 ? 's' : ''}` : '…'}
          {rows.isFetching && <Loader2 className="ml-2 inline size-3.5 animate-spin" />}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="icon"
            variant="outline"
            className="size-8"
            aria-label="Page précédente"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft />
          </Button>
          <span className="text-muted-foreground px-1 text-xs tabular-nums">
            {page} / {pages}
          </span>
          <Button
            size="icon"
            variant="outline"
            className="size-8"
            aria-label="Page suivante"
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>
      {rows.error && (
        <Alert variant="destructive">
          <AlertDescription>{rows.error.message}</AlertDescription>
        </Alert>
      )}
      {!data && rows.isPending && <Skeleton className="h-80 w-full" />}
      {data && (
        <ResultTable
          result={data}
          header={(column) => {
            const info = types.get(column)
            return (
              <button
                type="button"
                className="flex items-center gap-1 text-left"
                onClick={() => toggleSort(column)}
              >
                {info?.primaryKey && <KeyRound className="text-brand size-3" />}
                <span>{column}</span>
                <span className="text-muted-foreground font-normal">{info?.type}</span>
                {sort === column &&
                  (dir === 'asc' ? (
                    <ArrowUp className="size-3" />
                  ) : (
                    <ArrowDown className="size-3" />
                  ))}
              </button>
            )
          }}
        />
      )}
    </div>
  )
}

function SqlConsole({
  projectId,
  envId,
  service,
  database,
  initial,
}: {
  projectId: string
  envId: string
  service: string
  database: string
  initial: string
}) {
  const [sql, setSql] = useState(initial)
  const [write, setWrite] = useState(false)
  const run = useMutation({
    mutationFn: () => api.database.query(projectId, envId, service, { database, sql, write }),
    meta: { keep: true },
  })
  return (
    <div className="space-y-3">
      <Textarea
        aria-label="Requête SQL"
        className="min-h-32 font-mono text-xs"
        spellCheck={false}
        value={sql}
        onChange={(event) => setSql(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault()
            run.mutate()
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" disabled={run.isPending || !sql.trim()} onClick={() => run.mutate()}>
          {run.isPending ? <Loader2 className="animate-spin" /> : <Play />}
          Exécuter
          <kbd className="text-primary-foreground/70 ml-1 text-[10px]">Ctrl ↵</kbd>
        </Button>
        <label className={cn('flex items-center gap-2 text-sm', write && 'text-warning')}>
          <Checkbox checked={write} onCheckedChange={(checked) => setWrite(checked === true)} />
          Autoriser les modifications
        </label>
        <span className="text-muted-foreground text-xs">
          {write
            ? 'Les modifications sont enregistrées dans la base.'
            : 'Lecture seule : toute modification est refusée.'}{' '}
          Chaque requête est inscrite au journal d’audit (Activité → Journal d’audit).
        </span>
      </div>
      {write && (
        <p className="text-warning flex items-center gap-1.5 text-xs">
          <TriangleAlert className="size-3.5" />
          Pas d’annulation possible : faites une sauvegarde avant une modification importante.
        </p>
      )}
      {run.error && (
        <Alert variant="destructive">
          <AlertDescription className="font-mono text-xs">{run.error.message}</AlertDescription>
        </Alert>
      )}
      {run.data && (
        <>
          <p className="text-muted-foreground text-xs">
            {run.data.columns.length
              ? `${run.data.rows.length} ligne${run.data.rows.length > 1 ? 's' : ''}${run.data.truncated ? ' (les 1 000 premières)' : ''}`
              : 'Exécutée.'}{' '}
            · {run.data.durationMs} ms
          </p>
          {run.data.columns.length > 0 && <ResultTable result={run.data} />}
        </>
      )}
    </div>
  )
}

function ResultTable({
  result,
  header,
}: {
  result: QueryResult
  header?: (column: string) => React.ReactNode
}) {
  if (!result.rows.length) {
    return (
      <p className="text-muted-foreground rounded-lg border p-6 text-center text-sm">
        Aucune ligne.
      </p>
    )
  }
  return (
    <div className="max-h-[65svh] overflow-auto rounded-lg border">
      <table className="w-full text-xs">
        <thead className="bg-muted/80 sticky top-0 backdrop-blur">
          <tr>
            {result.columns.map((column) => (
              <th key={column} className="px-3 py-2 text-left font-medium whitespace-nowrap">
                {header ? header(column) : column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {result.rows.map((row, index) => (
            <tr key={index} className="hover:bg-muted/40">
              {row.map((value, column) => (
                <td
                  key={column}
                  className="max-w-80 px-3 py-1.5 align-top font-mono"
                  title={value ?? 'NULL'}
                >
                  {value === null ? (
                    <span className="text-muted-foreground italic">NULL</span>
                  ) : (
                    <span className="line-clamp-2 break-all">{value}</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
