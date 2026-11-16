// @ts-nocheck
import Serial from 'embedded:io/serial'
import config from 'mc/config'
import Timer from 'timer'

import SingleWaitSlot from 'single-wait-slot'
import { PayloadBuffer } from 'payload-buffer'

// type aliases
type TORQUE_OFF = 0
type TORQUE_ON = 1
type TORQUE_BREAK = 2
type TorqueMode = TORQUE_OFF | TORQUE_ON | TORQUE_BREAK

export const TorqueMode: { [key: string]: TorqueMode } = Object.freeze({
  OFF: 0,
  ON: 1,
  BREAK: 2,
})
export const Rotation = Object.freeze({
  CW: 0,
  CCW: 1,
})
export type Rotation = (typeof Rotation)[keyof typeof Rotation]

// constants
const COMMANDS = Object.freeze({
  START: Object.freeze([0xfa, 0xaf]),
  FLASH: Object.freeze([0x40, 0xff, 0x00, 0x00]),
  SET_ANGLE: Object.freeze([0x03, 0x1e, 0x02, 0x01]),
  SET_ANGLE_IN_TIME: Object.freeze([0x03, 0x1e, 0x04, 0x01]),
  SET_MAX_ANGLE: [],
  SET_TORQUE: Object.freeze([0x03, 0x24, 0x01, 0x01]),
  SET_SERVO_ID: Object.freeze([0x03, 0x04, 0x01, 0x01]),
  SET_MAX_TORQUE: Object.freeze([0x03, 0x23, 0x01, 0x01]),
  SET_COMPLIANCE_SLOPE_CW: Object.freeze([0x03, 0x1a, 0x01, 0x01]),
  SET_COMPLIANCE_SLOPE_CCW: Object.freeze([0x03, 0x1b, 0x01, 0x01]),
  SET_DELAY: Object.freeze([0x03, 0x07, 0x01, 0x01]),
  REQUEST_STATUS: Object.freeze([0x09, 0x00, 0x00, 0x01]),
  REBOOT: Object.freeze([0x20, 0xff, 0x00, 0x00]),
  SET_ANGLES: Object.freeze([0x00, 0x1e, 0x03]),
  SET_ANGLES_IN_TIME: Object.freeze([0x00, 0x1e, 0x05]),
} as const)

const PACKET_TYPE = {
  COMMAND: 0xfaaf,
  RESPONSE: 0xfddf,
} as const

// utilities
// biome-ignore lint/correctness/noUnusedVariables: utility function for future use
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}
function be(v: number): [number, number] {
  return [v & 0xff, (v & 0xff00) >> 8]
}
function eb(l: number, h: number) {
  return ((h << 8) & 0xff00) + (l & 0xff)
}
// biome-ignore lint/correctness/noUnusedVariables: utility function for future use
function le(v: number): [number, number] {
  return [(v & 0xff00) >> 8, v & 0xff]
}
function el(h: number, l: number) {
  return ((h << 8) & 0xff00) + (l & 0xff)
}

/**
 * calculates checksum of the SCS packets
 * @param arr packet array except checksum
 * @returns checksum number
 */
// file local methods
function checksum(buffer: Uint8Array, start: number, end: number): number {
  let sum = 0
  for (let i = start; i < end; i++) {
    sum ^= buffer[i]
  }
  return sum
}

const RX_STATE = {
  SEEK: 0,
  HEAD: 1,
  BODY: 2,
} as const
type RxState = (typeof RX_STATE)[keyof typeof RX_STATE]

class PacketHandler extends Serial {
  _callbacks: Map<number, (buffer: Uint8Array, length: number) => void>
  _rxBuffer: Uint8Array
  _payloadBuffer: PayloadBuffer
  _idx: number
  _state: RxState
  _count = 0
  constructor(option) {
    const onReadable = function (this: PacketHandler, bytes: number) {
      const rxBuf = this._rxBuffer
      for (let b = 0; b < bytes; b++) {
        // NOTE: We can safely read a number
        rxBuf[this._idx++] = this.read() as number
        switch (this._state) {
          case RX_STATE.SEEK:
            if (this._idx >= 2) {
              // see header
              const header = el(rxBuf[0], rxBuf[1])
              if (header === PACKET_TYPE.COMMAND || header === PACKET_TYPE.RESPONSE) {
                // packet found
                this._state = RX_STATE.HEAD
              } else {
                // reset seek
                this._idx = 0
              }
            }
            break
          case RX_STATE.HEAD:
            if (this._idx >= 6) {
              this._count = rxBuf[5] + 2
              this._state = RX_STATE.BODY
            }
            break
          case RX_STATE.BODY:
            this._count -= 1
            if (this._count === 0) {
              const cs = checksum(rxBuf, 2, this._idx - 1) & 0xff
              const id = rxBuf[2]
              const header = el(rxBuf[0], rxBuf[1])
              if (header === PACKET_TYPE.COMMAND) {
                // ignore echo
              } else if (cs === rxBuf[this._idx - 1] && this._callbacks.has(id)) {
                const payloadLength = this._idx - 8
                const payloadView = this._payloadBuffer.copyFrom(rxBuf, payloadLength, 7)
                const payload = new Uint8Array(payloadLength)
                payload.set(payloadView.subarray(0, payloadLength))
                this._callbacks.get(id)?.(payload, payloadLength)
              } else {
                trace(`unknown packet for ${id} ... ${rxBuf.subarray(0, this._idx)}. ignoring\n`)
              }
              this._idx = 0
              this._state = RX_STATE.SEEK
            }
            break
          default: {
            // @ts-expect-error 6113
            let _state: never
          }
        }
      }
    }
    super({
      ...option,
      format: 'number',
      onReadable,
    })
    this._callbacks = new Map<number, (buffer: Uint8Array, length: number) => void>()
    this._rxBuffer = new Uint8Array(64)
    this._payloadBuffer = new PayloadBuffer(32)
    this._idx = 0
    this._state = RX_STATE.SEEK
  }
  hasCallbackOf(id: number): boolean {
    return this._callbacks.has(id)
  }
  registerCallback(id: number, callback: (buffer: Uint8Array, length: number) => void) {
    this._callbacks.set(id, callback)
  }
  removeCallback(id: number) {
    this._callbacks.delete(id)
  }
}

