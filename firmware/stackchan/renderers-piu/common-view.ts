// @ts-nocheck
import { Drawer, type DrawerBehavior, type DrawerButtonSpec } from 'drawer'
import {
  isPhotoPreviewAwaitingFaceDismiss,
  isPhotoPreviewSessionActive,
  isPhotoSessionBusy,
  PHOTO_CAPTURE_BACKDROP_KEY,
  PHOTO_RESULT_OVERLAY_KEY,
  shouldIgnorePhotoPreviewTouch,
  tracePhotoTouchTimeline,
} from 'photo-capture'
import { tracePhotoTakeStep } from 'photo-session-diagnostics'
import { notePhotoRepaint } from 'photo-graphics-diagnostics'
import { tracePhotoPostFlush } from 'photo-display-diagnostics'
import { noteLcdUnexpectedFaceUpdate } from 'photo-lcd-overwrite'
import Timer from 'timer'
import type {
  Container as PiuContainer,
  ContainerDictionary as PiuContainerDictionary,
  Content as PiuContent,
} from 'piu/MC'

export type TemplateFunction<TData, TResult> = {
  new (data?: TData, dictionary?: PiuContainerDictionary): TResult
  template?<TNextData>(factory: (arg: TNextData) => PiuContainerDictionary): TemplateFunction<TNextData, TResult>
}

type CommonViewAnchors = {
  MAIN?: PiuContainer
  APP_BAR?: PiuContent
  OVERLAY?: PiuContainer
}

export type CommonViewParams = CommonViewAnchors & {
  main?: PiuContainer
  appBar?: PiuContent
  drawerButtons?: DrawerButtonSpec[]
}

export type CommonViewTemplateCtor = TemplateFunction<CommonViewParams, PiuContainer>

export class CommonViewBehavior extends Behavior {
  container: PiuContainer | null = null
  main: PiuContainer | null = null
  appBar: PiuContent | null = null
  overlay: PiuContainer | null = null
  drawer: PiuContainer | null = null
  drawerOpen = false
  drawerButtons: DrawerButtonSpec[] = []
  drawerStates = new Map<string, boolean>()
  screenOverlayByKey = new Map<string, PiuContent>()
  screenOverlayActive = false
  #photoPreviewHidMain = false
  #drawerCloseTimer: ReturnType<typeof Timer.set> | undefined

  onCreate(container: PiuContainer, data: CommonViewParams) {
    this.container = container
    const missing: string[] = []
    if (!data.MAIN) missing.push('MAIN')
    if (!data.APP_BAR) missing.push('APP_BAR')
    if (!data.OVERLAY) missing.push('OVERLAY')
    if (missing.length > 0) {
      throw new Error(`[CommonView] missing anchors: ${missing.join(', ')}`)
    }
    this.main = data.MAIN as PiuContainer
    this.appBar = data.APP_BAR as PiuContent
    this.overlay = data.OVERLAY as PiuContainer
    this.drawerButtons = data.drawerButtons ?? []
    this.drawer = new Drawer({ buttons: this.drawerButtons })
    if (this.drawer && this.container) this.container.add(this.drawer)
    this.applyOverlayInputState(false, false)
  }

  tracePhotoDisplayHierarchy(phase: string, key?: string): void {
    type LayerProbe = PiuContainer & { visible?: boolean; active?: boolean; name?: string }
    const main = this.main as LayerProbe | null
    const overlayHost = this.overlay as LayerProbe | null
    const drawer = this.drawer as LayerProbe | null
    const content = key ? this.screenOverlayByKey.get(key) : undefined
    const contentProbe = content as
      | (PiuContent & { visible?: boolean; active?: boolean; container?: PiuContainer })
      | undefined
    trace(
      `[CommonView] display ${phase}: main vis=${main?.visible !== false} overlayHost active=${overlayHost?.active === true} drawer vis=${drawer?.visible !== false} overlays=${this.screenOverlayByKey.size} photoShell mounted=${!!contentProbe?.container} photoShell vis=${contentProbe?.visible !== false}\n`,
    )
  }

  private describeSiblingChain(first: PiuContent | null | undefined, max = 10): string {
    const parts: string[] = []
    let node = first ?? null
    let i = 0
    while (node && i < max) {
      const n = node as PiuContent & {
        name?: string
        visible?: boolean
        active?: boolean
        container?: PiuContainer
        next?: PiuContent
      }
      parts.push(
        `${n.name ?? '?'}(v=${n.visible !== false ? 1 : 0},a=${n.active !== false ? 1 : 0},m=${n.container ? 1 : 0})`,
      )
      node = n.next ?? null
      i += 1
    }
    return parts.length > 0 ? parts.join('>') : '(empty)'
  }

