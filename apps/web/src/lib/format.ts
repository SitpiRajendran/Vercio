const units = ['o', 'Ko', 'Mo', 'Go', 'To']

export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ${units[unit]}`
}

const relative = new Intl.RelativeTimeFormat('fr-FR', { numeric: 'auto' })
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400],
  ['month', 30 * 86_400],
  ['week', 7 * 86_400],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]

/** « il y a 3 heures », « hier »… */
export function formatRelative(date: string | Date, now = Date.now()): string {
  const seconds = Math.round((new Date(date).getTime() - now) / 1000)
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit)
  }
  return 'à l’instant'
}

export function formatDateTime(date: string | Date): string {
  return new Date(date).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })
}
