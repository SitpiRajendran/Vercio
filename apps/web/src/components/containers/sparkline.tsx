import { useId, useState } from 'react'

const WIDTH = 160
const HEIGHT = 36
const PAD = 2

/**
 * Courbe d'une mesure dans le temps, avec valeur et heure au survol.
 * Une seule série : la couleur ne porte pas d'identité, le titre de la colonne la nomme.
 */
export function Sparkline({
  values,
  times,
  max,
  format,
  label,
}: {
  values: (number | null)[]
  times: string[]
  /** Haut de l'échelle ; par défaut la plus grande valeur. */
  max?: number
  format: (value: number) => string
  label: string
}) {
  const gradient = useId()
  const [hover, setHover] = useState<number | null>(null)
  const points = values.flatMap((value, index) => (value === null ? [] : [{ value, index }]))
  if (points.length < 2) {
    return (
      <div className="text-muted-foreground flex h-9 items-center text-xs" style={{ width: WIDTH }}>
        Mesure en cours…
      </div>
    )
  }
  const top = Math.max(max ?? 0, ...points.map((point) => point.value), 1e-9)
  const step = (WIDTH - PAD * 2) / Math.max(1, values.length - 1)
  const x = (index: number) => PAD + index * step
  const y = (value: number) => HEIGHT - PAD - (value / top) * (HEIGHT - PAD * 2)
  const line = points.map((point) => `${x(point.index)},${y(point.value)}`).join(' ')
  const area = `${x(points[0]!.index)},${HEIGHT - PAD} ${line} ${x(points.at(-1)!.index)},${HEIGHT - PAD}`
  const hovered = hover === null ? null : (points.find((point) => point.index === hover) ?? null)

  return (
    <div className="relative" style={{ width: WIDTH }}>
      <svg
        width={WIDTH}
        height={HEIGHT}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`${label} : ${format(points.at(-1)!.value)}`}
        className="text-chart block overflow-visible"
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          const index = Math.round((event.clientX - box.left - PAD) / step)
          setHover(Math.min(values.length - 1, Math.max(0, index)))
        }}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="currentColor" stopOpacity="0.25" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line
          x1={PAD}
          x2={WIDTH - PAD}
          y1={HEIGHT - PAD}
          y2={HEIGHT - PAD}
          className="stroke-border"
          strokeWidth={1}
        />
        <polygon points={area} fill={`url(#${gradient})`} />
        <polyline
          points={line}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {hovered && (
          <>
            <line
              x1={x(hovered.index)}
              x2={x(hovered.index)}
              y1={PAD}
              y2={HEIGHT - PAD}
              className="stroke-muted-foreground"
              strokeWidth={1}
              strokeDasharray="2 2"
            />
            <circle
              cx={x(hovered.index)}
              cy={y(hovered.value)}
              r={4}
              fill="currentColor"
              className="stroke-card"
              strokeWidth={2}
            />
          </>
        )}
      </svg>
      {hovered && (
        <div className="bg-popover text-popover-foreground pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 rounded-md border px-2 py-1 text-xs whitespace-nowrap shadow-sm">
          <span className="font-medium tabular-nums">{format(hovered.value)}</span>
          <span className="text-muted-foreground">
            {' · '}
            {new Date(times[hovered.index]!).toLocaleTimeString('fr-FR')}
          </span>
        </div>
      )}
    </div>
  )
}
