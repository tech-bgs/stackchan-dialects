// @ts-nocheck
import type { Application as PiuApplication, Container as PiuContainer, Content as PiuContent } from 'piu/MC'
import type { DrawerButtonSpec } from 'drawer'
import type { FaceContext } from 'face-context'
import {
  FaceMainTemplate,
  FaceView,
  type FaceViewBehavior,
  type FaceViewParams,
  type FaceViewTemplateCtor,
} from 'face-view'
import {
  dismissPhotoPreviewFromFaceTouch,
  invokeDirectPhotoCapture,
  invokeRegisteredTakePhotoDrawer,
  isPhotoSessionBusy,
  tracePhotoTouchTimeline,
} from 'photo-capture'
import { tracePhotoTakeStep } from 'photo-session-diagnostics'

export type AppControllerParams = FaceViewParams

type DrawerControllerApi = {
  setButtons?: (buttons: DrawerButtonSpec[]) => void
  addButton?: (button: DrawerButtonSpec) => void
  removeButton?: (key: string) => void
  setButtonState?: (key: string, active: boolean) => void
}

const FACE_DOUBLE_TAP_MS = 450

export class AppController extends Behavior {
  #application: PiuApplication | null = null
  #view: PiuContainer | null = null
  #viewBehavior: FaceViewBehavior | null = null
  #drawerController: DrawerControllerApi | null = null
  #pendingDrawerButtons: DrawerButtonSpec[] = []
  #lastFaceTouchAt = 0

  onCreate(application: PiuApplication, data: AppControllerParams) {
    this.#application = application
    const main = data.main ?? new FaceMainTemplate(data, { anchor: 'MAIN' })
    const viewData: FaceViewParams = { ...data, main }
    this.showView(FaceView, viewData)
    this.attachControllers()
  }

  get application(): PiuApplication {
    return this.#application as PiuApplication
  }

  get drawerController(): DrawerControllerApi | null {
    return this.#drawerController
  }

  queuePendingDrawerButton(button: DrawerButtonSpec): void {
    this.#pendingDrawerButtons.push(button)
  }

  showView(ViewTemplate: FaceViewTemplateCtor, data: FaceViewParams) {
    const app = this.#application
    if (!app) return
    const view = new ViewTemplate(data)
    app.empty()
    app.add(view)
    this.#view = view
    this.#viewBehavior = this.resolveViewBehavior()
    this.flushPendingDrawerButtons()
  }

