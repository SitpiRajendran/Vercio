import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck, Webhook } from 'lucide-react'
import { toast } from 'sonner'
import { IpAllowlistEditor } from '@/components/projects/ip-allowlist-editor'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

export function WebhooksSettingsTab() {
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: ['settings', 'webhooks'], queryFn: api.webhooks.settings })
  const save = useMutation({
    mutationFn: api.webhooks.saveSettings,
    onSuccess: (updated, input) => {
      queryClient.setQueryData(['settings', 'webhooks'], updated)
      void queryClient.invalidateQueries({ queryKey: ['webhooks'] })
      toast.success(
        input.enabled === undefined
          ? 'Liste d’IP enregistrée'
          : input.enabled
            ? 'Webhooks activés'
            : 'Webhooks désactivés',
      )
    },
    onError: (error) => toast.error(error.message),
  })

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              <Webhook className="size-4" />
              Webhooks entrants
            </CardTitle>
            <CardDescription>
              Mise à jour automatique quand la CI publie une image. Sans webhook, Vercio n’a pas
              besoin d’être joignable par GitLab ou GitHub : vous pouvez le garder derrière un VPN
              et mettre à jour à la main. Désactivés, toutes les URL de webhook répondent 404.
            </CardDescription>
          </div>
          {settings.data && (
            <Switch
              aria-label="Webhooks activés"
              checked={settings.data.enabled}
              disabled={save.isPending}
              onCheckedChange={(enabled) => save.mutate({ enabled })}
            />
          )}
        </CardHeader>
      </Card>
      <Card className={cn(settings.data && !settings.data.enabled && 'opacity-60')}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-4" />
            Adresses IP autorisées pour les webhooks
          </CardTitle>
          <CardDescription>
            S’applique à tous les environnements qui n’ont pas leur propre liste. Une adresse ou une
            plage CIDR par ligne (ex. les runners GitLab). Vide : toutes les adresses sont
            acceptées, seul le jeton de l’URL protège les webhooks.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {settings.isPending && <Skeleton className="h-24 w-full" />}
          {settings.error && <p className="text-destructive text-sm">{settings.error.message}</p>}
          {settings.data && (
            <IpAllowlistEditor
              key={settings.dataUpdatedAt}
              id="global-allowlist"
              initial={settings.data.ipAllowlist}
              canEdit
              saving={save.isPending}
              onSave={(rules) => save.mutate({ ipAllowlist: rules })}
            />
          )}
          <p className="text-muted-foreground text-xs">
            L’adresse vérifiée est celle transmise par le reverse proxy amont (X-Forwarded-For). Si
            plusieurs proxys se suivent devant Vercio, ajustez la variable TRUST_PROXY.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
