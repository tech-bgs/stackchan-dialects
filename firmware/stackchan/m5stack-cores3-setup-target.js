/*
 * CoreS3 setup-target (stack-chan fork of Moddable m5stack_cores3/setup-target).
 *
 * Changes vs upstream:
 *   - Power.axp2101 is public (reuse boot I2C; avoid duplicate address 0x34)
 *   - Power.enableSdCardPower() reuses boot AW9523 expander (0x58)
 */
import Resource from 'Resource'
import config from 'mc/config'
import Timer from 'timer'

import AXP2101 from 'embedded:peripheral/Power/axp2101'
import AudioOut from 'embedded:io/audio/out'

const AW9523_REG_P0 = 0x02
const AW9523_REG_P0_MODE = 0x11
const AW9523_P0_PUSH_PULL = 0x10
const BSP_SD_EN_BIT = 4
const AXP_REG_LDO_ONOFF = 0x90
const AXP_REG_ALDO4 = 0x95
const AXP_ALDO4_ENABLE_BIT = 3
const AXP_ALDO4_3V3 = 0x1c

function hexByte(value) {
  return `0x${(value & 0xff).toString(16).padStart(2, '0')}`
}

/**
 * XS modules cannot call power.axp2101.readByte across compartment boundaries.
 * Install boot closures on globalThis (same pattern as enableCoreS3SdCardPower).
 */
