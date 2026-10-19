/**
 * Cause lisible d'un échec de `docker compose` : Docker ne renvoie qu'un code 1, le motif est
 * dans les dernières lignes de sa sortie.
 */
export type ComposeFailure =
  | { kind: 'port_allocated'; port: string; address: string }
  | { kind: 'port_in_use'; port: string }
  | { kind: 'unhealthy'; container: string }
  | { kind: 'exited'; container: string; code: string }
  | { kind: 'exec_format' }
  | { kind: 'daemon'; message: string }

export function composeFailure(lines: string[]): ComposeFailure | null {
  const text = lines.join('\n')
  let match = /Bind for ([^\s]*):(\d+) failed: port is already allocated/.exec(text)
  if (match) return { kind: 'port_allocated', address: match[1]!, port: match[2]! }
  match = /listen tcp[46]? [^\s]*?:(\d+): bind: address already in use/.exec(text)
  if (match) return { kind: 'port_in_use', port: match[1]! }
  if (/exec format error/.test(text)) return { kind: 'exec_format' }
  match = /container ([\w.-]+) is unhealthy/.exec(text)
  if (match) return { kind: 'unhealthy', container: match[1]! }
  match = /container ([\w.-]+) exited \((\d+)\)/.exec(text)
  if (match) return { kind: 'exited', container: match[1]!, code: match[2]! }
  const daemon = [...lines].reverse().find((line) => /^Error response from daemon: /.test(line))
  if (daemon)
    return { kind: 'daemon', message: daemon.replace(/^Error response from daemon: /, '') }
  return null
}

/** Message affiché dans le résumé du déploiement et les notifications. */
export function describeComposeFailure(failure: ComposeFailure, occupant?: string | null): string {
  switch (failure.kind) {
    case 'port_allocated':
      return `le port ${failure.port} de l’hôte est déjà pris ${
        occupant ? `par le conteneur « ${occupant} »` : 'par un autre conteneur'
      } : arrêtez-le ou changez le port publié dans le fichier Compose`
    case 'port_in_use':
      return `le port ${failure.port} de l’hôte est déjà utilisé par un programme hors Docker : libérez-le ou changez le port publié dans le fichier Compose`
    case 'unhealthy':
      return `le conteneur ${failure.container} n’est pas devenu healthy à temps (voir ses logs)`
    case 'exited':
      return `le conteneur ${failure.container} s’est arrêté au démarrage (code ${failure.code}, voir ses logs)`
    case 'exec_format':
      return 'une image n’est pas construite pour l’architecture de cet hôte (exec format error) : publiez-la aussi pour cette plateforme'
    case 'daemon':
      return failure.message.length > 300 ? `${failure.message.slice(0, 299)}…` : failure.message
  }
}
