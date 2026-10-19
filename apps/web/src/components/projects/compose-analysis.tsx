import { AlertTriangle, Box, XCircle } from 'lucide-react'
import type { ComposeAnalysis } from '@vercio/shared'
import { Badge } from '@/components/ui/badge'

/** Résumé d'un fichier Compose : services détectés, erreurs et points d'attention. */
export function ComposeAnalysisView({ analysis }: { analysis: ComposeAnalysis }) {
  if (analysis.error) {
    return (
      <p
        role="alert"
        className="border-destructive/40 bg-destructive/5 flex items-start gap-2 rounded-lg border p-3 text-sm"
      >
        <XCircle className="text-destructive mt-0.5 size-4 shrink-0" />
        {analysis.error}
      </p>
    )
  }
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-sm">
        {analysis.services.length} service(s) détecté(s) :
      </p>
      <div className="flex flex-wrap gap-2">
        {analysis.services.map((service) => (
          <Badge key={service.name} variant="secondary" className="gap-1.5">
            <Box className="size-3" />
            {service.name}
            {service.ports.length > 0 && (
              <span className="text-muted-foreground">{service.ports.join(', ')}</span>
            )}
          </Badge>
        ))}
      </div>
      {analysis.warnings.map((warning) => (
        <p key={warning} className="text-warning flex items-start gap-2 text-xs">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {warning}
        </p>
      ))}
    </div>
  )
}
