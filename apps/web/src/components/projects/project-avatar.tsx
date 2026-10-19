import {
  BookOpen,
  Bot,
  Box,
  ChartColumn,
  Cloud,
  Code,
  Database,
  Gamepad2,
  Globe,
  Image,
  Layers,
  Mail,
  MessageSquare,
  Music,
  Newspaper,
  Server,
  Shield,
  ShoppingCart,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import type { ProjectAppearance, ProjectColor, ProjectIcon } from '@vercio/shared'
import { cn } from '@/lib/utils'

export const ICONS: Record<ProjectIcon, { icon: LucideIcon; label: string }> = {
  globe: { icon: Globe, label: 'Site web' },
  server: { icon: Server, label: 'Serveur' },
  database: { icon: Database, label: 'Base de données' },
  'shopping-cart': { icon: ShoppingCart, label: 'Boutique' },
  newspaper: { icon: Newspaper, label: 'Blog, média' },
  'message-square': { icon: MessageSquare, label: 'Messagerie' },
  mail: { icon: Mail, label: 'E-mail' },
  chart: { icon: ChartColumn, label: 'Statistiques' },
  shield: { icon: Shield, label: 'Sécurité' },
  cloud: { icon: Cloud, label: 'Cloud' },
  code: { icon: Code, label: 'API' },
  box: { icon: Box, label: 'Service' },
  layers: { icon: Layers, label: 'Application' },
  gamepad: { icon: Gamepad2, label: 'Jeu' },
  music: { icon: Music, label: 'Musique' },
  image: { icon: Image, label: 'Images' },
  book: { icon: BookOpen, label: 'Documentation' },
  users: { icon: Users, label: 'Communauté' },
  wallet: { icon: Wallet, label: 'Finances' },
  bot: { icon: Bot, label: 'Robot' },
}

/** Classes complètes (Tailwind ne génère que les noms écrits en entier). */
export const COLORS: Record<ProjectColor, { tile: string; swatch: string; label: string }> = {
  slate: {
    tile: 'bg-slate-500/15 text-slate-700 dark:text-slate-300',
    swatch: 'bg-slate-500',
    label: 'Ardoise',
  },
  red: {
    tile: 'bg-red-500/15 text-red-700 dark:text-red-300',
    swatch: 'bg-red-500',
    label: 'Rouge',
  },
  orange: {
    tile: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
    swatch: 'bg-orange-500',
    label: 'Orange',
  },
  amber: {
    tile: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
    swatch: 'bg-amber-500',
    label: 'Ambre',
  },
  green: {
    tile: 'bg-green-500/15 text-green-700 dark:text-green-300',
    swatch: 'bg-green-500',
    label: 'Vert',
  },
  teal: {
    tile: 'bg-teal-500/15 text-teal-700 dark:text-teal-300',
    swatch: 'bg-teal-500',
    label: 'Turquoise',
  },
  sky: {
    tile: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
    swatch: 'bg-sky-500',
    label: 'Ciel',
  },
  blue: {
    tile: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
    swatch: 'bg-blue-500',
    label: 'Bleu',
  },
  violet: {
    tile: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
    swatch: 'bg-violet-500',
    label: 'Violet',
  },
  pink: {
    tile: 'bg-pink-500/15 text-pink-700 dark:text-pink-300',
    swatch: 'bg-pink-500',
    label: 'Rose',
  },
}

const SIZES = {
  sm: 'size-5 rounded-md [&_svg]:size-3',
  md: 'size-8 rounded-lg [&_svg]:size-4',
  lg: 'size-11 rounded-xl [&_svg]:size-5',
}

/** Couleur par défaut, stable pour un même projet. */
function defaultColor(seed: string): ProjectColor {
  const keys = Object.keys(COLORS) as ProjectColor[]
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return keys[hash % keys.length]!
}

/** Image du projet, sinon son icône sur sa couleur, sinon son initiale. */
export function ProjectAvatar({
  project,
  size = 'md',
  className,
}: {
  project: Pick<ProjectAppearance, 'icon' | 'color' | 'logo'> & {
    name: string
    slug: string
    type?: 'compose' | 'single'
  }
  size?: keyof typeof SIZES
  className?: string
}) {
  const color = COLORS[project.color ?? defaultColor(project.slug)]
  if (project.logo) {
    return (
      <img
        src={project.logo}
        alt=""
        className={cn('shrink-0 object-cover', SIZES[size], className)}
      />
    )
  }
  const Icon = project.icon ? ICONS[project.icon].icon : null
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center font-semibold',
        SIZES[size],
        size === 'sm' ? 'text-[0.65rem]' : size === 'lg' ? 'text-base' : 'text-sm',
        color.tile,
        className,
      )}
    >
      {Icon ? <Icon /> : project.name.charAt(0).toUpperCase()}
    </span>
  )
}
