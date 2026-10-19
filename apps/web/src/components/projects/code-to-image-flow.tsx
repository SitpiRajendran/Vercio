import { ArrowRight, Box, Container, GitBranch, Rocket } from 'lucide-react'
import { cn } from '@/lib/utils'

const STEPS = [
  {
    icon: GitBranch,
    title: 'Dépôt de code',
    text: 'GitLab ou GitHub : le code et le fichier Compose',
  },
  { icon: Box, title: 'CI', text: 'à chaque push, elle construit une image (une version)' },
  {
    icon: Container,
    title: 'Registry d’images',
    text: 'où la CI range les images : registry GitLab, GHCR…',
  },
  { icon: Rocket, title: 'Vercio', text: 'choisit la version, télécharge l’image et la déploie' },
]

/**
 * Le chemin d'une modification jusqu'au serveur : le dépôt sert à lire les versions et le
 * Compose, le registry à télécharger les images. Une connexion GitLab ou GitHub couvre les deux.
 */
export function CodeToImageFlow({ className }: { className?: string }) {
  return (
    <ol aria-label="Du code au déploiement" className={cn('grid gap-2 sm:grid-cols-4', className)}>
      {STEPS.map((step, index) => (
        <li key={step.title} className="relative flex gap-2 rounded-lg border p-2.5">
          <step.icon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium">{step.title}</p>
            <p className="text-muted-foreground text-xs">{step.text}</p>
          </div>
          {index < STEPS.length - 1 && (
            <ArrowRight
              aria-hidden
              className="text-muted-foreground bg-background absolute top-1/2 -right-3 z-10 hidden size-4 -translate-y-1/2 sm:block"
            />
          )}
        </li>
      ))}
    </ol>
  )
}
