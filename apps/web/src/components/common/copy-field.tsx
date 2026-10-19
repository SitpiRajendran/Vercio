import { useState } from 'react'
import { Check, Copy, Eye, EyeOff } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export async function copyText(value: string, label = 'Copié') {
  try {
    await navigator.clipboard.writeText(value)
    toast.success(label)
  } catch {
    toast.error('Copie impossible : sélectionnez le texte manuellement')
  }
}

/** Champ en lecture seule avec bouton de copie ; `secret` masque la valeur jusqu'au clic. */
export function CopyField({
  id,
  value,
  secret = false,
  className,
}: {
  id?: string
  value: string
  secret?: boolean
  className?: string
}) {
  const [visible, setVisible] = useState(!secret)
  const [copied, setCopied] = useState(false)
  return (
    <div className={cn('flex gap-1.5', className)}>
      <Input
        id={id}
        readOnly
        value={visible ? value : '•'.repeat(24)}
        className="font-mono text-xs"
        onFocus={(event) => visible && event.currentTarget.select()}
      />
      {secret && (
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={visible ? 'Masquer' : 'Afficher'}
          onClick={() => setVisible(!visible)}
        >
          {visible ? <EyeOff /> : <Eye />}
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label="Copier"
        onClick={async () => {
          await copyText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  )
}

/** Bloc de code avec bouton de copie. */
export function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="relative">
      <pre
        aria-label={label}
        className="overflow-x-auto rounded-lg border bg-zinc-950 p-3 pr-12 font-mono text-xs leading-relaxed text-zinc-200"
      >
        {code}
      </pre>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Copier le code"
        className="absolute top-1.5 right-1.5 text-zinc-400 hover:text-zinc-100"
        onClick={() => copyText(code)}
      >
        <Copy />
      </Button>
    </div>
  )
}
