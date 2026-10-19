import { readFile, stat } from 'node:fs/promises'
import { eq } from 'drizzle-orm'
import { isAbsolute, join, relative } from 'node:path'
import { composeProjectName, type ExternalComposeProject } from '@vercio/shared'
import type { Database } from '../db/client.js'
import { environments, projects } from '../db/schema.js'
import type { ComposeContainer, HostDriver } from '../docker/host-driver.js'
import { analyzeCompose } from './analyze.js'
import { parseDotenv } from './dotenv.js'

const MAX_FILE_BYTES = 1024 * 1024
const LABEL = {
  project: 'com.docker.compose.project',
  workingDir: 'com.docker.compose.project.working_dir',
  configFiles: 'com.docker.compose.project.config_files',
  envFile: 'com.docker.compose.project.environment_file',
  oneoff: 'com.docker.compose.oneoff',
}

/** Docker Desktop préfixe les chemins de l'hôte par /host_mnt dans les montages. */
function hostPath(path: string): string {
  return path.replace(/^\/host_mnt(?=\/)/, '')
}

async function readSmallFile(path: string): Promise<string> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error('ce n’est pas un fichier')
  if (info.size > MAX_FILE_BYTES) throw new Error('fichier trop volumineux (1 Mo au plus)')
  return readFile(path, 'utf8')
}

function unreadable(error: unknown): string {
  const code = (error as { code?: string }).code
  const reason =
    code === 'ENOENT'
      ? 'introuvable depuis Vercio'
      : code === 'EACCES' || code === 'EPERM'
        ? 'lecture refusée'
        : error instanceof Error
          ? error.message
          : String(error)
  return `Fichier ${reason}. Si Vercio tourne dans un conteneur, il ne voit pas ce dossier : importez le fichier depuis votre ordinateur.`
}

/**
 * Projets Compose lancés hors de Vercio : conteneurs Compose dont le projet ne correspond à aucun
 * environnement Vercio. Le fichier Compose et le `.env` sont lus sur le disque si possible.
 */
export async function externalComposeProjects(
  db: Database,
  host: HostDriver,
): Promise<ExternalComposeProject[]> {
  const rows = await db
    .select({ project: projects.slug, environment: environments.slug })
    .from(environments)
    .innerJoin(projects, eq(projects.id, environments.projectId))
  const managed = new Set(rows.map((row) => composeProjectName(row.project, row.environment)))
  const groups = new Map<string, ComposeContainer[]>()
  for (const container of await host.composeInventory()) {
    if (managed.has(container.project) || container.labels['vercio.managed'] === 'true') continue
    if (container.labels[LABEL.oneoff] === 'True') continue
    groups.set(container.project, [...(groups.get(container.project) ?? []), container])
  }
  const result: ExternalComposeProject[] = []
  for (const [name, containers] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    result.push(await describeProject(name, containers))
  }
  return result
}

async function describeProject(
  name: string,
  containers: ComposeContainer[],
): Promise<ExternalComposeProject> {
  const labels = containers[0]!.labels
  const workingDir = labels[LABEL.workingDir] ? hostPath(labels[LABEL.workingDir]!) : null
  const configFiles = (labels[LABEL.configFiles] ?? '')
    .split(',')
    .map((file) => file.trim())
    .filter(Boolean)
    .map(hostPath)

  const volumes = new Map<string, { key: string; name: string; services: Set<string> }>()
  const relativeBinds: ExternalComposeProject['relativeBinds'] = []
  for (const container of containers) {
    for (const mount of container.mounts) {
      if (mount.type === 'volume' && mount.name?.startsWith(`${name}_`)) {
        const entry = volumes.get(mount.name) ?? {
          key: mount.name.slice(name.length + 1),
          name: mount.name,
          services: new Set<string>(),
        }
        entry.services.add(container.service)
        volumes.set(mount.name, entry)
      }
      if (mount.type === 'bind' && workingDir) {
        const source = hostPath(mount.source)
        const inside = relative(workingDir, source)
        if (inside && !inside.startsWith('..') && !isAbsolute(inside)) {
          relativeBinds.push({
            service: container.service,
            source: `./${inside}`,
            target: mount.destination,
          })
        }
      }
    }
  }

  const services = new Map<string, ExternalComposeProject['services'][number]>()
  for (const container of containers) {
    if (services.has(container.service)) continue
    services.set(container.service, {
      name: container.service,
      image: container.image,
      state: container.state,
      status: container.status,
      ports: container.ports,
    })
  }

  let compose: ExternalComposeProject['compose']
  const composePath = configFiles[0] ?? null
  if (!composePath) {
    compose = { path: null, error: 'Docker n’indique pas le fichier Compose de ce projet.' }
  } else {
    try {
      const content = await readSmallFile(composePath)
      compose = { path: composePath, content, analysis: analyzeCompose(content) }
    } catch (error) {
      compose = { path: composePath, error: unreadable(error) }
    }
  }

  let env: ExternalComposeProject['env'] = null
  const envPath =
    labels[LABEL.envFile]?.split(',')[0]?.trim() || (workingDir ? join(workingDir, '.env') : null)
  if (envPath) {
    try {
      env = {
        path: hostPath(envPath),
        variables: parseDotenv(await readSmallFile(hostPath(envPath))),
      }
    } catch (error) {
      // Pas de .env : cas courant, rien à signaler.
      env =
        (error as { code?: string }).code === 'ENOENT' && !labels[LABEL.envFile]
          ? null
          : { path: hostPath(envPath), error: unreadable(error) }
    }
  }

  return {
    name,
    workingDir,
    configFiles,
    services: [...services.values()].sort((a, b) => a.name.localeCompare(b.name)),
    volumes: [...volumes.values()]
      .map((volume) => ({ ...volume, services: [...volume.services].sort() }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    relativeBinds,
    compose,
    env,
  }
}
