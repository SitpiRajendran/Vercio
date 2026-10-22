import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ThemeProvider } from '@/lib/theme'
import { createAppRouter } from '@/router'
import './index.css'

/**
 * Données à garder telles quelles : secret TOTP en cours d'ajout (il changerait pendant qu'on
 * le scanne) et catalogues GitLab / GitHub (coûteux, sans rapport avec les actions de Vercio).
 */
const keepAsIs = (query: { queryKey: readonly unknown[]; meta?: Record<string, unknown> }) =>
  query.meta?.keep === true || query.queryKey[0] === 'catalog'

const queryClient: QueryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: (query) => !keepAsIs(query) } },
  // Après toute action réussie, les données affichées sont relues : la page entière reste à
  // jour, pas seulement le composant qui a agi.
  mutationCache: new MutationCache({
    onSuccess: () => queryClient.invalidateQueries({ predicate: (query) => !keepAsIs(query) }),
  }),
})
const router = createAppRouter(queryClient)

const root = document.getElementById('root')
if (!root) throw new Error('#root introuvable')

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <RouterProvider router={router} />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
)