  private drawerBehaviorState(): { isOpen: boolean | null; offset: number | null } {
    const behavior = this.drawer?.behavior as { isOpen?: boolean; offset?: number } | undefined
    return {
      isOpen: behavior?.isOpen ?? null,
      offset: behavior?.offset ?? null,
    }
  }

  photoOverlayLayerSnapshot(photoOverlayKey?: string): {
    photoMounted: number
    overlayHostAct: number
    hidMain: number
  } {
    const overlayHost = this.overlay as (PiuContainer & { active?: boolean }) | null
    const photoShell = photoOverlayKey ? this.screenOverlayByKey.get(photoOverlayKey) : undefined
    const photoProbe = photoShell as (PiuContent & { container?: PiuContainer }) | undefined
    return {
      photoMounted: photoProbe?.container ? 1 : 0,
      overlayHostAct: overlayHost?.active === true ? 1 : 0,
      hidMain: this.#photoPreviewHidMain ? 1 : 0,
    }
  }

  /** Grep: PhotoUiTrace — photoMounted / overlayHostAct / hidMain at capture-dismiss milestones. */
  tracePhotoOverlayMilestone(phase: string, photoOverlayKey?: string): void {
    const snap = this.photoOverlayLayerSnapshot(photoOverlayKey)
    trace(
      `[PhotoUiTrace] ${phase} photoMounted=${snap.photoMounted} overlayHostAct=${snap.overlayHostAct} hidMain=${snap.hidMain}\n`,
    )
  }

  private inputNodeLabel(node: PiuContent | null | undefined, fallback: string): string {
    if (!node) return `${fallback}=(null)`
    const n = node as PiuContent & {
      visible?: boolean
      active?: boolean
      backgroundTouch?: boolean
      state?: number
      name?: string
      container?: PiuContainer
    }
    return `${fallback}(name=${n.name ?? '?'} vis=${n.visible !== false ? 1 : 0} act=${n.active !== false ? 1 : 0} bg=${n.backgroundTouch === true ? 1 : 0} st=${n.state ?? '?'} mnt=${n.container ? 1 : 0})`
  }

  /** Grep: PhotoUiTrace overlayRuntime — overlay/main/photoCaptureResult runtime act+vis at capture-success-after-show. */
  tracePhotoOverlayRuntimeSnapshot(phase: string, photoOverlayKey: string = PHOTO_RESULT_OVERLAY_KEY): void {
    const overlayHost = this.overlay as (PiuContent & { active?: boolean; backgroundTouch?: boolean }) | null
    const main = this.main as (PiuContent & { active?: boolean; visible?: boolean }) | null
    const photoShell = this.screenOverlayByKey.get(photoOverlayKey)
    const photo = photoShell as (PiuContent & { active?: boolean; visible?: boolean }) | undefined
    const photoAct = photoShell ? (photo?.active !== false ? 1 : 0) : '?'
    const photoVis = photoShell ? (photo?.visible !== false ? 1 : 0) : '?'
    trace(
      `[PhotoUiTrace] overlayRuntime ${phase} overlay.active=${overlayHost?.active === true ? 1 : 0} overlay.backgroundTouch=${overlayHost?.backgroundTouch === true ? 1 : 0} main.active=${main?.active !== false ? 1 : 0} main.visible=${main?.visible !== false ? 1 : 0} photoCaptureResult.active=${photoAct} photoCaptureResult.visible=${photoVis}\n`,
    )
  }

