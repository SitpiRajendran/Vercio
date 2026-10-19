import { ShieldAlert } from 'lucide-react'
import { hasRole } from '@vercio/shared'
import { PageHeader } from '@/components/layout/app-layout'
import { StickyTabsList } from '@/components/layout/sticky-tabs-list'
import { Tabs, TabsContent, TabsTrigger } from '@/components/ui/tabs'
import { useCurrentUser } from '@/lib/auth'
import { CodeToImageFlow } from '@/components/projects/code-to-image-flow'
import { BackupsSettingsTab } from './backups'
import { GitProvidersTab } from './git-providers'
import { NotificationsSettingsTab } from './notifications'
import { RegistriesTab } from './registries'
import { EmptyState } from './resource-list'
import { UsersTab } from './users'
import { WebhooksSettingsTab } from './webhooks'

const TABS = ['users', 'code', 'webhooks', 'notifications', 'sauvegardes'] as const
/** Anciens onglets, réunis dans « Code et images ». */
const LEGACY: Record<string, string> = { git: 'code', registries: 'code' }

/** Onglet ouvert d'office : `/parametres#registries`, par exemple depuis l'assistant de projet. */
function initialTab(): string {
  const hash = window.location.hash.slice(1)
  if (LEGACY[hash]) return LEGACY[hash]
  return (TABS as readonly string[]).includes(hash) ? hash : 'users'
}

export function SettingsPage() {
  const { data: user } = useCurrentUser()
  const isAdmin = user ? hasRole(user.roles, 'vercio-admin') : false

  return (
    <>
      <PageHeader
        title="Paramètres"
        description="Utilisateurs, code et images (GitLab, GitHub, registries), webhooks, notifications et sauvegardes"
      />
      <div className="p-4 md:p-6">
        {isAdmin ? (
          <Tabs defaultValue={initialTab()}>
            <StickyTabsList>
              <TabsTrigger value="users">Utilisateurs</TabsTrigger>
              <TabsTrigger value="code">Code et images</TabsTrigger>
              <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
              <TabsTrigger value="notifications">Notifications</TabsTrigger>
              <TabsTrigger value="sauvegardes">Sauvegardes</TabsTrigger>
            </StickyTabsList>
            <TabsContent value="users" className="pt-4">
              <UsersTab />
            </TabsContent>
            <TabsContent value="code" className="space-y-8 pt-4">
              <CodeToImageFlow />
              <section className="space-y-3">
                <h2 className="text-base font-semibold">GitLab et GitHub</h2>
                <GitProvidersTab />
              </section>
              <section className="space-y-3">
                <h2 className="text-base font-semibold">Registries d’images</h2>
                <RegistriesTab />
              </section>
            </TabsContent>
            <TabsContent value="webhooks" className="pt-4">
              <WebhooksSettingsTab />
            </TabsContent>
            <TabsContent value="notifications" className="pt-4">
              <NotificationsSettingsTab />
            </TabsContent>
            <TabsContent value="sauvegardes" className="pt-4">
              <BackupsSettingsTab />
            </TabsContent>
          </Tabs>
        ) : (
          <EmptyState icon={<ShieldAlert />} title="Accès réservé aux administrateurs">
            Les paramètres nécessitent le rôle vercio-admin.
          </EmptyState>
        )}
      </div>
    </>
  )
}