function installCoreS3SdPowerGlobals(power) {
  function readSdPowerState() {
    const aldo4Reg90 = power.axp2101.readByte(AXP_REG_LDO_ONOFF)
    const aldo4Reg95 = power.axp2101.readByte(AXP_REG_ALDO4)
    const aw9523P0 = power.expander.readByte(AW9523_REG_P0)
    const aw9523P0Mode = power.expander.readByte(AW9523_REG_P0_MODE)
    return {
      aldo4Reg90,
      aldo4Enabled: ((aldo4Reg90 >> AXP_ALDO4_ENABLE_BIT) & 1) === 1,
      aldo4Reg95,
      aw9523P0,
      aw9523P0Mode,
      bspSdEn: ((aw9523P0 >> BSP_SD_EN_BIT) & 1) === 1,
    }
  }

  function traceSdPowerReadback(label) {
    let state
    try {
      state = readSdPowerState()
    } catch (error) {
      trace(`[SD] power readback ${label}: I2C error ${error}\n`)
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
    if (softwareOk) {
      trace(`[SD] power note ${label}: I2C OK does not prove VDD_3V3_SD at slot — use DMM if MISO still 0xFF\n`)
    }
    return softwareOk
  }

  const sdPower = {
    enable() {
      if (typeof power.enableSdCardPower !== 'function') {
        trace('[SD] Host.SdPower.enable: power.enableSdCardPower missing\n')
        return
      }
      power.enableSdCardPower()
      traceSdPowerReadback('after enable')
    },
    readState: readSdPowerState,
    traceReadback: traceSdPowerReadback,
  }

  globalThis.readCoreS3SdPowerState = readSdPowerState
  globalThis.traceCoreS3SdPowerReadback = traceSdPowerReadback
  globalThis.enableCoreS3SdCardPower = sdPower.enable
  return sdPower
}

const HostBacklight = class {
  constructor(brightness = 100) {
    this.write(brightness)
  }
  write(value) {
    if (undefined !== globalThis.power) globalThis.power.brightness = value
  }
  close() {}
}

const _state = {
  handleRotation: nop,
}

/** StackChan base AXP2101 rail profile (after fork Power() defaults). */
function patchStackChanPower(power) {
  const axp2101 = power?.axp2101
  if (!axp2101) {
    trace('[m5stackchan] AXP2101 unavailable for power patch\n')
    return
  }

  const data = axp2101.readByte(AXP_REG_LDO_ONOFF)
  axp2101.writeByte(AXP_REG_LDO_ONOFF, data | 0b10110100)
  axp2101.writeByte(0x97, 0b11110 - 2)
  axp2101.writeByte(0x69, 0b00110101)
  axp2101.writeByte(AXP_REG_LDO_ONOFF, 0xbf)
  axp2101.writeByte(0x94, 33 - 5)
  axp2101.writeByte(AXP_REG_ALDO4, AXP_ALDO4_3V3)
  axp2101.writeByte(0x27, 0x00)

  const charge = axp2101.readByte(0x62)
  axp2101.writeByte(0x62, (charge & 0xe0) | 13)
  trace('[m5stackchan] patched CoreS3 AXP2101 power rails\n')
}

function finishBootSdPower() {
  const sdPower = globalThis.Host?.SdPower
  if (sdPower && typeof sdPower.enable === 'function') {
    trace('[SD] setup: enabling SD slot power (ALDO4 + TF_SW) after StackChan rail patch\n')
    sdPower.enable()
  } else {
    trace(
      `[SD] setup: Host.SdPower missing (enable=${typeof sdPower?.enable}) — check setup/target manifest override\n`,
    )
  }
  trace(
    `[SD] setup compartment: Host.SdPower=${globalThis.Host?.SdPower ? 'yes' : 'no'} enable=${typeof globalThis.Host?.SdPower?.enable} readback=${typeof globalThis.traceCoreS3SdPowerReadback}\n`,
  )
  if (typeof globalThis.traceCoreS3SdPowerReadback === 'function') {
    globalThis.traceCoreS3SdPowerReadback('boot-after-patch')
  }
}

class M5CoreS3Button {
  #value = 0
  read() {
    return this.#value
  }
  write(value) {
    if (this.#value === value) return
    this.#value = value
    this.onChanged?.()
  }
}

export default function (done) {
  if (config.virtualButton) {
    globalThis.button = {
      a: new M5CoreS3Button(),
      b: new M5CoreS3Button(),
      c: new M5CoreS3Button(),
    }
  }

  const power = new Power({ sensor: { ...device.I2C.internal, io: device.io.SMBus } })
  const sdPower = installCoreS3SdPowerGlobals(power)
  globalThis.power = power
  globalThis.Host = {
    Backlight: HostBacklight,
    SdPower: sdPower,
  }
  trace('[SD] setup: Host.SdPower installed\n')
  globalThis.traceCoreS3SdPowerReadback('boot')
  try {
    patchStackChanPower(power)
  } catch (error) {
    trace(`[m5stackchan] AXP2101 power patch failed: ${error}\n`)
  }
  finishBootSdPower()
  globalThis.amp = new AW88298({ sensor: { ...device.I2C.internal, io: device.io.SMBus } })
  globalThis.mic = new ES7210({ sensor: { ...device.I2C.internal, io: device.io.SMBus } })
  globalThis.mic.init()

  if (config.startupSound) {
    const buf = new Resource(config.startupSound)
    const playing = new Uint8Array(buf, 0, buf.byteLength)
    playing.position = 0
    const speaker = new AudioOut({
      onWritable(size) {
        do {
          let use = playing.byteLength - playing.position
          if (use) {
            if (use > size) use = size
            this.write(playing.subarray(playing.position, playing.position + use))
            playing.position += use
          }
          if (playing.position === playing.byteLength) {
            this.stop()
            this.close()
            Timer.set(this.done)
            break
          }
          size -= use
        } while (size)
      },
    })
    speaker.done = done
    done = undefined
    speaker.start()
  }

  done?.()
}

class AW88298 {
  #io
  #rateTable
  #sampleRate

  constructor(options) {
    this.#io = new options.sensor.io({
      hz: 400_000,
      address: 0x36,
      ...options.sensor,
    })
    const io = this.#io

    this.#rateTable = [4, 5, 6, 8, 10, 11, 15, 20, 22, 44]
    io.writeUint16(0x05, 0x0008, true)
    io.writeUint16(0x61, 0x0673, true)
    io.writeUint16(0x04, 0x4040, true)
    this.volume = 250
    this.sampleRate = 24000
  }

  set sampleRate(sampleRate) {
    if (this.#sampleRate === sampleRate) {
      return
    }
    this.#sampleRate = sampleRate
    let rateData = 0
    const rate = Math.round((sampleRate + 1102) / 2205)
    while (rate > this.#rateTable[rateData] && ++rateData < this.#rateTable.length);
    rateData |= 0x14c0
    this.#io.writeUint16(0x06, rateData, true)
  }

  set volume(volume) {
    const vdata = Math.round(Math.min(256, Math.max(0, volume)))
    this.#io.writeUint16(0x0c, ((256 - vdata) << 8) | 0x64, true)
  }

  get volume() {
    const vdata = this.readByte(0x0c)
    return 256 - vdata
  }
}

class ES7210 {
  #io

  constructor(options) {
    this.#io = new options.sensor.io({
      hz: 400_000,
      address: 0x40,
      ...options.sensor,
    })
  }

  init() {
    const io = this.#io
    io.writeUint8(0x00, 0xff)
    const data = [
      [0x00, 0x41],
      [0x01, 0x1f],
      [0x06, 0x00],
      [0x07, 0x20],
      [0x08, 0x10],
      [0x09, 0x30],
      [0x0a, 0x30],
      [0x20, 0x0a],
      [0x21, 0x2a],
      [0x22, 0x0a],
      [0x23, 0x2a],
      [0x02, 0xc1],
      [0x04, 0x01],
      [0x05, 0x00],
      [0x11, 0x60],
      [0x40, 0x42],
      [0x41, 0x70],
      [0x42, 0x70],
      [0x43, 0x1b],
      [0x44, 0x1b],
      [0x45, 0x00],
      [0x46, 0x00],
      [0x47, 0x00],
      [0x48, 0x00],
      [0x49, 0x00],
      [0x4a, 0x00],
      [0x4b, 0x00],
      [0x4c, 0xff],
      [0x01, 0x14],
    ]
    for (const [reg, value] of data) {
      io.writeUint8(reg, value)
    }
  }
}

