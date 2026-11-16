// @ts-nocheck
/**
 * Boot-time microSD diagnostics (CoreS3 native `photo-storage` only).
 */

export function runSdBootDiagnostics(): void {
  try {
    const diagnose = native('xs_photo_storage_diagnose') as { call?: (self: unknown) => string } | undefined
    if (typeof diagnose?.call !== 'function') {
      trace('[SD] diagnose skipped: native photo-storage not linked\n')
      return
    }
    const report = diagnose.call(globalThis)
    if (typeof report !== 'string' || report.length === 0) {
      return
    }
    for (const line of report.split('\n')) {
      if (line.length > 0) {
        trace(`${line}\n`)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/not found|undefined|unbound|no function/i.test(message)) {
      trace('[SD] diagnose skipped: native photo-storage not linked\n')
      return
    }
    trace(`[SD] diagnose error: ${message}\n`)
  }
}
