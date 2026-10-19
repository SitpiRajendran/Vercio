import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { PassThrough, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import type { LocalDestinationConfig, S3DestinationConfig } from '@vercio/shared'

/** Lieu de dépôt des sauvegardes. Les clés sont relatives (`projet/env/date/fichier`). */
export interface BackupStore {
  /** Écrit le flux ; renvoie le nombre d'octets écrits. */
  put(key: string, data: Readable): Promise<number>
  get(key: string): Promise<Readable>
  /** Supprime un dossier de sauvegarde entier. */
  removeFolder(folder: string): Promise<void>
  /** Écrit puis efface un fichier témoin : droits et accès vérifiés. */
  check(): Promise<void>
  /** Libellé lisible : chemin ou `s3://bucket/préfixe`. */
  readonly location: string
}

export class BackupStoreError extends Error {}

function countBytes(): { counter: PassThrough; bytes: () => number } {
  let total = 0
  const counter = new PassThrough()
  counter.on('data', (chunk: Buffer) => {
    total += chunk.length
  })
  return { counter, bytes: () => total }
}

export class LocalStore implements BackupStore {
  readonly #root: string

  constructor(config: LocalDestinationConfig) {
    this.#root = resolve(config.path)
  }

  get location() {
    return this.#root
  }

  #path(key: string): string {
    const path = resolve(this.#root, key)
    if (!path.startsWith(this.#root + sep))
      throw new BackupStoreError('Chemin hors de la destination')
    return path
  }

  async put(key: string, data: Readable): Promise<number> {
    const path = this.#path(key)
    await mkdir(dirname(path), { recursive: true })
    const partial = `${path}.partiel`
    const { counter, bytes } = countBytes()
    try {
      await pipeline(data, counter, createWriteStream(partial, { mode: 0o600 }))
    } catch (error) {
      await unlink(partial).catch(() => {})
      throw error
    }
    await rename(partial, path)
    return bytes()
  }

  async get(key: string): Promise<Readable> {
    const path = this.#path(key)
    await stat(path).catch(() => {
      throw new BackupStoreError(`Fichier introuvable dans la destination : ${key}`)
    })
    return createReadStream(path)
  }

  async removeFolder(folder: string): Promise<void> {
    await rm(this.#path(folder), { recursive: true, force: true })
    // Dossiers parents vidés (projet/env) : on ne laisse pas d'arborescence vide.
    let parent = dirname(this.#path(folder))
    while (parent.startsWith(this.#root + sep)) {
      const left = await readdir(parent).catch(() => null)
      if (!left || left.length) break
      await rm(parent, { recursive: true, force: true })
      parent = dirname(parent)
    }
  }

  async check(): Promise<void> {
    try {
      await mkdir(this.#root, { recursive: true })
      const probe = join(this.#root, `.vercio-test-${process.pid}`)
      await writeFile(probe, 'ok')
      await unlink(probe)
    } catch (error) {
      throw new BackupStoreError(
        `Dossier inaccessible en écriture (${this.#root}) : ${(error as Error).message}`,
      )
    }
  }
}

export class S3Store implements BackupStore {
  readonly #client: S3Client
  readonly #config: S3DestinationConfig

  constructor(
    config: S3DestinationConfig,
    credentials: { accessKeyId: string; secretAccessKey: string },
    clientOptions: Partial<S3ClientConfig> = {},
  ) {
    this.#config = config
    this.#client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.pathStyle,
      credentials,
      // Les hébergeurs compatibles S3 ne gèrent pas tous les sommes de contrôle récentes.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      ...clientOptions,
    })
  }

  get location() {
    const path = [this.#config.bucket, this.#config.prefix].filter(Boolean).join('/')
    return `s3://${path}${this.#config.endpoint ? ` (${new URL(this.#config.endpoint).host})` : ''}`
  }

  #key(key: string): string {
    return [this.#config.prefix, key].filter(Boolean).join('/')
  }

  async put(key: string, data: Readable): Promise<number> {
    const { counter, bytes } = countBytes()
    data.on('error', (error) => counter.destroy(error))
    data.pipe(counter)
    try {
      await new Upload({
        client: this.#client,
        params: { Bucket: this.#config.bucket, Key: this.#key(key), Body: counter },
        // 16 Mio par morceau : 160 Gio au plus avec 10 000 morceaux.
        partSize: 16 * 1024 * 1024,
        queueSize: 2,
      }).done()
    } catch (error) {
      throw this.#explain(error)
    }
    return bytes()
  }

  async get(key: string): Promise<Readable> {
    try {
      const result = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#config.bucket, Key: this.#key(key) }),
      )
      return result.Body as Readable
    } catch (error) {
      throw this.#explain(error)
    }
  }

  async removeFolder(folder: string): Promise<void> {
    const prefix = `${this.#key(folder)}/`
    try {
      let token: string | undefined
      do {
        const page = await this.#client.send(
          new ListObjectsV2Command({
            Bucket: this.#config.bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        )
        const keys = (page.Contents ?? []).map((item) => ({ Key: item.Key! }))
        if (keys.length) {
          await this.#client.send(
            new DeleteObjectsCommand({
              Bucket: this.#config.bucket,
              Delete: { Objects: keys, Quiet: true },
            }),
          )
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined
      } while (token)
    } catch (error) {
      throw this.#explain(error)
    }
  }

  async check(): Promise<void> {
    try {
      await this.#client.send(new HeadBucketCommand({ Bucket: this.#config.bucket }))
      const key = this.#key(`.vercio-test-${process.pid}`)
      await this.#client.send(
        new PutObjectCommand({ Bucket: this.#config.bucket, Key: key, Body: 'ok' }),
      )
      await this.#client.send(
        new DeleteObjectsCommand({
          Bucket: this.#config.bucket,
          Delete: { Objects: [{ Key: key }], Quiet: true },
        }),
      )
    } catch (error) {
      throw this.#explain(error)
    }
  }

  #explain(error: unknown): BackupStoreError {
    const name = (error as { name?: string })?.name ?? ''
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode
    const message = (error as Error)?.message || String(error)
    if (name === 'NoSuchBucket' || status === 404) {
      return new BackupStoreError(`Bucket « ${this.#config.bucket} » ou fichier introuvable`)
    }
    if (status === 403 || name === 'AccessDenied' || name === 'InvalidAccessKeyId') {
      return new BackupStoreError(
        'Accès refusé : vérifiez les clés et leurs droits (lecture, écriture, suppression) sur le bucket',
      )
    }
    if (name === 'SignatureDoesNotMatch') return new BackupStoreError('Clé secrète incorrecte')
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/.test(message)) {
      return new BackupStoreError(`Stockage injoignable : ${message}`)
    }
    return new BackupStoreError(`Erreur du stockage S3 : ${message}`)
  }
}