class Power {
  constructor(options) {
    this.axp2101 = new AXP2101({ address: 0x34, ...options })
    this.axp2101.writeByte(0x90, 0xbf)
    this.axp2101.writeByte(0x92, 13)
    this.axp2101.writeByte(0x93, 28)
    this.axp2101.writeByte(0x94, 28)
    this.axp2101.writeByte(0x95, 28)
    this.axp2101.writeByte(0x27, 0)
    this.axp2101.writeByte(0x69, 0x11)
    this.axp2101.writeByte(0x10, 0x30)
    this.axp2101.writeByte(0x30, 0x0f)

    this.expander = new AW9523({ ...options })
    this.expander.writeByte(0x02, 0b00000111)
    this.expander.writeByte(0x03, 0b10000011)
    this.expander.writeByte(0x04, 0b00011000)
    this.expander.writeByte(0x05, 0b00001100)
    this.expander.writeByte(0x11, 0b00010000)
    this.expander.writeByte(0x12, 0b11111111)
    this.expander.writeByte(0x13, 0b11111111)

    this.resetLcd()
    installSdCardPowerControl(this)
  }

  resetLcd() {
    this.expander.writeByteMask(0x03, 0, 0b11011111)
    Timer.delay(20)
    this.expander.writeByteMask(0x03, 0b00100000, 0xff)
  }
}

/** esp-bsp BSP_FEATURE_SD — own-property (XS globalThis cannot see class prototype methods). */
function installSdCardPowerControl(power) {
  power.enableSdCardPower = function () {
    this.axp2101.writeByte(AXP_REG_ALDO4, AXP_ALDO4_3V3)
    this.expander.writeByte(AW9523_REG_P0_MODE, AW9523_P0_PUSH_PULL)
    this.expander.writeByteMask(AW9523_REG_P0, 1 << BSP_SD_EN_BIT, 0xff)
    Timer.delay(150)
    trace('[SD] power enabled: AXP ALDO4=3.3V AW9523 P0 BSP_SD_EN(bit4)=ON\n')
  }
}

class AW9523 {
  #io

  constructor(options) {
    this.#io = new options.sensor.io({
      hz: 400_000,
      address: 0x58,
      ...options.sensor,
    })
  }

  readByte(address) {
    return this.#io.readUint8(address)
  }

  writeByteMask(address, data, mask) {
    const tmp = this.#io.readUint8(address)
    const newData = (tmp & mask) | data
    this.#io.writeUint8(address, newData)
  }
  writeByte(address, data) {
    this.#io.writeUint8(address, data)
  }
}

function nop() {}
