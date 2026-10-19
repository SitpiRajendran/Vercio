import { useState } from 'react'
import { Link, useRouterState } from '@tanstack/react-router'
import {
  Boxes,
  ChevronsUpDown,
  History,
  KeyRound,
  LayoutGrid,
  LogOut,
  Moon,
  Network,
  Plus,
  Search,
  Server,
  Settings,
  Sun,
} from 'lucide-react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { hasRole, ROLE_LABELS, type SessionUser } from '@vercio/shared'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { ProjectAvatar } from '@/components/projects/project-avatar'
import { environmentStatus, TONE_DOT, useOverview, type Tone } from '@/lib/overview'
import { cn } from '@/lib/utils'
import { openCommandPalette } from './command-palette'
import { api } from '@/lib/api'
import { ChangePasswordDialog } from './change-password-dialog'
import { meQueryKey } from '@/lib/auth'
import { useTheme } from '@/lib/theme'

const NAVIGATION = [
  { to: '/', label: 'Projets', icon: LayoutGrid },
  { to: '/evenements', label: 'Activité', icon: History },
  { to: '/carte', label: 'Carte et ports', icon: Network },
  { to: '/conteneurs', label: 'Hôte', icon: Server },
] as const

const TONE_ORDER: Tone[] = ['error', 'busy', 'warning', 'ok', 'stopped']

export function AppSidebar({ user }: { user: SessionUser }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const overview = useOverview()
  const isAdmin = hasRole(user.roles, 'vercio-admin')
  const { isMobile, setOpenMobile } = useSidebar()
  const closeOnMobile = () => isMobile && setOpenMobile(false)

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/" onClick={closeOnMobile}>
                <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg">
                  <Boxes className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="font-semibold">Vercio</span>
                  <span className="text-muted-foreground truncate text-xs">Hôte local</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Rechercher (Ctrl K)"
              className="text-muted-foreground border"
              onClick={() => {
                closeOnMobile()
                openCommandPalette()
              }}
            >
              <Search />
              <span>Rechercher…</span>
              <kbd className="bg-muted ml-auto rounded px-1.5 font-mono text-[0.65rem]">Ctrl K</kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAVIGATION.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    asChild
                    tooltip={item.label}
                    isActive={item.to === '/' ? pathname === '/' : pathname.startsWith(item.to)}
                  >
                    <Link to={item.to} onClick={closeOnMobile}>
                      <item.icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Projets</SidebarGroupLabel>
          {isAdmin && (
            <SidebarGroupAction asChild title="Nouveau projet">
              <Link to="/projets/nouveau" onClick={closeOnMobile}>
                <Plus />
                <span className="sr-only">Nouveau projet</span>
              </Link>
            </SidebarGroupAction>
          )}
          <SidebarGroupContent>
            <SidebarMenu>
              {overview.data?.projects.map((project) => {
                const tones = project.environments.map((env) => environmentStatus(env).tone)
                const tone = TONE_ORDER.find((item) => tones.includes(item)) ?? 'stopped'
                const path = `/projets/${project.slug}`
                return (
                  <SidebarMenuItem key={project.id}>
                    <SidebarMenuButton
                      asChild
                      tooltip={project.name}
                      isActive={pathname === path || pathname.startsWith(`${path}/`)}
                    >
                      <Link
                        to="/projets/$slug"
                        params={{ slug: project.slug }}
                        onClick={closeOnMobile}
                      >
                        <ProjectAvatar project={project} size="sm" className="-ml-0.5" />
                        <span className="truncate">{project.name}</span>
                        <span
                          className={cn('ml-auto size-2 shrink-0 rounded-full', TONE_DOT[tone])}
                          aria-label={TONE_LABELS[tone]}
                        />
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
              {overview.data?.projects.length === 0 && (
                <p className="text-muted-foreground px-2 text-xs group-data-[collapsible=icon]:hidden">
                  Aucun projet.
                </p>
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              tooltip="Paramètres"
              isActive={pathname.startsWith('/parametres')}
            >
              <Link to="/parametres" onClick={closeOnMobile}>
                <Settings />
                <span>Paramètres</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <UserMenu user={user} />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}

const TONE_LABELS: Record<Tone, string> = {
  ok: 'Tout fonctionne',
  warning: 'À surveiller',
  error: 'En erreur',
  stopped: 'Arrêté',
  busy: 'Déploiement en cours',
}

function UserMenu({ user }: { user: SessionUser }) {
  const { theme, toggleTheme } = useTheme()
  const queryClient = useQueryClient()
  const [changingPassword, setChangingPassword] = useState(false)
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: ({ redirectTo }) => {
      // Session SSO : on ferme aussi la session Keycloak, qui renvoie ensuite vers /connexion.
      if (redirectTo) window.location.assign(redirectTo)
      else queryClient.setQueryData(meQueryKey, null)
    },
    onError: () => queryClient.setQueryData(meQueryKey, null),
  })
  const initials = user.displayName
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton size="lg">
            <Avatar className="size-8 rounded-lg">
              <AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{user.displayName}</span>
              <span className="text-muted-foreground truncate text-xs">
                {user.roles.map((role) => ROLE_LABELS[role].label).join(', ')}
              </span>
            </div>
            <ChevronsUpDown className="ml-auto size-4" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end" className="min-w-56">
          <DropdownMenuLabel className="font-normal">
            <div className="text-sm font-medium">{user.displayName}</div>
            <div className="text-muted-foreground text-xs">
              {user.email ?? user.username} · {user.provider === 'local' ? 'compte local' : 'SSO'}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={toggleTheme}>
            {theme === 'dark' ? <Sun /> : <Moon />}
            {theme === 'dark' ? 'Thème clair' : 'Thème sombre'}
          </DropdownMenuItem>
          {user.provider === 'local' && (
            <DropdownMenuItem onSelect={() => setChangingPassword(true)}>
              <KeyRound />
              Changer mon mot de passe
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => logout.mutate()}>
            <LogOut />
            Se déconnecter
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {changingPassword && <ChangePasswordDialog onClose={() => setChangingPassword(false)} />}
    </>
  )
}
