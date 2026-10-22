/** Port habituel des images courantes : `postgres` → 5432, `nginx` → 80… */
const DEFAULT_PORTS: [RegExp, number][] = [
  [/(^|\/)(postgres|postgis|timescaledb)/, 5432],
  [/(^|\/)(mysql|mariadb|percona)/, 3306],
  [/(^|\/)mongo/, 27017],
  [/(^|\/)(redis|valkey|keydb)/, 6379],
  [/(^|\/)rabbitmq/, 5672],
  [/(^|\/)(elasticsearch|opensearch)/, 9200],
  [/(^|\/)minio/, 9000],
  [/(^|\/)(nginx|httpd|caddy|traefik)/, 80],
]

export function defaultPort(image: string | null | undefined): number | null {
  if (!image) return null
  return DEFAULT_PORTS.find(([pattern]) => pattern.test(image))?.[1] ?? null
}