type RS30XConstructorParam = {
  id: number
}

let packetHandler: PacketHandler = null
class RS30X {
  _id: number
  _onCommandRead: (buffer: Uint8Array, length: number) => void
  _txBuf: Uint8Array
  _waitSlot: SingleWaitSlot<Uint8Array>
  _queueTail: Promise<void>
  constructor({ id }: RS30XConstructorParam) {
    this._id = id
    this._waitSlot = new SingleWaitSlot<Uint8Array>(Timer.set, Timer.clear)
    this._queueTail = Promise.resolve()
    this._onCommandRead = (values, _length) => {
      this._waitSlot.resolve(values)
    }
    this._txBuf = new Uint8Array(64)
    if (packetHandler == null) {
      packetHandler = new PacketHandler({
        receive: config.serial?.receive ?? 16,
        transmit: config.serial?.transmit ?? 17,
        baud: 115_200,
        port: 2,
      })
    }
    if (packetHandler.hasCallbackOf(id)) {
      throw new Error('This id is already instantiated')
    }
    packetHandler.registerCallback(this._id, this._onCommandRead)
  }
  teardown(): void {
    packetHandler.removeCallback(this._id)
  }

  set id(_: number) {
    throw new Error('cannot set id of single servo. Use "flashId" function')
  }
  get id(): number {
    return this._id
  }

  async _dispatchCommand(...values: number[]): Promise<Uint8Array | undefined> {
    this._txBuf[0] = 0xfa
    this._txBuf[1] = 0xaf
    this._txBuf[2] = this._id
    let idx = 3
    for (const v of values) {
      this._txBuf[idx] = v
      idx++
    }
    this._txBuf[idx] = checksum(this._txBuf, 2, idx)
    idx++
    const originalFormat = packetHandler.format
    packetHandler.format = 'buffer'
    try {
      packetHandler.write(this._txBuf.subarray(0, idx))
    } finally {
      packetHandler.format = originalFormat
    }
    return this._waitSlot.wait(100, () => {
      trace('timeout.\n')
    })
  }

  async _sendCommand(...values: number[]): Promise<Uint8Array | undefined> {
    const run = this._queueTail.then(() => this._dispatchCommand(...values))
    this._queueTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async setMaxTorque(maxTorque: number): Promise<void> {
    await this._sendCommand(...COMMANDS.SET_MAX_TORQUE, maxTorque)
    await this._sendCommand(...COMMANDS.FLASH)
  }
  async flashId(id: number): Promise<void> {
    await this._sendCommand(...COMMANDS.SET_SERVO_ID, id)
    this._id = id
    await this._sendCommand(...COMMANDS.FLASH)
  }

  async setAngle(angle: number): Promise<void> {
    const a = Math.max(-150, Math.min(150, angle)) * 10
    await this._sendCommand(...COMMANDS.SET_ANGLE, ...be(a))
  }

  async setAngleInTime(angle: number, goalTime: number): Promise<void> {
    const a = Math.max(-150, Math.min(150, angle)) * 10
    const g = goalTime * 100
    await this._sendCommand(...COMMANDS.SET_ANGLE_IN_TIME, ...be(a), ...be(g))
  }

  async setComplianceSlope(rotation: Rotation, angle: number): Promise<void> {
    const command = rotation === Rotation.CW ? COMMANDS.SET_COMPLIANCE_SLOPE_CW : COMMANDS.SET_COMPLIANCE_SLOPE_CCW
    await this._sendCommand(...command, angle)
  }

  async reboot(): Promise<void> {
    await this._sendCommand(...COMMANDS.REBOOT)
  }

  async setTorque(enable: boolean): Promise<unknown> {
    const mode = enable ? TorqueMode.ON : TorqueMode.OFF
    return this._sendCommand(...COMMANDS.SET_TORQUE, mode)
  }

  async readStatus(): Promise<number> {
    const values = await this._sendCommand(...COMMANDS.REQUEST_STATUS)
    if (values == null || values.length < 18) {
      throw new Error('response corrupted')
    }
    const angle = eb(values[0], values[1])
    if (angle >= 65535 / 2) {
      return (angle - 65535) / 10
    }
    return angle / 10
  }
}

export default RS30X
