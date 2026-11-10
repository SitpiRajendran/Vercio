import { useState } from 'react'
import { Check, Copy, Download } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

/** Texte des codes, tel qu'il est copié ou téléchargé. */
function codesText(codes: string[], username?: string): string {
  return [
    `Codes de secours Vercio${username ? ` (${username})` : ''} — ${window.location.host}`,
    `Créés le ${new Date().toLocaleString('fr-FR')}. Chaque code ne sert qu’une fois.`,
    '',
    ...codes,
    '',
  ].join('\n')
}

/**
 * Codes de secours affichés une seule fois : grille lisible, copie et téléchargement. Rien
 * n'est gardé en clair côté serveur, ils ne pourront plus être réaffichés.
 */
export function RecoveryCodesList({ codes, username }: { codes: string[]; username?: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(codesText(codes, username))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Copie impossible : sélectionnez les codes à la main')
    }
  }

  function download() {
    const blob = new Blob([codesText(codes, username)], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `vercio-codes-de-secours${username ? `-${username}` : ''}.txt`
    link.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-3">
      <ol className="bg-muted grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-lg p-4 font-mono text-sm select-all">
        {codes.map((code) => (
          <li key={code} className="text-center tracking-wide">
            {code}
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        <Button type="button" variant="outline" className="flex-1" onClick={() => void copy()}>
          {copied ? <Check /> : <Copy />}
          {copied ? 'Copiés' : 'Copier'}
        </Button>
        <Button type="button" variant="outline" className="flex-1" onClick={download}>
          <Download />
          Télécharger
        </Button>
      </div>
    </div>
  )
}