  /** Grep: PhotoUiTrace overlayHitState — active/visible/state/hitEligible at showCapturedPhoto.after-showScreenOverlay. */
  tracePhotoOverlayHitState(phase: string, photoOverlayKey: string = PHOTO_RESULT_OVERLAY_KEY): void {
    const blockTouches = this.drawerOpen || this.screenOverlayActive || isPhotoPreviewAwaitingFaceDismiss()
    const overlayHost = this.overlay as PiuContent | null
    const photoShell = this.screenOverlayByKey.get(photoOverlayKey)
    const previewPort = (photoShell as PiuContainer & { first?: PiuContent })?.first
    const logNode = (label: string, node: PiuContent | null | undefined) => {
      const n = node as PiuContent & {
        visible?: boolean
        active?: boolean
        backgroundTouch?: boolean
        state?: number
        name?: string
        container?: PiuContainer
      }
      const act = n?.active !== false ? 1 : 0
      const vis = n?.visible !== false ? 1 : 0
      const mnt = n?.container ? 1 : 0
      const parent = n?.container as (PiuContainer & { active?: boolean; visible?: boolean; name?: string }) | undefined
      const parentAct = parent?.active !== false ? 1 : 0
      const parentVis = parent?.visible !== false ? 1 : 0
      const hitEligible = act && vis && mnt && parentAct ? 1 : 0
      trace(
        `[PhotoUiTrace] overlayHitState ${phase} ${label} name=${n?.name ?? '?'} act=${act} vis=${vis} st=${n?.state ?? '?'} bg=${n?.backgroundTouch === true ? 1 : 0} mnt=${mnt} parent=${parent?.name ?? '?'} parentAct=${parentAct} parentVis=${parentVis} hitEligible=${hitEligible}\n`,
      )
    }
    trace(
      `[PhotoUiTrace] overlayHitState ${phase} hostInput blockTouches=${blockTouches ? 1 : 0} screenOverlayActive=${this.screenOverlayActive ? 1 : 0} drawerOpen=${this.drawerOpen ? 1 : 0} overlayContents=${this.describeSiblingChain(overlayHost?.first)}\n`,
    )
    logNode('overlayHost', overlayHost)
    logNode('photoCaptureResult', photoShell)
    logNode('previewPort', previewPort)
  }

  /** Grep: PhotoUiTrace inputState — hit-test chain: main / overlayHost / photoShell / previewPort / drawer. */
  tracePhotoInputState(
    phase: string,
    hit?: { target: string; id: number; x: number; y: number },
    photoOverlayKey: string = PHOTO_RESULT_OVERLAY_KEY,
  ): void {
    const drawerState = this.drawerBehaviorState()
    const blockTouches = this.drawerOpen || this.screenOverlayActive || isPhotoPreviewAwaitingFaceDismiss()
    const hitPart = hit ? ` hitTarget=${hit.target} id=${hit.id} x=${hit.x} y=${hit.y}` : ''
    trace(
      `[PhotoUiTrace] inputState ${phase}${hitPart} drawerOpen=${this.drawerOpen ? 1 : 0} screenOverlayActive=${this.screenOverlayActive ? 1 : 0} blockTouches=${blockTouches ? 1 : 0} awaitFaceDismiss=${isPhotoPreviewAwaitingFaceDismiss() ? 1 : 0} sessionActive=${isPhotoPreviewSessionActive() ? 1 : 0} hidMain=${this.#photoPreviewHidMain ? 1 : 0}\n`,
    )
    const main = this.main as PiuContent | null
    const overlayHost = this.overlay as PiuContent | null
    const drawer = this.drawer as PiuContent | null
    const photoShell = this.screenOverlayByKey.get(photoOverlayKey)
    const previewPort = (photoShell as PiuContainer & { first?: PiuContent })?.first
    trace(`[PhotoUiTrace] inputState ${phase} ${this.inputNodeLabel(main, 'main')}\n`)
    trace(`[PhotoUiTrace] inputState ${phase} ${this.inputNodeLabel(overlayHost, 'overlayHost')}\n`)
    trace(`[PhotoUiTrace] inputState ${phase} ${this.inputNodeLabel(photoShell, 'photoShell')}\n`)
    trace(`[PhotoUiTrace] inputState ${phase} ${this.inputNodeLabel(previewPort, 'previewPort')}\n`)
    trace(
      `[PhotoUiTrace] inputState ${phase} ${this.inputNodeLabel(drawer, 'drawer')} behaviorOpen=${drawerState.isOpen === true ? 1 : drawerState.isOpen === false ? 0 : '?'} offset=${drawerState.offset ?? '?'}\n`,
    )
    const container = this.container as (PiuContainer & { first?: PiuContent }) | null
    const application = container?.container as (PiuContainer & { first?: PiuContent }) | null
    trace(
      `[PhotoUiTrace] inputState ${phase} viewChain=${this.describeSiblingChain(container?.first)} overlayContents=${this.describeSiblingChain(overlayHost?.first)}\n`,
    )
    trace(
      `[PhotoUiTrace] inputState ${phase} application.first=${(application?.first as { name?: string } | null)?.name ?? '(null)'} appChain=${this.describeSiblingChain(application?.first)}\n`,
    )
  }