  update(_interval: number, faceContext: Readonly<FaceContext>): void {
    if (!this.#view || !this.#viewBehavior) return
    this.#viewBehavior.onFaceUpdate?.(this.#view, faceContext)
  }

  addEffect(effect: PiuContent, key?: string): void {
    this.#viewBehavior?.addEffect?.(effect, key)
  }

  removeEffect(effect: PiuContent): void {
    this.#viewBehavior?.removeEffect?.(effect)
  }

  removeEffectByKey(key: string): void {
    this.#viewBehavior?.removeEffectByKey?.(key)
  }

  showScreenOverlay(content: PiuContent, key: string): void {
    this.#viewBehavior?.showScreenOverlay?.(content, key)
  }

  removeScreenOverlay(key: string): void {
    this.#viewBehavior?.removeScreenOverlay?.(key)
  }

  restoreScreenInput(): void {
    this.#viewBehavior?.restoreScreenInputAfterOverlay?.()
  }

  obscureMainForPhotoPreview(obscure: boolean): void {
    this.#viewBehavior?.obscureMainForPhotoPreview?.(obscure)
  }

  tracePhotoDisplayHierarchy(phase: string, key?: string): void {
    this.#viewBehavior?.tracePhotoDisplayHierarchy?.(phase, key)
  }

  tracePhotoUiLayers(phase: string, key?: string): void {
    this.#viewBehavior?.tracePhotoUiLayers?.(phase, key)
  }

  tracePhotoOverlayMilestone(phase: string, key?: string): void {
    this.#viewBehavior?.tracePhotoOverlayMilestone?.(phase, key)
  }

  tracePhotoInputState(phase: string, hit?: { target: string; id: number; x: number; y: number }, key?: string): void {
    this.#viewBehavior?.tracePhotoInputState?.(phase, hit, key)
  }

  tracePhotoOverlayHitState(phase: string, key?: string): void {
    this.#viewBehavior?.tracePhotoOverlayHitState?.(phase, key)
  }

  tracePhotoOverlayRuntimeSnapshot(phase: string, key?: string): void {
    this.#viewBehavior?.tracePhotoOverlayRuntimeSnapshot?.(phase, key)
  }

  setFace(face: PiuContainer): void {
    this.#viewBehavior?.setFace?.(face)
  }

  pauseFaceAnimation(): void {
    this.#viewBehavior?.pauseFaceAnimation?.()
  }

  resumeFaceAnimation(): void {
    this.#viewBehavior?.resumeFaceAnimation?.()
  }

  setDrawerButtons(buttons: DrawerButtonSpec[]): void {
    this.#viewBehavior?.setDrawerButtons?.(buttons)
  }

  addDrawerButton(button: DrawerButtonSpec): void {
    const viewBehavior = this.resolveViewBehavior()
    trace(`[AppController] addDrawerButton key=${button.key} viewBehavior=${viewBehavior != null}\n`)
    if (!viewBehavior) {
      this.#pendingDrawerButtons.push(button)
      return
    }
    viewBehavior.addDrawerButton?.(button)
  }

  removeDrawerButton(key: string): void {
    this.#viewBehavior?.removeDrawerButton?.(key)
  }

  setDrawerButtonState(key: string, active: boolean): void {
    this.#viewBehavior?.setDrawerButtonState?.(key, active)
  }

  openDrawer(): void {
    this.#viewBehavior?.openDrawer?.()
  }

  closeDrawer(): void {
    trace('[PhotoPath] AppController.closeDrawer enter\n')
    this.#viewBehavior?.closeDrawer?.()
    trace('[PhotoPath] AppController.closeDrawer return\n')
  }

  toggleDrawer(): void {
    this.#viewBehavior?.toggleDrawer?.()
  }

  onDrawerToggle(): void {
    trace('[AppController] onDrawerToggle\n')
    this.toggleDrawer()
  }

  onDrawerOpen(): void {
    trace('[AppController] onDrawerOpen\n')
    this.openDrawer()
  }

  onDrawerClose(): void {
    const viewBehavior = this.resolveViewBehavior() as { isDrawerOpen?: () => boolean } | null
    if (viewBehavior?.isDrawerOpen && !viewBehavior.isDrawerOpen()) {
      trace('[PhotoUiTrace] onDrawerClose skipped (isDrawerOpen=false)\n')
      return
    }
    trace('[AppController] onDrawerClose\n')
    trace('[PhotoUiTrace] onDrawerClose dispatch\n')
    this.closeDrawer()
  }

  /**
   * PIU bubble('takePhoto') / FaceView relay target.
   * Class methods are non-writable on the prototype; robot.addDrawerButton must
   * defineProperty on this instance (see robot.ts bindHandler). If this stub runs,
   * onRobotCreated did not override takePhoto on the live AppController behavior.
   */
  takePhoto(): void {
    if (invokeRegisteredTakePhotoDrawer()) {
      return
    }
    tracePhotoTakeStep(3, 'AppController.takePhoto STUB (no registerTakePhotoDrawerRunner at boot)')
  }

  onFaceTouch(_container?: PiuContainer, data?: { source?: string; x?: number; y?: number; ticks?: number }): void {
    const via = data?.source ?? 'bubble.onFaceTouch'
    if (isPhotoSessionBusy()) {
      trace(
        `[PhotoUiTrace] AppController.onFaceTouch enter source=${via} x=${data?.x ?? '?'} y=${data?.y ?? '?'} sessionBusy=1\n`,
      )
    }
    if (via.includes('Face.onTouchEnded') && data?.x != null && data?.y != null) {
      tracePhotoTouchTimeline(
        'AppController.onFaceTouch (path=D)',
        `id=${data.id ?? '?'} x=${data.x} y=${data.y} ticks=${data.ticks ?? '?'}`,
      )
      trace(
        `[PhotoDismiss] path=D Face.onTouchEnded id=${data.id ?? '?'} x=${data.x} y=${data.y} ticks=${data.ticks ?? '?'}\n`,
      )
    }
    if (dismissPhotoPreviewFromFaceTouch(via)) {
      return
    }
    if (isPhotoSessionBusy()) {
      return
    }
    const now = Date.now()
    if (this.#lastFaceTouchAt > 0 && now - this.#lastFaceTouchAt <= FACE_DOUBLE_TAP_MS) {
      this.#lastFaceTouchAt = 0
      trace('[AppController] onFaceTouch: double-tap → direct photo\n')
      void invokeDirectPhotoCapture()
      return
    }
    this.#lastFaceTouchAt = now
    this.onDrawerToggle()
  }

  private resolveViewBehavior(): FaceViewBehavior | null {
    if (this.#viewBehavior) return this.#viewBehavior
    const behavior = this.#view?.behavior as FaceViewBehavior | undefined
    if (behavior) {
      this.#viewBehavior = behavior
    }
    return this.#viewBehavior
  }

  private flushPendingDrawerButtons(): void {
    const viewBehavior = this.resolveViewBehavior()
    if (!viewBehavior || this.#pendingDrawerButtons.length === 0) return
    for (const button of this.#pendingDrawerButtons) {
      viewBehavior.addDrawerButton?.(button)
    }
    this.#pendingDrawerButtons.length = 0
  }

  private attachControllers(): void {
    if (!this.#application) return
    this.#drawerController = {
      setButtons: (buttons) => this.setDrawerButtons(buttons),
      addButton: (button) => this.addDrawerButton(button),
      removeButton: (key) => this.removeDrawerButton(key),
      setButtonState: (key, active) => this.setDrawerButtonState(key, active),
    }
    this.flushPendingDrawerButtons()
  }
}
