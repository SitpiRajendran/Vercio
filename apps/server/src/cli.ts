import { createReadStream, createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { pipeline } from 'node:stream/promises'
import { and, eq } from 'drizzle-orm'
import { decryptStream } from './backups/crypto.js'
import { loadConfig } from './config.js'
import { createDatabase } from './db/client.js'
import { sessions, users } from './db/schema.js'
import { audit } from './lib/audit.js'
import { hashPassword, temporaryPassword } from './lib/password.js'

/**
 * Commandes de secours, à lancer dans le conteneur :
 *   docker compose exec vercio node dist/cli.js reset-totp <identifiant>
 *   docker compose exec vercio node dist/cli.js reset-password <identifiant>
 *   node dist/cli.js decrypt-backup <fichier.enc> <sortie>   (sans base de données)
 */
const USAGE =
  'Usage : node dist/cli.js <reset-totp|reset-password> <identifiant>\n' +
  '        node dist/cli.js decrypt-backup <fichier.enc> <sortie>'

/** Déchiffre un fichier de sauvegarde ; phrase lue dans VERCIO_BACKUP_PASSPHRASE ou demandée. */
async function decryptBackup(input: string | undefined, output: string | undefined) {
  if (!input || !output) {
    console.error(USAGE)
    process.exit(1)
  }
  let passphrase = process.env.VERCIO_BACKUP_PASSPHRASE
  if (!passphrase) {
    const prompt = createInterface({ input: process.stdin, output: process.stderr })
    passphrase = await prompt.question('Phrase de chiffrement : ')
    prompt.close()
  }
  try {
    await pipeline(createReadStream(input), decryptStream(passphrase), createWriteStream(output))
  } catch (error) {
    // Rien de partiel : un fichier tronqué passerait pour une sauvegarde valide.
    await rm(output, { force: true })
    throw error
  }
  console.log(`Déchiffré dans ${output}`)
}

async function main() {
  const [command, username] = process.argv.slice(2)
  if (command === 'decrypt-backup') return decryptBackup(username, process.argv[4])
  if (!command || !username || !['reset-totp', 'reset-password'].includes(command)) {
    console.error(USAGE)
    process.exit(1)
  }

  const config = loadConfig()
  const { db, sql } = createDatabase(config.DATABASE_URL)
  try {
    const [user] = await db
      .select()
      .from(users)
      .where(and(eq(users.provider, 'local'), eq(users.subject, username)))
      .limit(1)
    if (!user) throw new Error(`Compte local « ${username} » introuvable`)

    if (command === 'reset-totp') {
      await db
        .update(users)
        .set({ totpSecretEnc: null, totpLastStep: null })
        .where(eq(users.id, user.id))
      console.log(`Double authentification réinitialisée pour « ${username} ».`)
      console.log('Elle sera de nouveau configurée à la prochaine connexion.')
    } else {
      const password = temporaryPassword()
      await db
        .update(users)
        .set({ passwordHash: await hashPassword(password), passwordChangeRequired: true })
        .where(eq(users.id, user.id))
      console.log(`Mot de passe temporaire de « ${username} » : ${password}`)
      console.log('Il devra être remplacé à la prochaine connexion.')
    }
    await db.delete(sessions).where(eq(sessions.userId, user.id))
    await audit(db, {
      userId: user.id,
      username: user.username,
      action: `cli.${command}`,
      success: true,
    })
  } finally {
    await sql.end()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