  /** Grep: PhotoUiTrace — drawer/overlay/main z-order and mount state at photo UI transitions. */
  tracePhotoUiLayers(phase: string, photoOverlayKey?: string): void {
    type LayerProbe = PiuContainer & {
      visible?: boolean
      active?: boolean
      name?: string
      first?: PiuContent
      container?: PiuContainer
    }
    const container = this.container as LayerProbe | null
    const drawer = this.drawer as LayerProbe | null
    const drawerState = this.drawerBehaviorState()
    const main = this.main as LayerProbe | null
    const overlayHost = this.overlay as LayerProbe | null
    const photoShell = photoOverlayKey ? this.screenOverlayByKey.get(photoOverlayKey) : undefined
    const photoProbe = photoShell as (PiuContent & { visible?: boolean; container?: PiuContainer }) | undefined
    const photoMounted = !!photoProbe?.container
    const application = container?.container as LayerProbe | null
    trace(
      `[PhotoUiTrace] ${phase} drawerOpen=${this.drawerOpen ? 1 : 0} drawerBehaviorOpen=${drawerState.isOpen === true ? 1 : drawerState.isOpen === false ? 0 : '?'} drawerOffset=${drawerState.offset ?? '?'} drawerMounted=${drawer?.container ? 1 : 0} drawerVis=${drawer?.visible !== false ? 1 : 0} mainVis=${main?.visible !== false ? 1 : 0} hidMain=${this.#photoPreviewHidMain ? 1 : 0} overlayHostAct=${overlayHost?.active === true ? 1 : 0} overlayKeys=${[...this.screenOverlayByKey.keys()].join(',') || '(none)'} photoMounted=${photoMounted ? 1 : 0} photoVis=${photoProbe?.visible !== false ? 1 : 0} drawerAliveWithPhoto=${photoMounted && (this.drawerOpen || drawerState.isOpen === true) ? 1 : 0}\n`,
    )
    trace(
      `[PhotoUiTrace] ${phase} viewChain=${this.describeSiblingChain(container?.first)} overlayContents=${this.describeSiblingChain(overlayHost?.first)}\n`,
    )
    if (application) {
      trace(
        `[PhotoUiTrace] ${phase} application.first=${(application.first as { name?: string } | null)?.name ?? '(null)'} application.contents=${this.describeSiblingChain(application.first)}\n`,
      )
    }
  }

  private prepareOverlayHostForScreenOverlay(): void {
    const host = this.overlay as (PiuContainer & { active?: boolean; visible?: boolean }) | null
    const container = this.container
    if (!host || !container) return
    host.visible = true
    host.active = true
    if (this.drawer) {
      container.remove(host)
      container.insert(host, this.drawer)
    }
  }

  showScreenOverlay(content: PiuContent, key: string): void {
    trace('[SHOWSCREENOVERLAY_ENTER]\n')
    const host = this.overlay ?? this.container
    if (!host) {
      trace('[SHOWSCREENOVERLAY_NOHOST]\n')
      trace('[CommonView] showScreenOverlay: no overlay host\n')
      return
    }
    trace(
      '[OVERLAY_HOST_STATE] active=' +
        host.active +
        ' visible=' +
        host.visible +
        ' bgTouch=' +
        host.backgroundTouch +
        '\n',
    )
    if (key === PHOTO_RESULT_OVERLAY_KEY || key === PHOTO_CAPTURE_BACKDROP_KEY) {
      this.setPhotoPreviewMainVisible(false)
      this.prepareOverlayHostForScreenOverlay()
    }
    const overlay = content as PiuContent & {
      active?: boolean
      visible?: boolean
      container?: PiuContainer
    }
    const existing = this.screenOverlayByKey.get(key)
    if (existing === content && overlay.container === host) {
      trace('[SHOWSCREENOVERLAY_REUSE]\n')
      overlay.active = true
      overlay.visible = true
      host.remove(content)
      host.add(content)
      this.screenOverlayActive = true
      this.applyOverlayInputState(this.drawerOpen, true)
      if (isPhotoPreviewSessionActive()) notePhotoRepaint('showScreenOverlay.reuse.container')
      content.invalidate?.()
      host.invalidate?.()
      if (isPhotoPreviewSessionActive()) notePhotoRepaint('showScreenOverlay.reuse.host')
      this.container?.invalidate?.()
      if (isPhotoPreviewSessionActive()) notePhotoRepaint('showScreenOverlay.reuse.container-root')
      this.tracePhotoDisplayHierarchy(`reuse key=${key}`, key)
      this.tracePhotoUiLayers(`showScreenOverlay reuse key=${key}`, key)
      trace(`[CommonView] showScreenOverlay key=${key} reuse (front + invalidate)\n`)
      if (key === PHOTO_RESULT_OVERLAY_KEY || key === PHOTO_CAPTURE_BACKDROP_KEY) {
        this.tracePhotoInputState(`showScreenOverlay.reuse key=${key}`)
      }
      return
    }
    this.removeScreenOverlay(key)
    trace('[SHOWSCREENOVERLAY_ADD]\n')
    overlay.active = true
    overlay.visible = true
    host.add(content)
    host.remove(content)
    host.add(content)
    this.screenOverlayByKey.set(key, content)
    this.screenOverlayActive = true
    this.applyOverlayInputState(this.drawerOpen, true)
    this.tracePhotoDisplayHierarchy(`add key=${key}`, key)
    this.tracePhotoUiLayers(`showScreenOverlay add key=${key}`, key)
    trace(
      `[CommonView] showScreenOverlay key=${key} parent=OVERLAY (shell re-added front) drawerOpen=${this.drawerOpen}\n`,
    )
    if (isPhotoPreviewSessionActive()) notePhotoRepaint('showScreenOverlay.add.content')
    content.invalidate?.()
    host.invalidate?.()
    if (isPhotoPreviewSessionActive()) notePhotoRepaint('showScreenOverlay.add.host')
    this.container?.invalidate?.()
    if (isPhotoPreviewSessionActive()) notePhotoRepaint('showScreenOverlay.add.container-root')
    if (key === PHOTO_RESULT_OVERLAY_KEY || key === PHOTO_CAPTURE_BACKDROP_KEY) {
      this.tracePhotoInputState(`showScreenOverlay.add key=${key}`)
    }
  }

