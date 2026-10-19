import type { ReactNode } from 'react'
import type { SessionUser } from '@vercio/shared'
import { Separator } from '@/components/ui/separator'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { WorkbenchProvider } from '@/components/workbench/workbench'
import { AppSidebar } from './app-sidebar'
import { CommandPalette } from './command-palette'

export function AppLayout({ user, children }: { user: SessionUser; children: ReactNode }) {
  return (
    <SidebarProvider>
      <AppSidebar user={user} />
      {/* min-w-0 : un texte tronqué (image, URL) ne doit jamais élargir la page. */}
      <SidebarInset className="h-svh min-h-0 min-w-0 overflow-hidden">
        <WorkbenchProvider>
          {children}
          <CommandPalette />
        </WorkbenchProvider>
      </SidebarInset>
    </SidebarProvider>
  )
}

export function PageHeader({
  title,
  description,
  actions,
  leading,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  /** Avant le titre : avatar du projet… */
  leading?: ReactNode
}) {
  return (
    <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3 md:px-6">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-5" />
      {leading}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-lg font-semibold">{title}</h1>
        {description && <div className="text-muted-foreground text-sm">{description}</div>}
      </div>
      {actions}
    </header>
  )
}
