// @ts-nocheck
import Timer from 'timer'
import { Vector3, type Pose, Rotation, type Maybe, noop, randomBetween, generateDeviceSeed } from 'stackchan-util'
import { type FaceContext, type Emotion, createFaceContext } from 'face-context'
import type { Container as PiuContainer, Content as PiuContent } from 'piu/MC'
import type Digital from 'embedded:io/digital'
import type Touch from 'touch'
import type Microphone from 'microphone'
import type { PushToTalkSampleFormat } from 'microphone'
import type Tone from 'tone'
import type Led from 'led'
import type { RobotCamera } from 'camera'
import { tracePhotoTakeStep } from 'photo-session-diagnostics'

const INTERVAL_FACE = 1000 / 30
const INTERVAL_POSE = 1000 / 10
const HEX_DIGITS = '0123456789abcdef'

function toHexByte(value: number): string {
  const clamped = Math.max(0, Math.min(255, value | 0))
  return `${HEX_DIGITS[(clamped >> 4) & 0x0f]}${HEX_DIGITS[clamped & 0x0f]}`
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`
}

export type Driver = {
  applyRotation: (ori: Rotation, time?: number) => Promise<void>
  getRotation: () => Promise<Maybe<Rotation>>
  setTorque: (torque: boolean) => Promise<void>
  onAttached?: () => void
  onDetached?: () => void
}

export type TTS = {
  stream: (text: string, volume?: number) => Promise<void>
  onPlayed?: (volume: number) => void
  onDone?: () => void
}

export type Renderer = {
  update: (interval: number, faceContext: Readonly<FaceContext>) => void
  addDecorator(decorator: FaceDecorator, key?: string): void
  removeDecorator(decorator: FaceDecorator): void
  showScreenOverlay?: (overlay: FaceDecorator, key: string) => void
  removeScreenOverlay?: (key: string) => void
  restoreScreenInput?: () => void
  application?: unknown
  setFace?: (face: PiuContainer) => void
}

export type DrawerButtonRegistration = {
  key: string
  label: string
  callback: (robot: Robot) => unknown
  onPress?: (robot: Robot) => unknown
  onRelease?: (robot: Robot) => unknown
  kind?: 'action' | 'toggle'
  initialState?: boolean
}

type DrawerButtonRegistry = {
  addDrawerButton: (button: DrawerButtonRegistration) => void
  removeDrawerButton: (key: string) => void
  clearDrawerButtons: () => void
  setDrawerButtonState: (key: string, active: boolean) => void
}

const NULL_CAMERA: RobotCamera = {
  release() {},
  start() {},
  stop() {},
  async capture() {
    return undefined
  },
}

export type Button = {
  onChanged: (this: Digital) => void
}

const buttonNames = ['a', 'b', 'c'] as const
type ButtonName = (typeof buttonNames)[number]

type RobotConstructorParam<T extends string> = {
  driver: Driver
  renderer: Renderer
  tts: TTS
  button: { [key in T]: Button }
  pose?: {
    body: Pose
    eyes: {
      left: Pose
      right: Pose
    }
  }
  touch?: Touch
  microphone?: Microphone
  camera?: RobotCamera
  tone?: Tone
  led?: Record<string, Led>
}

const LEFT_RIGHT = Object.freeze(['left', 'right'])
type FaceDecorator = PiuContent
export class Robot {
  _gazePoint: Vector3
  _pose: {
    body: Pose
    eyes: {
      left: Pose
      right: Pose
    }
  }
  seed: number
  _mouthOpen: number
  _tts: TTS
  _driver: Driver
  _button: { [key in ButtonName]: Button }
  _touch: Touch
  _microphone: Microphone
  _camera: RobotCamera
  _tone: Tone
  _led: Record<string, InstanceType<typeof Led>>
  _isMoving: boolean
  _renderer: Renderer
  _paused: boolean
  _faceContext: FaceContext
  _emotion: Emotion
  _drawerCallbacks: Map<string, (robot: Robot) => unknown>
  _drawerRegistry: DrawerButtonRegistry
  _drawerBehavior: Record<string, unknown> | null
  _chatLoadReduction = false
  _faceUpdateTick = 0
  _rotationPollAt = 0
  _rotationPollInFlight = false
  updating: boolean
  constructor(params: RobotConstructorParam<ButtonName>) {
    this.seed = generateDeviceSeed()
    this.useRenderer(params.renderer)
    this.useDriver(params.driver)
    this.useTTS(params.tts)
    this._isMoving = false
    this._mouthOpen = 0
    this._button = params.button
    this._touch = params.touch
    this._microphone = params.microphone
    this._camera = params.camera ?? NULL_CAMERA
    this._tone = params.tone
    this._led = params.led ?? {}
    this._pose = params.pose ?? {
      body: {
        position: {
          x: 0.0,
          y: 0.0,
          z: 0.0,
        },
        rotation: {
          y: 0.0,
          p: 0.0,
          r: 0.0,
        },
      },
      eyes: {
        left: {
          position: {
            x: 0.03,
            y: 0.009,
            z: 0,
          },
          rotation: {
            r: 0.0,
            p: 0.0,
            y: 0.0,
          },
        },
        right: {
          position: {
            x: 0.03,
            y: -0.009,
            z: 0,
          },
          rotation: {
            r: 0.0,
            p: 0.0,
            y: 0.0,
          },
        },
      },
    }
    this._updatePoseHandler = Timer.repeat(this.updatePose.bind(this), INTERVAL_POSE)
    this._updateFaceHandler = Timer.repeat(this.updateFace.bind(this), INTERVAL_FACE)
    this._paused = false
    this._faceContext = createFaceContext()
    this._emotion = this._faceContext.emotion
    this._drawerCallbacks = new Map()
    this._drawerBehavior = null
    this._drawerRegistry = {
      addDrawerButton: (button) => this.addDrawerButton(button),
      removeDrawerButton: (key) => this.removeDrawerButton(key),
      clearDrawerButtons: () => this.clearDrawerButtons(),
      setDrawerButtonState: (key, active) => this.setDrawerButtonState(key, active),
    }
  }

  useTTS(tts: TTS) {
    if (this._tts != null) {
      this._tts.onDone = noop
      this._tts.onPlayed = noop
    }
    this._tts = tts
    this._tts.onPlayed = (volume: number) => {
      if (volume === 0) {
        this._mouthOpen = 0
      } else {
        this._mouthOpen = Math.min(volume / 2000, 1.0)
      }
    }
    this._tts.onDone = () => {
      this._mouthOpen = 0
    }
  }

  useRenderer(renderer: Renderer) {
    this._renderer = renderer
  }

  useDriver(driver: Driver) {
    if (this._driver != null) {
      this._driver.onDetached?.()
    }
    this._driver = driver
    this._driver.onAttached?.()
  }

  get button() {
    return this._button
  }

  get touch() {
    return this._touch
  }

  get pose() {
    return this._pose
  }

  get microphone() {
    return this._microphone
  }

  get camera() {
    return this._camera
  }

  get led() {
    return this._led
  }

  async say(text: string, volume?: number): Promise<Maybe<string>> {
    return new Promise((resolve, _reject) => {
      this._tts
        .stream(text, volume)
        .catch((reason) => {
          trace('error\n')
          resolve({
            success: false,
            reason,
          })
        })
        .then(() => {
          resolve({
            success: true,
            value: text,
          })
        })
    })
  }

  async record(durationMilliSec?: number): Promise<ArrayBuffer> {
    if (!this._microphone) {
      throw Error('This device does not support a microphone.')
    }
    return this._microphone.record(durationMilliSec)
  }

  beginPushToTalkInto(target: Uint8Array): PushToTalkSampleFormat {
    if (!this._microphone) {
      throw Error('This device does not support a microphone.')
    }
    return this._microphone.beginPushToTalkInto(target)
  }

  endPushToTalkInto() {
    if (!this._microphone) {
      throw Error('This device does not support a microphone.')
    }
    return this._microphone.endPushToTalkInto()
  }

  beginPushToTalk(maxDurationMs: number): void {
    if (!this._microphone) {
      throw Error('This device does not support a microphone.')
    }
    this._microphone.beginPushToTalk(maxDurationMs)
  }

  beginPushToTalkStream(maxDurationMs: number, onChunk: (chunk: ArrayBuffer) => void) {
    if (!this._microphone) {
      throw Error('This device does not support a microphone.')
    }
    return this._microphone.beginPushToTalkStream(maxDurationMs, onChunk)
  }

  endPushToTalkStream(): boolean {
    if (!this._microphone) {
      throw Error('This device does not support a microphone.')
    }
    return this._microphone.endPushToTalkStream()
  }

  endPushToTalk() {
    if (!this._microphone) {
      throw Error('This device does not support a microphone.')
    }
    return this._microphone.endPushToTalk()
  }

  cancelPushToTalk(): void {
    this._microphone?.cancelPushToTalk()
  }

  async tone(hz: number, duration: number, volume?: number): Promise<void> {
    trace(`[ShutterTrace] Robot.tone hz=${hz} duration=${duration} volume=${volume ?? 'default'}\n`)
    if (volume !== undefined && (volume < 0 || volume > 1)) {
      throw new Error('Volume must be between 0 and 1')
    }
    return this._tone?.tone(hz, duration, volume)
  }

  async shutterClick(volume?: number): Promise<void> {
    trace(`[ShutterTrace] Robot.shutterClick volume=${volume ?? 'default'}\n`)
    if (volume !== undefined && (volume < 0 || volume > 1)) {
      throw new Error('Volume must be between 0 and 1')
    }
    const player = this._tone as { shutterClick?: (volume?: number) => Promise<void> } | undefined
    return player?.shutterClick?.(volume)
  }

  async playAudio(buffer: ArrayBuffer): Promise<boolean> {
    const player = this._tone as unknown as { play?: (buffer: ArrayBuffer) => Promise<boolean> | boolean } | undefined
    return (await player?.play?.(buffer)) ?? false
  }

  lookAt(position: Vector3) {
    this._gazePoint = position
  }

  async lookTowards(
    position: Vector3,
    options?: {
      duration?: number
      releaseTorque?: boolean
    },
  ): Promise<void> {
    const duration = options?.duration ?? 0.8
    const releaseTorque = options?.releaseTorque ?? true
    this._gazePoint = position
    this._isMoving = true
    trace(`[Robot] lookTowards [${position[0]}, ${position[1]}, ${position[2]}] duration=${duration}\n`)
    await this._driver.setTorque(true)
    await this._driver.applyRotation(Rotation.fromVector3(position), duration)
    Timer.set(
      async () => {
        this._isMoving = false
        if (releaseTorque) {
          await this._driver.setTorque(false)
        }
      },
      duration * 1000 + 50,
    )
  }

  async lookTowardsRotation(
    rotation: Rotation,
    options?: {
      duration?: number
      releaseTorque?: boolean
    },
  ): Promise<void> {
    return this.lookTowards(Rotation.toVector3(rotation), options)
  }

  showBalloon(text: string) {
    trace(`[balloon] ${text}\n`)
  }

  hideBalloon() {}

  lookAway() {
    this._gazePoint = null
  }

  async setPose(pose: Pose, time?: number): Promise<void> {
    return this._driver.applyRotation(pose.rotation, time)
  }

  async setTorque(torque: boolean): Promise<void> {
    return this._driver.setTorque(torque)
  }

  setColor(key: keyof FaceContext['theme'], r: number, g: number, b: number): void {
    this._faceContext.theme[key] = rgbToHex(r, g, b)
  }

  setEmotion(emotion: Emotion) {
    this._emotion = emotion
  }

  setMouthOpen(value: number) {
    if (value < 0 || value > 1) {
      throw new Error('value must be between 0 and 1')
    }
    this._mouthOpen = value
  }

  get driver(): Driver {
    return this._driver
  }

  get tts(): TTS {
    return this._tts
  }

  get renderer(): Renderer {
    return this._renderer
  }

  get application(): DrawerButtonRegistry {
    return this._drawerRegistry
  }

  private getDrawerController():
    | {
        setButtons?: (buttons: unknown[]) => void
        addButton?: (button: unknown) => void
        removeButton?: (key: string) => void
        setButtonState?: (key: string, active: boolean) => void
      }
    | undefined {
    type DrawerControllerHost = {
      drawerController?: {
        setButtons?: (buttons: unknown[]) => void
        addButton?: (button: unknown) => void
        removeButton?: (key: string) => void
        setButtonState?: (key: string, active: boolean) => void
      }
      queuePendingDrawerButton?: (button: { key: string; label: string; kind?: string }) => void
    }
    const app = this._renderer?.application as
      | { behavior?: DrawerControllerHost; drawerController?: DrawerControllerHost['drawerController'] }
      | undefined
    return app?.behavior?.drawerController ?? app?.drawerController
  }

  private ensureDrawerBehavior(): Record<string, unknown> | null {
    const app = this._renderer?.application as { behavior?: Record<string, unknown> } | undefined
    if (!app) return null
    if (!app.behavior) {
      app.behavior = new (class extends Behavior {})() as unknown as Record<string, unknown>
    }
    this._drawerBehavior = app.behavior
    return this._drawerBehavior
  }

  private addDrawerButton({
    key,
    label,
    callback,
    onPress,
    onRelease,
    kind,
    initialState,
  }: DrawerButtonRegistration): void {
    trace(`[Robot] private addDrawerButton key=${key}\n`)

    this._drawerCallbacks.set(key, callback)
    const behavior = this.ensureDrawerBehavior()
    const bindHandler = (name: string, handler?: (robot: Robot) => unknown) => {
      if (!handler || !behavior) return
      const runCallback = () => {
        if (name === 'takePhoto') {
          trace('[Photo] TAKEPHOTO TEST (robot drawer handler)\n')
          tracePhotoTakeStep(3, 'robot AppController.takePhoto handler (bubble delivered)')
        }
        trace(`[DrawerButton] callback key=${name}\n`)
        try {
          const result = handler(this)
          if (result && typeof (result as { catch?: (handler: (err: unknown) => void) => void }).catch === 'function') {
            ;(result as { catch: (handler: (err: unknown) => void) => void }).catch((err: unknown) => {
              trace(`[DrawerButton] callback rejected key=${name} err=${String(err)}\n`)
            })
          }
        } catch (err) {
          trace(`[DrawerButton] callback error key=${name} err=${String(err)}\n`)
        }
      }
      const proto = Object.getPrototypeOf(behavior)
      const ownDesc = Object.getOwnPropertyDescriptor(behavior, name)
      const protoDesc = Object.getOwnPropertyDescriptor(proto, name)
      const desc = ownDesc ?? protoDesc
      const mustDefine =
        !!desc && (desc.writable === false || (typeof desc.value === 'function' && desc.value !== runCallback))
      if (mustDefine) {
        Object.defineProperty(behavior, name, {
          value: runCallback,
          writable: true,
          configurable: true,
        })
        trace(`[DrawerButton] bound key=${name} via defineProperty (override AppController prototype)\n`)
      } else {
        ;(behavior as Record<string, () => void>)[name] = runCallback
      }
      if (name === 'takePhoto') {
        const bound = (behavior as Record<string, unknown>)[name] === runCallback
        tracePhotoTakeStep(
          3,
          `robot bind takePhoto on app.behavior ok=${bound ? 1 : 0} via=${mustDefine ? 'defineProperty' : 'assign'}`,
        )
      }
    }
    bindHandler(key, callback)
    bindHandler(`${key}Press`, onPress)
    bindHandler(`${key}Release`, onRelease)
    const controller = this.getDrawerController()
    if (controller) {
      controller.addButton?.({ key, label, kind })
    } else {
      const app = this._renderer?.application as
        | { behavior?: { queuePendingDrawerButton?: (button: { key: string; label: string; kind?: string }) => void } }
        | undefined
      app?.behavior?.queuePendingDrawerButton?.({ key, label, kind })
      trace(`[Robot] queued pending button: ${key}\n`)
    }
    if (initialState !== undefined) {
      this.setDrawerButtonState(key, initialState)
    }
  }

  private removeDrawerButton(key: string): void {
    this._drawerCallbacks.delete(key)
    if (this._drawerBehavior) {
      const behavior = this._drawerBehavior as Record<string, unknown>
      delete behavior[key]
      delete behavior[`${key}Press`]
      delete behavior[`${key}Release`]
    }
    const controller = this.getDrawerController()
    controller?.removeButton?.(key)
  }

  private clearDrawerButtons(): void {
    this._drawerCallbacks.clear()
    const controller = this.getDrawerController()
    controller?.setButtons?.([])
  }

  private setDrawerButtonState(key: string, active: boolean): void {
    const controller = this.getDrawerController()
    controller?.setButtonState?.(key, active)
  }

  pause() {
    this._paused = true
  }

  resume() {
    this._paused = false
  }

  setChatLoadReduction(active: boolean) {
    this._chatLoadReduction = active
    if (!active) {
      this._faceUpdateTick = 0
    }
    trace(`[Robot] chatLoadReduction=${active ? 1 : 0}\n`)
  }

  _pollBodyRotation() {
    if (this._rotationPollInFlight) return
    const interval = this._chatLoadReduction ? 800 : 400
    if (Date.now() - this._rotationPollAt < interval) return
    this._rotationPollInFlight = true
    void this._driver.getRotation().then((result) => {
      this._rotationPollInFlight = false
      this._rotationPollAt = Date.now()
      if (result.success) {
        this._pose.body.rotation = result.value
      }
    })
  }

  updateFace() {
    if (this._paused) {
      return
    }
    this._faceContext.mouth.open = this._mouthOpen
    if (this._chatLoadReduction) {
      this._faceUpdateTick += 1
      if (this._faceUpdateTick % 2 !== 0) {
        return
      }
    }

    this._faceContext.emotion = this._emotion
    if (this._gazePoint != null) {
      const relativeGazePoint = Vector3.rotate(this._gazePoint, {
        r: 0.0,
        y: -this._pose.body.rotation.y,
        p: -this._pose.body.rotation.p,
      })
      for (const key of LEFT_RIGHT) {
        const pos = this._pose.eyes[key].position
        const relative = Vector3.sub(relativeGazePoint, [pos.x, pos.y, pos.z])
        const { y, p } = Rotation.fromVector3(relative)
        const eye = this._faceContext.eyes[key]
        eye.gazeX = Math.cos(y)
        eye.gazeY = Math.cos(p)
      }
    }
    this._renderer.update(INTERVAL_FACE, this._faceContext)
  }

  async updatePose(_id) {
    if (this._paused) {
      return
    }
    this._pollBodyRotation()

    if (this._chatLoadReduction || this._isMoving || this._gazePoint == null) {
      return
    }

    const relativeGazePoint = Vector3.rotate(this._gazePoint, {
      r: 0.0,
      y: -this._pose.body.rotation.y,
      p: -this._pose.body.rotation.p,
    })
    const { y, p } = Rotation.fromVector3(relativeGazePoint)
    if (y > Math.PI / 6 || y < -Math.PI / 6 || p > Math.PI / 6 || p < -Math.PI / 6) {
      this._isMoving = true
      const time = randomBetween(0.5, 1.0)
      void this._driver
        .setTorque(true)
        .then(() => this._driver.applyRotation(Rotation.fromVector3(this._gazePoint), time))
      Timer.set(
        async () => {
          await this._driver.setTorque(false)
          this._isMoving = false
        },
        time * 1000 + 50,
      )
    }
  }

  lightOn(ledName: string, r: number, g: number, b: number, duration?: number, index?: number, count?: number) {
    const led = this._led[ledName]
    if (led) {
      led.on(r, g, b, duration, index, count)
    }
  }

  lightOff(ledName: string, index?: number, count?: number) {
    const led = this._led[ledName]
    if (led) {
      led.off(index, count)
    }
  }

  lightBlink(ledName: string, r: number, g: number, b: number, duration: number, index?: number, count?: number) {
    const led = this._led[ledName]
    if (led) {
      led.blink(r, g, b, duration, index, count)
    }
  }

  lightRainbow(ledName: string, index?: number, count?: number) {
    const led = this._led[ledName]
    if (led) {
      led.rainbow(index, count)
    }
  }
}