  obscureMainForPhotoPreview(obscure: boolean): void {
    this.setPhotoPreviewMainVisible(!obscure)
  }

  private setPhotoPreviewMainVisible(visible: boolean): void {
    const main = this.main as (PiuContainer & { visible?: boolean }) | null
    if (!main) return
    if (visible) {
      if (!this.#photoPreviewHidMain) return
      main.visible = true
      this.#photoPreviewHidMain = false
      trace(`[PhotoWinTrace] main.shown hidMain=0 (face layer restored — small center photo if overlay still up)\n`)
      if (isPhotoPreviewSessionActive()) {
        notePhotoRepaint('main.visible=true')
        noteLcdUnexpectedFaceUpdate('main.visible=true during preview')
        tracePhotoPostFlush('WARN.main-shown-during-preview')
      }
      main.invalidate?.()
      trace('[CommonView] photo preview: main visible\n')
      return
    }
    if (this.#photoPreviewHidMain) return
    main.visible = false
    this.#photoPreviewHidMain = true
    trace('[CommonView] photo preview: main hidden (no main.invalidate — avoid repaint over overlay)\n')
    trace(`[PhotoWinTrace] main.hidden hidMain=1 (face layer off for fullscreen preview)\n`)
  }

  removeScreenOverlay(key: string): void {
    const content = this.screenOverlayByKey.get(key)
    trace(
      `[PhotoUiTrace] removeScreenOverlay enter key=${key} hadContent=${content ? 1 : 0} drawerOpen=${this.drawerOpen ? 1 : 0} overlayCount=${this.screenOverlayByKey.size}\n`,
    )
    if (!content) {
      trace(`[PhotoUiTrace] removeScreenOverlay skip key=${key} (not mounted)\n`)
      return
    }
    this.screenOverlayByKey.delete(key)
    const parent = (content as PiuContent & { container?: PiuContainer }).container
    parent?.remove(content)
    if (key !== PHOTO_RESULT_OVERLAY_KEY && key !== PHOTO_CAPTURE_BACKDROP_KEY) {
      content.stop?.()
    }
    if (key === PHOTO_RESULT_OVERLAY_KEY) {
      this.setPhotoPreviewMainVisible(true)
    }
    if (this.screenOverlayByKey.size === 0) {
      this.screenOverlayActive = false
      this.applyOverlayInputState(this.drawerOpen, false)
    }
    trace(`[CommonView] removeScreenOverlay key=${key}\n`)
    this.tracePhotoUiLayers(`removeScreenOverlay key=${key}`, key)
    if (isPhotoPreviewSessionActive()) {
      notePhotoRepaint(`removeScreenOverlay.${key}`)
      if (key === PHOTO_RESULT_OVERLAY_KEY) {
        tracePhotoPostFlush('overlay-removed-invalidate-root')
      }
    }
    this.container?.invalidate?.()
  }

  restoreScreenInputAfterOverlay(): void {
    if (isPhotoPreviewAwaitingFaceDismiss()) {
      this.screenOverlayActive = true
      this.applyOverlayInputState(this.drawerOpen, true)
      return
    }
    this.screenOverlayActive = this.screenOverlayByKey.size > 0
    this.applyOverlayInputState(this.drawerOpen, this.screenOverlayActive)
  }

  isDrawerOpen(): boolean {
    return this.drawerOpen
  }

  onTouchBegan(container: PiuContainer, id: number, x: number, y: number, _ticks: number) {
    if (!isPhotoPreviewSessionActive()) return
    this.tracePhotoInputState('commonView.onTouchBegan', { target: 'CommonView.root', id, x, y })
    trace(
      `[PhotoUiTrace] commonView.onTouchBegan id=${id} x=${x} y=${y} rootAct=${container.active !== false ? 1 : 0} rootVis=${container.visible !== false ? 1 : 0}\n`,
    )
  }

  onTouchEnded(container: PiuContainer, id: number, x: number, y: number, ticks: number) {
    if (!isPhotoPreviewSessionActive()) return
    this.tracePhotoInputState('commonView.onTouchEnded', { target: 'CommonView.root', id, x, y })
    trace(
      `[PhotoUiTrace] commonView.onTouchEnded id=${id} x=${x} y=${y} ticks=${ticks} rootAct=${container.active !== false ? 1 : 0}\n`,
    )
  }

  private clearDrawerCloseTimer(): void {
    if (this.#drawerCloseTimer !== undefined) {
      Timer.clear(this.#drawerCloseTimer)
      this.#drawerCloseTimer = undefined
    }
  }

  /** Timeline drawer animation allocates PIU/chunk — snap only on embedded heap. */
  private applyDrawerOpenState(drawer: PiuContainer, behavior: DrawerBehavior, open: boolean, reason: string): void {
    if (behavior.setOpenWithoutAnimation) {
      trace(`[CommonView] drawer ${open ? 'open' : 'close'} snap (${reason})\n`)
      behavior.setOpenWithoutAnimation(drawer, open)
      return
    }
    trace(`[CommonView] drawer ${open ? 'open' : 'close'} animated (${reason})\n`)
    behavior.setOpen(drawer, open)
  }

  /** Keep drawer above overlay host so Camera button receives touches. */
  private raiseDrawerToFront(reason: string): void {
    const container = this.container
    const drawer = this.drawer
    if (!container || !drawer) return
    container.remove(drawer)
    container.add(drawer)
    trace(`[CommonView] drawer raised front (${reason})\n`)
  }

  openDrawer(): void {
    if (isPhotoSessionBusy()) {
      trace('[CommonView] openDrawer: blocked (photo session)\n')
      return
    }
    if (!this.drawer || this.drawerOpen) return
    const behavior = this.drawer.behavior as DrawerBehavior | undefined
    if (!behavior?.setOpenWithoutAnimation && !behavior?.setOpen) return
    this.clearDrawerCloseTimer()
    trace('[CommonView] openDrawer\n')
    this.drawerOpen = true
    this.applyOverlayInputState(true, this.screenOverlayActive)
    this.applyDrawerOpenState(this.drawer, behavior, true, 'openDrawer')
    this.raiseDrawerToFront('openDrawer')
    const overlay = this.overlay as { active?: boolean; backgroundTouch?: boolean } | null
    trace(
      `[CommonView] openDrawer input: overlay active=${overlay?.active === true} bgTouch=${overlay?.backgroundTouch === true} drawer active=${(this.drawer as { active?: boolean }).active !== false}\n`,
    )
  }

  closeDrawer(): void {
    const drawerState = this.drawerBehaviorState()
    trace(
      `[PhotoUiTrace] closeDrawer enter drawerOpen=${this.drawerOpen ? 1 : 0} behaviorOpen=${drawerState.isOpen === true ? 1 : drawerState.isOpen === false ? 0 : '?'} offset=${drawerState.offset ?? '?'}\n`,
    )
    if (!this.drawer || !this.drawerOpen) {
      trace(
        `[PhotoUiTrace] closeDrawer skip drawerMissing=${this.drawer ? 0 : 1} drawerOpen=${this.drawerOpen ? 1 : 0} behaviorOpen=${drawerState.isOpen === true ? 1 : drawerState.isOpen === false ? 0 : '?'}\n`,
      )
      return
    }
    trace('[CommonView] closeDrawer\n')
    this.clearDrawerCloseTimer()
    this.drawerOpen = false
    this.applyOverlayInputState(false, this.screenOverlayActive)
    const behavior = this.drawer.behavior as DrawerBehavior | undefined
    if (!behavior?.setOpenWithoutAnimation) return
    // Always snap-hide (no Timeline). Skipping PIU left drawer visible → repeated takePhoto taps OOM.
    this.applyDrawerOpenState(this.drawer, behavior, false, 'closeDrawer snap')
    this.tracePhotoUiLayers('closeDrawer.done')
  }

  toggleDrawer(): void {
    if (this.drawerOpen) this.closeDrawer()
    else this.openDrawer()
  }

  setDrawerButtons(buttons: DrawerButtonSpec[]): void {
    this.drawerButtons = [...buttons]
    this.replaceDrawer()
  }

  addDrawerButton(button: DrawerButtonSpec): void {
    const index = this.drawerButtons.findIndex((item) => item.key === button.key)
    if (index >= 0) this.drawerButtons[index] = button
    else this.drawerButtons.push(button)
    this.replaceDrawer()
  }

  removeDrawerButton(key: string): void {
    const next = this.drawerButtons.filter((item) => item.key !== key)
    if (next.length === this.drawerButtons.length) return
    this.drawerButtons = next
    this.replaceDrawer()
  }

  setDrawerButtonState(key: string, active: boolean): void {
    this.drawerStates.set(key, active)
    const drawer = this.drawer
    const behavior = drawer?.behavior as DrawerBehavior | undefined
    const updated = behavior?.setButtonState?.(drawer as PiuContainer, key, active)
    const index = this.drawerButtons.findIndex((item) => item.key === key)
    if (index >= 0) this.drawerButtons[index] = { ...this.drawerButtons[index], active }
    if (!updated) this.replaceDrawer()
  }

  private replaceDrawer(): void {
    const container = this.container
    if (!container) return
    const wasOpen = this.drawerOpen
    if (this.drawer) container.remove(this.drawer)
    this.drawer = new Drawer({ buttons: this.drawerButtons })
    if (this.drawer) {
      container.add(this.drawer)
      for (const [key, active] of this.drawerStates.entries()) {
        const behavior = this.drawer.behavior as DrawerBehavior | undefined
        behavior?.setButtonState?.(this.drawer, key, active)
      }
      const behavior = this.drawer.behavior as DrawerBehavior | undefined
      if (behavior?.setOpen && wasOpen) {
        this.drawerOpen = true
        this.applyDrawerOpenState(this.drawer, behavior, true, 'replaceDrawer')
        this.applyOverlayInputState(true, this.screenOverlayActive)
        this.raiseDrawerToFront('replaceDrawer')
      } else {
        this.drawerOpen = false
        this.applyOverlayInputState(false, this.screenOverlayActive)
      }
    }
  }

  private applyOverlayInputState(drawerOpen: boolean, screenOverlayVisible: boolean) {
    trace(`[PhotoUiTrace] applyOverlayInputState overlayExists=${this.overlay ? 1 : 0}\n`)
    if (!this.overlay) {
      trace('[PhotoUiTrace] applyOverlayInputState EARLY_RETURN no overlay\n')
      return
    }
    type OverlayContainer = PiuContainer & { active?: boolean; visible?: boolean; backgroundTouch?: boolean }
    const overlay = this.overlay as OverlayContainer
    const blockTouches = drawerOpen || screenOverlayVisible || isPhotoPreviewAwaitingFaceDismiss()
    const prevAct = overlay.active === true
    const prevBg = overlay.backgroundTouch === true
    const photoTrace = isPhotoPreviewSessionActive() || this.screenOverlayByKey.has(PHOTO_RESULT_OVERLAY_KEY)
    if (photoTrace) {
      trace(
        `[PhotoUiTrace] applyOverlayInputState enter drawerOpen=${drawerOpen ? 1 : 0} screenOverlayVisible=${screenOverlayVisible ? 1 : 0} blockTouches=${blockTouches ? 1 : 0} overlay.active=${prevAct ? 1 : 0} overlay.backgroundTouch=${prevBg ? 1 : 0}\n`,
      )
    }
    if (overlay.active === blockTouches && overlay.backgroundTouch === blockTouches) {
      if (photoTrace) {
        trace(
          `[PhotoUiTrace] applyOverlayInputState noop overlay.active=${prevAct ? 1 : 0} overlay.backgroundTouch=${prevBg ? 1 : 0} (unchanged)\n`,
        )
      }
      return
    }
    overlay.active = blockTouches
    overlay.visible = true
    overlay.backgroundTouch = blockTouches
    trace(
      `[PhotoUiTrace] applyOverlayInputState overlay.active ${prevAct ? 1 : 0}->${blockTouches ? 1 : 0} overlay.backgroundTouch ${prevBg ? 1 : 0}->${blockTouches ? 1 : 0} drawerOpen=${drawerOpen ? 1 : 0} screenOverlayVisible=${screenOverlayVisible ? 1 : 0} blockTouches=${blockTouches ? 1 : 0}\n`,
    )
    if (photoTrace) {
      this.tracePhotoInputState('applyOverlayInputState.after')
    }
  }
}

export const CommonView: CommonViewTemplateCtor = Container.template(($: CommonViewParams) => {
  const main = $.MAIN ?? $.main
  if (!main) {
    trace('[CommonView] ERROR: Missing main view instance\n')
    return { top: 0, right: 0, bottom: 0, left: 0 }
  }
  if (!$.MAIN) {
    $.MAIN = main
  }
  const appBar =
    $.APP_BAR ??
    $.appBar ??
    new Content($, {
      anchor: 'APP_BAR',
      left: 0,
      right: 0,
      top: 0,
      height: 0,
    })
  if (!$.APP_BAR) {
    $.APP_BAR = appBar as PiuContent
  }
  const overlay = new Container($, {
    anchor: 'OVERLAY',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    active: false,
    clip: false,
    backgroundTouch: false,
    Behavior: class extends Behavior {
      onTouchBegan(container: PiuContainer, id: number, x: number, y: number, ticks: number) {
        const view = container.container
        const viewBehavior = view?.behavior as CommonViewBehavior | undefined
        if (isPhotoPreviewSessionActive()) {
          viewBehavior?.tracePhotoInputState?.('overlayHost.onTouchBegan', { target: 'OVERLAY.host', id, x, y })
          trace(
            `[PhotoUiTrace] overlayHost.onTouchBegan id=${id} x=${x} y=${y} ticks=${ticks} hostAct=${container.active !== false ? 1 : 0} hostBg=${container.backgroundTouch === true ? 1 : 0} hostVis=${container.visible !== false ? 1 : 0}\n`,
          )
        } else if (viewBehavior?.isDrawerOpen?.()) {
          tracePhotoTakeStep(1, `OVERLAY onTouchBegan (drawer open) id=${id} x=${x} y=${y} — may steal drawer tap`)
        }
      }
      onTouchMoved() {}
      onTouchEnded(container: PiuContainer, id: number, x: number, y: number, ticks: number) {
        const view = container.container
        const viewBehavior = view?.behavior as CommonViewBehavior | undefined
        if (isPhotoPreviewSessionActive()) {
          viewBehavior?.tracePhotoInputState?.('overlayHost.onTouchEnded', { target: 'OVERLAY.host', id, x, y })
          trace(
            `[PhotoUiTrace] overlayHost.onTouchEnded id=${id} x=${x} y=${y} ticks=${ticks} hostAct=${container.active !== false ? 1 : 0} awaitFaceDismiss=${isPhotoPreviewAwaitingFaceDismiss() ? 1 : 0}\n`,
          )
        } else if (viewBehavior?.isDrawerOpen?.()) {
          tracePhotoTakeStep(1, `OVERLAY onTouchEnded (drawer open) id=${id} x=${x} y=${y}`)
        }
        if (isPhotoPreviewAwaitingFaceDismiss()) {
          if (shouldIgnorePhotoPreviewTouch('CommonView.OVERLAY.onTouchEnded', id, x, y)) {
            return
          }
          tracePhotoTouchTimeline('CommonView.OVERLAY.onTouchEnded', `id=${id} x=${x} y=${y} ticks=${ticks}`)
          trace(`[PhotoDismiss] path=C CommonView.OVERLAY.onTouchEnded id=${id} x=${x} y=${y} ticks=${ticks}\n`)
          container.bubble('onFaceTouch', { source: 'CommonView.OVERLAY.onTouchEnded', id, x, y, ticks })
          return
        }
        if (viewBehavior?.isDrawerOpen()) {
          container.bubble('onDrawerClose')
        }
      }
    },
  })
  return {
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    contents: [main, appBar, overlay],
    Behavior: CommonViewBehavior,
  }
}) as unknown as CommonViewTemplateCtor
