import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { ipRuleSchema } from '@vercio/shared'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'

/** Une adresse IP ou une plage CIDR par ligne ; `#` pour un commentaire. */
export function parseRules(text: string): { rules: string[]; invalid: string[] } {
  const items = text
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean)
  return {
    rules: items,
    invalid: items.filter((item) => !ipRuleSchema.safeParse(item).success),
  }
}

export function IpAllowlistEditor({
  id,
  initial,
  canEdit,
  saving,
  onSave,
  placeholder,
}: {
  id: string
  initial: string[]
  canEdit: boolean
  saving: boolean
  onSave: (rules: string[]) => void
  placeholder?: string
}) {
  const [text, setText] = useState(initial.join('\n'))
  const { rules, invalid } = parseRules(text)
  const changed = rules.join('\n') !== initial.join('\n')
  return (
    <div className="space-y-2">
      <Textarea
        id={id}
        rows={4}
        spellCheck={false}
        className="font-mono text-xs"
        placeholder={placeholder ?? '10.0.0.0/8\n192.0.2.15'}
        value={text}
        disabled={!canEdit}
        onChange={(event) => setText(event.target.value)}
      />
      {invalid.length > 0 && (
        <p className="text-destructive text-xs">Adresse ou plage invalide : {invalid.join(', ')}</p>
      )}
      {canEdit && (
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={!changed || invalid.length > 0 || saving}
            onClick={() => onSave(rules)}
          >
            {saving && <Loader2 className="animate-spin" />}
            Enregistrer la liste
          </Button>
        </div>
      )}
    </div>
  )
}
