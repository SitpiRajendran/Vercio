import { useLayoutEffect, useRef, type ComponentProps } from 'react'
import { TabsList } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'

/** Hauteur de la barre d'onglets collée : les menus collants en dessous s'y calent. */
const HEIGHT_VAR = '--sticky-tabs-height'

/**
 * Onglets d'une page (sous-menu), toujours visibles en haut de la zone qui défile. À placer
 * dans le conteneur `p-4 md:p-6` de la page : la barre s'étend sur toute sa largeur.
 */
export function StickyTabsList({ className, ...props }: ComponentProps<typeof TabsList>) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const root = document.documentElement
    const update = () => root.style.setProperty(HEIGHT_VAR, `${element.offsetHeight}px`)
    update()
    // Les onglets passent sur deux lignes sur téléphone : hauteur suivie.
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => {
      observer.disconnect()
      root.style.removeProperty(HEIGHT_VAR)
    }
  }, [])
  return (
    <div
      ref={ref}
      className="bg-background sticky top-0 z-20 -mx-4 border-b px-4 py-2 md:-mx-6 md:px-6"
    >
      <TabsList
        className={cn(
          'flex-wrap justify-start group-data-[orientation=horizontal]/tabs:h-auto',
          className,
        )}
        {...props}
      />
    </div>
  )
}
