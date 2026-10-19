import { useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Pencil, PlugZap, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { ConnectionCheck } from '@vercio/shared'
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
import { ConnectionBadge, ConnectionResult } from './connection-result'

interface Resource {
  id: string
  name: string
  url: string
  lastCheck: ConnectionCheck | null
  usedBy: number
}

/** Carte d'une connexion enregistrée : état, test, modification, suppression. */
export function ResourceCard<T extends Resource>({
  item,
  queryKey,
  icon,
  meta,
  test,
  remove,
  onEdit,
}: {
  item: T
  queryKey: readonly string[]
  icon: ReactNode
  meta: ReactNode
  test: (id: string) => Promise<ConnectionCheck>
  remove: (id: string) => Promise<void>
  onEdit: () => void
}) {
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const testMutation = useMutation({
    mutationFn: () => test(item.id),
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })
  const removeMutation = useMutation({
    mutationFn: () => remove(item.id),
    onSuccess: async () => {
      setConfirming(false)
      toast.success(`« ${item.name} » supprimé`)
      await queryClient.invalidateQueries({ queryKey })
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <Card className="gap-4">
      <CardHeader>
        <CardTitle className="flex min-w-0 items-center gap-2">
          <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
          <span className="truncate">{item.name}</span>
        </CardTitle>
        <CardDescription className="truncate">{item.url}</CardDescription>
        <CardAction>
          <ConnectionBadge check={item.lastCheck} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">{meta}</div>
        {testMutation.data && <ConnectionResult check={testMutation.data} />}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => testMutation.mutate()}
            disabled={testMutation.isPending}
          >
            {testMutation.isPending ? <Loader2 className="animate-spin" /> : <PlugZap />}
            Tester
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit}>
            <Pencil />
            Modifier
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setConfirming(true)}
            disabled={item.usedBy > 0}
            title={item.usedBy > 0 ? 'Utilisé par des projets' : undefined}
          >
            <Trash2 />
            Supprimer
          </Button>
        </div>
      </CardContent>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer « {item.name} » ?</DialogTitle>
            <DialogDescription>
              Les identifiants enregistrés seront effacés. Cette action est définitive.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              Annuler
            </Button>
            <Button
              variant="destructive"
              onClick={() => removeMutation.mutate()}
              disabled={removeMutation.isPending}
            >
              {removeMutation.isPending && <Loader2 className="animate-spin" />}
              Supprimer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon: ReactNode
  title: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-12 text-center">
      <span className="text-muted-foreground [&_svg]:size-8">{icon}</span>
      <p className="font-medium">{title}</p>
      <p className="text-muted-foreground max-w-md text-sm">{children}</p>
    </div>
  )
}
