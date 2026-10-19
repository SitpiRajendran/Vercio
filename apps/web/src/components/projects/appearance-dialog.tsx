import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ImagePlus, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  PROJECT_COLORS,
  PROJECT_ICONS,
  type ProjectAppearance,
  type ProjectColor,
  type ProjectIcon,
} from '@vercio/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { COLORS, ICONS, ProjectAvatar } from './project-avatar'

/** Côté de l'image enregistrée : nette sur écran haute densité, quelques Ko. */
const LOGO_SIZE = 128

/** Image recadrée au carré, réduite et réencodée (WebP, sinon PNG) dans le navigateur. */
async function resizeImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const side = Math.min(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = LOGO_SIZE
  canvas.height = LOGO_SIZE
  canvas
    .getContext('2d')!
    .drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      LOGO_SIZE,
      LOGO_SIZE,
    )
  bitmap.close()
  const webp = canvas.toDataURL('image/webp', 0.9)
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png')
}

/** Icône et couleur, ou image : ce qui distingue le projet dans les listes. */
export function AppearanceDialog({
  project,
  onClose,
}: {
  project: ProjectAppearance & { id: string; name: string; slug: string }
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [icon, setIcon] = useState<ProjectIcon | null>(project.icon)
  const [color, setColor] = useState<ProjectColor | null>(project.color)
  const [logo, setLogo] = useState<string | null>(project.logo)
  const [url, setUrl] = useState(project.url ?? '')
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () =>
      api.projects.appearance(project.id, { icon, color, logo, url: url.trim() || null }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['projects', project.slug], updated)
      void queryClient.invalidateQueries({ queryKey: ['overview'] })
      toast.success('Apparence enregistrée')
      onClose()
    },
    onError: (failure) => setError(failure.message),
  })

  const preview = { name: project.name, slug: project.slug, icon, color, logo }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Apparence et adresse de « {project.name} »</DialogTitle>
          <DialogDescription>
            Une icône sur une couleur, ou une image (le logo du site) ; et l’adresse du site, pour
            l’ouvrir d’un clic.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <ProjectAvatar project={preview} size="lg" />
            <div className="flex flex-wrap gap-2">
              <input
                ref={input}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/svg+xml"
                className="hidden"
                onChange={async (event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (!file) return
                  try {
                    setLogo(await resizeImage(file))
                    setError(null)
                  } catch {
                    setError('Image illisible : choisissez un fichier PNG, JPEG, WebP ou SVG.')
                  }
                }}
              />
              <Button variant="outline" size="sm" onClick={() => input.current?.click()}>
                <ImagePlus />
                {logo ? 'Changer l’image' : 'Choisir une image'}
              </Button>
              {logo && (
                <Button variant="ghost" size="sm" onClick={() => setLogo(null)}>
                  <Trash2 />
                  Retirer l’image
                </Button>
              )}
            </div>
          </div>

          <div className={cn('space-y-4', logo && 'pointer-events-none opacity-50')}>
            <div className="space-y-2">
              <Label>Icône</Label>
              <div role="radiogroup" aria-label="Icône" className="grid grid-cols-10 gap-1.5">
                {PROJECT_ICONS.map((name) => {
                  const Icon = ICONS[name].icon
                  return (
                    <button
                      key={name}
                      type="button"
                      role="radio"
                      aria-checked={icon === name}
                      aria-label={ICONS[name].label}
                      title={ICONS[name].label}
                      onClick={() => setIcon(icon === name ? null : name)}
                      className={cn(
                        'hover:bg-accent flex aspect-square items-center justify-center rounded-md border',
                        icon === name && 'border-primary ring-primary ring-1',
                      )}
                    >
                      <Icon className="size-4" />
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="space-y-2">
              <Label>Couleur</Label>
              <div role="radiogroup" aria-label="Couleur" className="flex flex-wrap gap-2">
                {PROJECT_COLORS.map((name) => (
                  <button
                    key={name}
                    type="button"
                    role="radio"
                    aria-checked={color === name}
                    aria-label={COLORS[name].label}
                    title={COLORS[name].label}
                    onClick={() => setColor(name)}
                    className={cn(
                      'size-7 rounded-full ring-offset-2 ring-offset-background',
                      COLORS[name].swatch,
                      color === name && 'ring-foreground ring-2',
                    )}
                  />
                ))}
              </div>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-url">Adresse du site (facultatif)</Label>
            <Input
              id="project-url"
              type="url"
              placeholder="https://www.exemple.fr"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              Affichée en bouton « Ouvrir le site » sur l’accueil et la page du projet.
            </p>
          </div>
          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending && <Loader2 className="animate-spin" />}
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
