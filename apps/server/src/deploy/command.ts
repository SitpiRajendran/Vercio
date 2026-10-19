import { spawn } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

export interface CommandResult {
  code: number
}

export interface RunOptions {
  cwd: string
  env: Record<string, string>
  /** Chaque ligne de sortie, au fil de l'eau. */
  onLine: (line: string, stream: 'stdout' | 'stderr') => void
  timeoutMs?: number
  /** Sortie standard brute (fichier, archive) au lieu de lignes. */
  stdout?: Writable
  /** Entrée standard (restauration d'une archive). */
  stdin?: Readable
}

/** Exécution de commandes : abstraite pour pouvoir tester le moteur sans Docker. */
export interface CommandRunner {
  run(command: string, args: string[], options: RunOptions): Promise<CommandResult>
}

/** Lance un processus sans shell (arguments passés tels quels, aucune interprétation). */
export const spawnRunner: CommandRunner = {
  run(command, args, { cwd, env, onLine, timeoutMs = 15 * 60_000, stdout, stdin }) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd,
        env,
        stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      }) as ReturnType<typeof spawn> & { stdout: Readable; stderr: Readable }
      if (stdin && child.stdin) {
        // Fin prématurée du processus : l'écriture échoue, le code de sortie le dira.
        child.stdin.on('error', () => {})
        stdin.on('error', (error) => {
          onLine(`Lecture impossible : ${error.message}`, 'stderr')
          child.kill('SIGTERM')
        })
        stdin.pipe(child.stdin)
      }
      let flushed: Promise<void> = Promise.resolve()
      if (stdout) {
        flushed = new Promise((done, fail) => {
          stdout.on('finish', done)
          stdout.on('error', fail)
        })
        child.stdout.pipe(stdout)
      }
      const timer = setTimeout(() => {
        onLine(`Délai dépassé (${Math.round(timeoutMs / 1000)} s) : arrêt de la commande`, 'stderr')
        child.kill('SIGTERM')
      }, timeoutMs)
      for (const [stream, name] of [
        [child.stdout, 'stdout'],
        [child.stderr, 'stderr'],
      ] as const) {
        if (name === 'stdout' && stdout) continue
        let buffer = ''
        stream.setEncoding('utf8')
        stream.on('data', (chunk: string) => {
          buffer += chunk
          const lines = buffer.split(/\r?\n|\r/)
          buffer = lines.pop() ?? ''
          for (const line of lines) if (line.trim()) onLine(line, name)
        })
        stream.on('end', () => {
          if (buffer.trim()) onLine(buffer, name)
        })
      }
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        flushed.then(() => resolve({ code: code ?? 1 }), reject)
      })
    })
  },
}
