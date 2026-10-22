import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { FastifyBaseLogger } from 'fastify'
import { inArray } from 'drizzle-orm'
import {
  compareVersions,
  type UpdateRun,
  type UpdateStatus,
  type VercioRelease,
} from '@vercio/shared'
import type { BackupService } from '../backups/service.js'
import type { Database } from '../db/client.js'
import { deployments } from '../db/schema.js'
import type { HostDriver, SelfContainer } from '../docker/host-driver.js'
import { audit } from '../lib/audit.js'
import { describeNetworkError, httpRequest } from '../lib/http.js'

/** Dépôt public : ses releases annoncent les versions, ses images sont sur ghcr.io. */
export const UPDATE_REPOSITORY = 'SitpiRajendran/Vercio'
export const UPDATE_IMAGE = 'ghcr.io/sitpirajendran/vercio'
/** Conteneur auxiliaire : client Docker avec Compose. */
export const UPDATE_HELPER_IMAGE = 'docker:27.5.1-cli'
const CHECK_INTERVAL_MS = 6 * 3600 * 1000
const FINISHED: UpdateRun['phase'][] = ['done', 'failed', 'rolled_back']

type User = { id: string; username: string }

/** Erreur à montrer telle quelle à l'administrateur. */
export class UpdateError extends Error {}

export interface UpdateServiceOptions {
  db: Database
  host: HostDriver
  backups: BackupService
  dataDir: string
  version: string
  enabled: boolean
  log: FastifyBaseLogger
  /** Tests : réponse de l'API GitHub. */
  fetchRelease?: () => Promise<VercioRelease>
}

/** Ce que le conteneur auxiliaire doit savoir de l'installation de Vercio. */
interface Installation {
  project: string
  service: string
  workingDir: string
  configFiles: string[]
  dataDirOnHost: string
  socketOnHost: string
}

/**
 * Mises à jour de Vercio : vérification des releases GitHub, puis mise à jour depuis
 * l'interface. Vercio ne peut pas remplacer son propre conteneur : après une sauvegarde, un
 * conteneur auxiliaire (client Docker) fixe VERCIO_TAG dans le .env de l'installation, relance
 * le service et remet l'ancienne version si la nouvelle ne devient pas saine.
 */
export class UpdateService {
  #latest: VercioRelease | null = null
  #checkedAt: string | null = null
  #error: string | null = null
  #run: UpdateRun | null = null
  #timer: NodeJS.Timeout | null = null
  readonly #dir: string

  constructor(private readonly options: UpdateServiceOptions) {
    this.#dir = join(resolve(options.dataDir), 'updates')
  }

  get #runFile() {
    return join(this.#dir, 'run.json')
  }

  /** Fichier écrit par le conteneur auxiliaire (étape, message). */
  get #helperFile() {
    return join(this.#dir, 'helper.json')
  }

