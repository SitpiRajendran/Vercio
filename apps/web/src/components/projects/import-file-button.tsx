import { useRef } from 'react'
import { Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

const MAX_SIZE = 200_000

/** Bouton « Importer un fichier » : lit un fichier YAML de l'ordinateur et renvoie son contenu. */
export function ImportFileButton({
  onImport,
  disabled,
}: {
  onImport: (content: string, name: string) => void
  disabled?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".yml,.yaml,application/yaml,text/yaml"
        className="hidden"
        aria-label="Fichier Compose à importer"
        onChange={async (event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          if (file.size > MAX_SIZE) {
            toast.error('Fichier trop volumineux (200 Ko maximum)')
            return
          }
          onImport(await file.text(), file.name)
          toast.success(`« ${file.name} » importé`)
        }}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <Upload />
        Importer un fichier
      </Button>
    </>
  )
}
