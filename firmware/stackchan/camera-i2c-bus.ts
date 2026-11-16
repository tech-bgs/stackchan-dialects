// @ts-nocheck
import Modules from 'modules'
import { ensureSharedPY32IOExpander, releaseSharedPY32IOExpander } from 'py32-io-expander'
import Timer from 'timer'

/** CoreS3 internal bus: same pins as camera SCCB (manifest_camera / device.I2C.internal). */
const CORES3_CAMERA_I2C = {
  port: 1,
  data: 12,
  clock: 11,
  hz: 100_000,
  pullup: true,
} as const

/** Common SCCB 7-bit addresses on M5Stack CoreS3 family (OV2640, GC*, OV3660/OV5640). */
const CAMERA_SENSOR_ADDRESSES = [0x30, 0x21, 0x3c] as const

type I2CBus = {
  write(buffer: ArrayBuffer): number | undefined
  close(): void
}

type I2CCtor = new (options: Record<string, unknown>) => I2CBus

/** When true, skip ECMA-419 probe after the first success (disabled for debugging re-init). */
const SKIP_PROBE_WHEN_KNOWN = false

let knownSensorAddress: number | null = null

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

function safeClose(bus: I2CBus | undefined) {
  if (!bus) return
  try {
    bus.close()
  } catch (error) {
    trace(`[CameraI2C] close failed: ${errorMessage(error)}\n`)
  }
}

/**
 * Release stack-chan PY32 SMBus on the internal bus so esp_camera can own SCCB.
 */
export function releaseInternalI2CBusForCamera(): void {
  releaseSharedPY32IOExpander()
}

/**
 * Probe camera SCCB without starting esp_camera. Empty write maps to i2c_master_probe
 * and returns 1 on failure instead of throwing.
 */
export function probeCameraSensor(): boolean {
  if (!Modules.has('embedded:io/i2c')) {
    trace('[CameraI2C] embedded:io/i2c unavailable\n')
    return false
  }

  releaseInternalI2CBusForCamera()

  const I2C = Modules.importNow('embedded:io/i2c') as I2CCtor

  for (const address of CAMERA_SENSOR_ADDRESSES) {
    let bus: I2CBus | undefined
    try {
      bus = new I2C({ ...CORES3_CAMERA_I2C, address })
      const probeFailed = bus.write(new ArrayBuffer(0)) === 1
      if (!probeFailed) {
        knownSensorAddress = address
        trace(`[CameraI2C] sensor responded at 0x${address.toString(16)}\n`)
        return true
      }
    } catch (error) {
      trace(`[CameraI2C] probe 0x${address.toString(16)} failed: ${errorMessage(error)}\n`)
    } finally {
      safeClose(bus)
    }
  }

  trace('[CameraI2C] no camera sensor on internal I2C bus\n')
  return false
}

/** Release PY32 only — use when esp_camera stays initialized between captures. */
export function releaseCameraBusForCapture(): void {
  releaseInternalI2CBusForCamera()
}

/**
 * Prepare internal I2C for first esp_camera_init: release PY32 and probe SCCB.
 */
export function prepareCameraBus(): boolean {
  releaseInternalI2CBusForCamera()
  if (SKIP_PROBE_WHEN_KNOWN && knownSensorAddress !== null) {
    trace(`[CameraI2C] skip probe (sensor known 0x${knownSensorAddress.toString(16)})\n`)
    return true
  }
  return probeCameraSensor()
}

/** Post-esp_camera_deinit settle before PY32 restore (keep modest — teardown already waited). */
const CAMERA_BUS_SETTLE_MS = 150

function restorePy32AfterCameraBus(): void {
  try {
    ensureSharedPY32IOExpander()
    trace('[CameraI2C] PY32 SMBus restored after camera\n')
  } catch (error) {
    trace(`[CameraI2C] PY32 restore failed: ${errorMessage(error)}\n`)
  }
}

/** After esp_camera_deinit — release PY32 and wait for SCCB / ECMA-419 bus to settle (sync). */
export function finalizeCameraBus(): void {
  trace('[CameraI2C] finalizeCameraBus\n')
  releaseInternalI2CBusForCamera()
  delayForCameraBus(CAMERA_BUS_SETTLE_MS)
  restorePy32AfterCameraBus()
}

/**
 * PY32 restore on a later timer tick — do not block the same turn as device.close().
 */
export function finalizeCameraBusAsync(settleMs = CAMERA_BUS_SETTLE_MS): Promise<void> {
  return new Promise((resolve) => {
    trace('[CameraI2C] finalizeCameraBus async begin\n')
    releaseInternalI2CBusForCamera()
    Timer.set(() => {
      restorePy32AfterCameraBus()
      trace('[CameraI2C] finalizeCameraBus async done\n')
      resolve()
    }, settleMs)
  })
}

export function delayForCameraBus(ms = CAMERA_BUS_SETTLE_MS): void {
  const delay = (globalThis as { Timer?: { delay: (ms: number) => void } }).Timer?.delay
  if (delay) {
    delay(ms)
    return
  }
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {}
}

/** @internal Test hook */
export function resetCameraBusStateForTest(): void {
  knownSensorAddress = null
}