  /** Au démarrage : issue de la mise à jour qui vient de remplacer (ou non) ce processus. */
  async recover(): Promise<void> {
    const run = await readJson<UpdateRun>(this.#runFile)
    if (!run) return
    if (!FINISHED.includes(run.phase)) {
      const helper = await readJson<{ phase: string; message?: string }>(this.#helperFile)
      if (this.options.version === run.to) {
        run.phase = 'done'
        run.message = null
      } else if (helper?.phase === 'rolled_back' || helper?.phase === 'failed') {
        run.phase = helper.phase
        run.message = helper.message || null
      } else if (helper?.phase === 'pulling' || helper?.phase === 'restarting') {
        // L'auxiliaire travaille encore (Vercio a redémarré pour une autre raison).
        this.#run = run
        return
      } else {
        // Arrêt avant que l'auxiliaire ne prenne la suite.
        run.phase = 'failed'
        run.message = 'La mise à jour ne s’est pas terminée'
      }
      run.finishedAt = new Date().toISOString()
      await this.#save(run)
      await audit(this.options.db, {
        action: 'vercio.update',
        target: `${run.from} → ${run.to}`,
        success: run.phase === 'done',
        details: { phase: run.phase, message: run.message },
      })
    }
    this.#run = run
  }

  start(): void {
    if (!this.options.enabled) return
    const check = () => void this.check().catch(() => {})
    setTimeout(check, 30_000).unref()
    this.#timer = setInterval(check, CHECK_INTERVAL_MS)
    this.#timer.unref()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
  }

  async check(): Promise<UpdateStatus> {
    if (!this.options.enabled) return this.status()
    try {
      this.#latest = await (this.options.fetchRelease ?? fetchLatestRelease)()
      this.#error = null
    } catch (error) {
      this.#error = error instanceof UpdateError ? error.message : describeNetworkError(error)
      this.options.log.warn({ err: error }, 'Vérification des mises à jour impossible')
    }
    this.#checkedAt = new Date().toISOString()
    return this.status()
  }

  async status(): Promise<UpdateStatus> {
    const current = this.options.version
    const latest = this.#latest
    const newer = latest ? compareVersions(latest.version, current) : null
    let reason: string | null = null
    if (!this.options.enabled) reason = 'Vérification désactivée (VERCIO_UPDATE_CHECK=false)'
    else if (compareVersions(current, current) === null) {
      reason = 'Version de développement : mettez à jour avec docker compose'
    } else {
      try {
        await this.#installation()
      } catch (error) {
        reason = error instanceof UpdateError ? error.message : String(error)
      }
    }
    return {
      current,
      latest,
      available: newer !== null && newer > 0,
      checkedAt: this.#checkedAt,
      error: this.#error,
      canUpdate: reason === null,
      reason,
      run: await this.#withHelperPhase(),
    }
  }

  /** Lance la mise à jour ; elle continue en arrière-plan (étape visible dans `status`). */
  async update(version: string, user: User, ip: string): Promise<void> {
    if (this.#run && !FINISHED.includes(this.#run.phase)) {
      throw new UpdateError('Une mise à jour est déjà en cours')
    }
    const status = await this.status()
    if (!status.canUpdate) throw new UpdateError(status.reason!)
    if (!status.latest || status.latest.version !== version) {
      throw new UpdateError('Cette version n’est pas la dernière publiée : vérifiez à nouveau')
    }
    if ((compareVersions(version, this.options.version) ?? 0) <= 0) {
      throw new UpdateError(`Vercio est déjà en version ${this.options.version}`)
    }
    const [busy] = await this.options.db
      .select({ id: deployments.id })
      .from(deployments)
      .where(inArray(deployments.status, ['queued', 'running']))
      .limit(1)
    if (busy) throw new UpdateError('Un déploiement est en cours : attendez sa fin')
    const installation = await this.#installation()

    const run: UpdateRun = {
      from: this.options.version,
      to: version,
      phase: 'backup',
      message: null,
      backup: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    }
    this.#run = run
    await this.#save(run)
    await audit(this.options.db, {
      userId: user.id,
      username: user.username,
      action: 'vercio.update.start',
      target: `${run.from} → ${run.to}`,
      ip,
      success: true,
    })
    void this.#execute(run, installation, user).catch(async (error) => {
      run.phase = 'failed'
      run.message = error instanceof Error ? error.message : String(error)
      run.finishedAt = new Date().toISOString()
      await this.#save(run).catch(() => {})
      this.options.log.error({ err: error }, 'Mise à jour de Vercio impossible')
    })
  }

  async #execute(run: UpdateRun, installation: Installation, user: User): Promise<void> {
    // 1. Sauvegarde : la nouvelle version peut migrer la base sans retour possible.
    run.backup = await this.options.backups.safetyBackup(user, `v${run.to}`)
    // 2. Conteneur auxiliaire : il prend la suite, Vercio va être remplacé.
    run.phase = 'starting'
    await this.#save(run)
    await rm(this.#helperFile, { force: true })
    await this.options.host.runDetached({
      image: UPDATE_HELPER_IMAGE,
      command: ['sh', '-c', HELPER_SCRIPT],
      env: {
        TARGET: `v${run.to}`,
        PROJECT: installation.project,
        SERVICE: installation.service,
        WORKDIR: installation.workingDir,
        FILES: installation.configFiles.join(','),
        STATUS_FILE: '/vercio-updates/helper.json',
      },
      binds: [
        `${installation.socketOnHost}:/var/run/docker.sock`,
        `${installation.workingDir}:${installation.workingDir}`,
        `${installation.dataDirOnHost}/updates:/vercio-updates`,
      ],
      labels: { 'vercio.managed': 'true', 'vercio.update': run.to },
    })
    run.phase = 'pulling'
    await this.#save(run)
  }

