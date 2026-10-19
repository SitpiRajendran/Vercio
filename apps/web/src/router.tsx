import type { QueryClient } from '@tanstack/react-query'
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Navigate,
  Outlet,
  redirect,
} from '@tanstack/react-router'
import { Loader2 } from 'lucide-react'
import { AppLayout } from '@/components/layout/app-layout'
import { useCurrentUser } from '@/lib/auth'
import { ContainersPage } from '@/pages/containers'
import { HomePage } from '@/pages/home'
import { MapPage } from '@/pages/map'
import { EventsPage } from '@/pages/events'
import { LoginPage } from '@/pages/login'
import { DeploymentPage } from '@/pages/projects/deployment'
import { ProjectDetailPage } from '@/pages/projects/detail'
import { NewProjectPage } from '@/pages/projects/new'
import { SettingsPage } from '@/pages/settings'

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
})

export const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/connexion',
  validateSearch: (search: Record<string, unknown>): { erreur?: string } =>
    typeof search.erreur === 'string' ? { erreur: search.erreur } : {},
  component: LoginPage,
})

/** Toutes les pages de l'application exigent une session. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'app',
  component: AuthenticatedLayout,
})

function AuthenticatedLayout() {
  const { data: user, isPending } = useCurrentUser()
  if (isPending) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Loader2 className="text-muted-foreground size-6 animate-spin" />
      </div>
    )
  }
  if (!user) return <Navigate to="/connexion" />
  return (
    <AppLayout user={user}>
      <Outlet />
    </AppLayout>
  )
}

const routeTree = rootRoute.addChildren([
  loginRoute,
  appRoute.addChildren([
    createRoute({ getParentRoute: () => appRoute, path: '/', component: HomePage }),
    createRoute({
      getParentRoute: () => appRoute,
      path: '/projets',
      beforeLoad: () => {
        throw redirect({ to: '/' })
      },
    }),
    createRoute({
      getParentRoute: () => appRoute,
      path: '/projets/nouveau',
      component: NewProjectPage,
    }),
    createRoute({
      getParentRoute: () => appRoute,
      path: '/projets/$slug',
      // Liens des notifications : `?onglet=conteneurs&env=production`.
      validateSearch: (search: Record<string, unknown>): { onglet?: string; env?: string } => ({
        ...(typeof search.onglet === 'string' ? { onglet: search.onglet } : {}),
        ...(typeof search.env === 'string' ? { env: search.env } : {}),
      }),
      component: ProjectDetailPage,
    }),
    createRoute({
      getParentRoute: () => appRoute,
      path: '/projets/$slug/deploiements/$deploymentId',
      component: DeploymentPage,
    }),
    createRoute({ getParentRoute: () => appRoute, path: '/carte', component: MapPage }),
    createRoute({
      getParentRoute: () => appRoute,
      path: '/reseaux',
      beforeLoad: () => {
        throw redirect({ to: '/carte' })
      },
    }),
    createRoute({ getParentRoute: () => appRoute, path: '/conteneurs', component: ContainersPage }),
    createRoute({ getParentRoute: () => appRoute, path: '/evenements', component: EventsPage }),
    createRoute({ getParentRoute: () => appRoute, path: '/parametres', component: SettingsPage }),
  ]),
  createRoute({
    getParentRoute: () => rootRoute,
    path: '*',
    beforeLoad: () => {
      throw redirect({ to: '/' })
    },
  }),
])

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({ routeTree, context: { queryClient }, defaultPreload: 'intent' })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}
