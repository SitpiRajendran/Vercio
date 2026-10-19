import type { ConnectionCheck } from '@vercio/shared'

/** Construit progressivement le résultat d'un test de connexion. */
export class CheckReport {
  readonly details: ConnectionCheck['details'] = []
  readonly warnings: string[] = []

  detail(label: string, value: string | null | undefined): this {
    if (value) this.details.push({ label, value })
    return this
  }

  warn(message: string): this {
    this.warnings.push(message)
    return this
  }

  ok(message: string): ConnectionCheck {
    return this.#result(true, message)
  }

  fail(message: string): ConnectionCheck {
    return this.#result(false, message)
  }

  #result(ok: boolean, message: string): ConnectionCheck {
    return {
      ok,
      message,
      details: this.details,
      warnings: this.warnings,
      checkedAt: new Date().toISOString(),
    }
  }
}