  /** Installation par Docker Compose, à partir de l'image publique : sinon, pas de mise à jour. */
  async #installation(): Promise<Installation> {
    let self: SelfContainer | null
    try {
      self = await this.options.host.selfContainer()
    } catch {
      throw new UpdateError('Docker injoignable')
    }
    if (!self) throw new UpdateError('Vercio ne tourne pas dans un conteneur')
    if (!self.image.startsWith(`${UPDATE_IMAGE}:`) && self.image !== UPDATE_IMAGE) {
      throw new UpdateError(`Image ${self.image} : seule l’image ${UPDATE_IMAGE} est mise à jour`)
    }
    const label = (key: string) => self.labels[`com.docker.compose.${key}`]
    const project = label('project')
    const service = label('service')
    const workingDir = label('project.working_dir')
    const configFiles = label('project.config_files')?.split(',').filter(Boolean) ?? []
    if (!project || !service || !workingDir || !configFiles.length) {
      throw new UpdateError('Vercio n’a pas été lancé avec docker compose')
    }
    const mount = (destination: string) =>
      self.mounts.find((item) => resolve(item.destination) === resolve(destination))?.source
    const dataDirOnHost = mount(this.options.dataDir)
    const socketOnHost = mount('/var/run/docker.sock')
    if (!dataDirOnHost) throw new UpdateError('Dossier de données de Vercio non monté')
    if (!socketOnHost) throw new UpdateError('Socket Docker non monté')
    return { project, service, workingDir, configFiles, dataDirOnHost, socketOnHost }
  }

  /** En cours : l'étape vient du conteneur auxiliaire dès qu'il a pris la suite. */
  async #withHelperPhase(): Promise<UpdateRun | null> {
    const run = this.#run
    if (!run || FINISHED.includes(run.phase) || run.phase === 'backup') return run
    const helper = await readJson<{ phase: UpdateRun['phase']; message?: string }>(this.#helperFile)
    if (!helper) return run
    return { ...run, phase: helper.phase, message: helper.message || run.message }
  }

  async #save(run: UpdateRun): Promise<void> {
    await mkdir(this.#dir, { recursive: true })
    await writeFile(this.#runFile, JSON.stringify(run, null, 2))
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** Dernière release du dépôt public. */
export async function fetchLatestRelease(): Promise<VercioRelease> {
  const response = await httpRequest(
    `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`,
    { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Vercio' } },
  )
  if (!response.ok) throw new UpdateError(`GitHub a répondu ${response.status}`)
  const body = (await response.json()) as {
    tag_name?: string
    name?: string | null
    body?: string | null
    html_url?: string
    published_at?: string | null
  }
  const version = body.tag_name?.replace(/^v/, '') ?? ''
  if (compareVersions(version, version) === null) {
    throw new UpdateError(`Release inattendue : ${body.tag_name}`)
  }
  return {
    version,
    name: body.name || `v${version}`,
    notes: body.body ?? '',
    url: body.html_url ?? `https://github.com/${UPDATE_REPOSITORY}/releases`,
    publishedAt: body.published_at ?? null,
  }
}

/**
 * Script du conteneur auxiliaire. Fixe VERCIO_TAG dans le .env de l'installation (la version
 * tient aussi après un `docker compose up` à la main), relance Vercio, attend qu'il soit sain
 * (3 min), sinon remet la version précédente.
 */
export const HELPER_SCRIPT = String.raw`
set -u
status() { printf '{"phase":"%s","message":"%s"}\n' "$1" "$2" > "$STATUS_FILE"; }
cd "$WORKDIR" || { status failed "Dossier d’installation introuvable"; exit 1; }
FLAGS="-p $PROJECT"
for file in $(echo "$FILES" | tr ',' ' '); do
  grep -q VERCIO_TAG "$file" || { status failed "$file ne lit pas VERCIO_TAG : mettez à jour avec docker compose"; exit 1; }
  FLAGS="$FLAGS -f $file"
done
[ -f .env ] || touch .env
previous=$(grep -E '^VERCIO_TAG=' .env | tail -n 1 | cut -d= -f2-)
settag() {
  if grep -qE '^VERCIO_TAG=' .env; then sed -i "s|^VERCIO_TAG=.*|VERCIO_TAG=$1|" .env
  else printf '\nVERCIO_TAG=%s\n' "$1" >> .env; fi
}
status pulling ""
VERCIO_TAG="$TARGET" docker compose $FLAGS pull "$SERVICE" || { status failed "Téléchargement de l’image $TARGET impossible"; exit 1; }
settag "$TARGET"
status restarting ""
if docker compose $FLAGS up -d --no-deps "$SERVICE"; then
  i=0
  while [ $i -lt 90 ]; do
    id=$(docker compose $FLAGS ps -q "$SERVICE")
    state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null)
    [ "$state" = healthy ] && { status done ""; exit 0; }
    [ "$state" = unhealthy ] || [ "$state" = exited ] && break
    i=$((i + 1)); sleep 2
  done
fi
if [ -n "$previous" ]; then settag "$previous"; else sed -i '/^VERCIO_TAG=/d' .env; fi
docker compose $FLAGS up -d --no-deps "$SERVICE"
status rolled_back "La version $TARGET n’a pas démarré : retour à la version précédente"
`
