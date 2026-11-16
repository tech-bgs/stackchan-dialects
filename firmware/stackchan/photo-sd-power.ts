// @ts-nocheck
/**
 * CoreS3 microSD power — use Host.SdPower boot bridge (XS-safe I2C).
 *
 * Power path: AXP2101 ALDO4 → AW9523 P0 bit4 (TF_SW) → TF slot.
 * Do not call power.axp2101 from this module (XS compartment boundary).
 */
import Timer from 'timer'

const AW9523_REG_P0 = 0x02
const AW9523_REG_P0_MODE = 0x11
const AW9523_P0_PUSH_PULL = 0x10
const BSP_SD_EN_BIT = 4
const _AXP_REG_ALDO4_VOLT = 0x95
const AXP_ALDO4_3V3 = 0x1c

export type CoreS3SdPowerState = {
  aldo4Reg90: number
  aldo4Enabled: boolean
  aldo4Reg95: number
  aw9523P0: number
  aw9523P0Mode: number
  bspSdEn: boolean
}

type HostSdPower = {
  enable?: () => void
  readState?: () => CoreS3SdPowerState
  traceReadback?: (label: string) => boolean
}

type Aw9523Like = {
  writeByte(reg: number, value: number): void
  writeByteMask(reg: number, data: number, mask: number): void
}

function hexByte(value: number): string {
  return `0x${(value & 0xff).toString(16).padStart(2, '0')}`
}

function getHostSdPower(): HostSdPower | undefined {
  return (globalThis as { Host?: { SdPower?: HostSdPower } }).Host?.SdPower
}

function logPowerBridgeStatus(label: string): void {
  const host = getHostSdPower()
  const g = globalThis as {
    enableCoreS3SdCardPower?: unknown
    readCoreS3SdPowerState?: unknown
    power?: unknown
  }
  trace(
    `[SD] power bridge ${label}: Host.SdPower=${host ? 'yes' : 'no'} enable=${typeof host?.enable} readState=${typeof host?.readState} globalHook=${typeof g.enableCoreS3SdCardPower} power=${g.power ? 'yes' : 'no'}\n`,
  )
}

/** Read ALDO4 + AW9523 via Host.SdPower.readState (boot I2C closure). */
export function readCoreS3SdPowerState(): CoreS3SdPowerState | null {
  const host = getHostSdPower()
  if (typeof host?.readState === 'function') {
    try {
      return host.readState()
    } catch (error) {
      trace(`[SD] power readback: Host.SdPower.readState I2C error ${error}\n`)
      return null
    }
  }

  const g = globalThis as { readCoreS3SdPowerState?: () => CoreS3SdPowerState }
  if (typeof g.readCoreS3SdPowerState === 'function') {
    try {
      return g.readCoreS3SdPowerState()
    } catch (error) {
      trace(`[SD] power readback: global hook I2C error ${error}\n`)
      return null
    }
  }

  return null
}

/** Log SD power-path readback; returns true when ALDO4 + TF_SW enabled in registers. */
export function traceCoreS3SdPowerReadback(label: string): boolean {
  const host = getHostSdPower()
  if (typeof host?.traceReadback === 'function') {
    return host.traceReadback(label)
  }

  const g = globalThis as { traceCoreS3SdPowerReadback?: (l: string) => boolean }
  if (typeof g.traceCoreS3SdPowerReadback === 'function') {
    return g.traceCoreS3SdPowerReadback(label)
  }

  const state = readCoreS3SdPowerState()
  if (!state) {
    logPowerBridgeStatus(label)
    trace(`[SD] power readback ${label}: unavailable — deploy Host.SdPower (m5stack-cores3-setup-target)\n`)
    return false
  }

  const aldo4VoltOk = state.aldo4Reg95 === AXP_ALDO4_3V3
  const softwareOk = state.aldo4Enabled && aldo4VoltOk && state.bspSdEn

  trace(
    `[SD] power readback ${label}: AXP reg0x90=${hexByte(state.aldo4Reg90)} ALDO4_en=${state.aldo4Enabled ? 1 : 0} reg0x95=${hexByte(state.aldo4Reg95)} (expect ${hexByte(AXP_ALDO4_3V3)})\n`,
  )
  trace(
    `[SD] power readback ${label}: AW9523 P0=${hexByte(state.aw9523P0)} BSP_SD_EN(bit4)=${state.bspSdEn ? 1 : 0} P0_MODE=${hexByte(state.aw9523P0Mode)}\n`,
  )
  trace(
    `[SD] power path ${label}: ${softwareOk ? 'ALDO4+TF_SW OK (I2C)' : 'MISMATCH — ALDO4 or TF_SW not enabled in registers'}\n`,
  )

  return softwareOk
}

function enableAw9523OnlyFallback(expander: Aw9523Like): void {
  expander.writeByte(AW9523_REG_P0_MODE, AW9523_P0_PUSH_PULL)
  expander.writeByteMask(AW9523_REG_P0, 1 << BSP_SD_EN_BIT, 0xff)
  Timer.delay(150)
  trace('[SD] power enabled: AW9523 only (FALLBACK — ALDO4 not written; use Host.SdPower)\n')
}

/** Enable SD slot power (ALDO4 + TF_SW) and log I2C readback. */
export function enableCoreS3PhotoSdPower(): void {
  logPowerBridgeStatus('before enable')

  const host = getHostSdPower()
  if (typeof host?.enable === 'function') {
    trace('[SD] power enable path: Host.SdPower.enable\n')
    host.enable()
    return
  }

  const g = globalThis as { enableCoreS3SdCardPower?: () => void }
  if (typeof g.enableCoreS3SdCardPower === 'function') {
    trace('[SD] power enable path: globalThis.enableCoreS3SdCardPower\n')
    g.enableCoreS3SdCardPower()
    return
  }

  const power = (globalThis as { power?: { expander?: Aw9523Like } }).power
  if (power?.expander) {
    trace('[SD] power enable path: expander-only FALLBACK\n')
    enableAw9523OnlyFallback(power.expander)
    traceCoreS3SdPowerReadback('after enable')
    return
  }

  trace('[SD] power enable failed: no Host.SdPower, no hook, no expander\n')
}
