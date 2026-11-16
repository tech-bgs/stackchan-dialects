// @ts-nocheck
import Time from 'time'
import config from 'mc/config'
import SNTP from 'sntp'

/** TLS certificate validation needs a reasonably current clock. */
const MIN_VALID_TIME_MS = 1_704_067_200_000 // 2024-01-01 UTC

export function isNetworkTimeReady(): boolean {
  return Date.now() >= MIN_VALID_TIME_MS
}

export function ensureNetworkTime(): Promise<void> {
  if (isNetworkTimeReady()) {
    return Promise.resolve()
  }
  const host = config.sntp
  if (typeof host !== 'string' || host.length === 0) {
    return Promise.reject(new Error('SNTP host is not configured'))
  }
  trace(`[NetworkTime] syncing via ${host}\n`)
  return new Promise((resolve, reject) => {
    new SNTP({ host }, (message, value) => {
      if (message === SNTP.time) {
        Time.set(value)
        trace(`[NetworkTime] synced\n`)
        resolve()
        return
      }
      if (message === SNTP.error) {
        reject(new Error('Failed to sync network time'))
      }
    })
  })
}
