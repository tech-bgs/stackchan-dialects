// @ts-nocheck
import type { Content as PiuContent } from 'piu/MC'
import type { FaceContext } from 'face-context'
import type { Container as PiuContainer } from 'piu/MC'
import type { AppController } from 'app-controller'
import type { DrawerButtonSpec } from 'drawer'

type RendererCompatOptions = {
  controller: AppController
}

let warned = false

function warnDeprecation() {
  if (warned) return
  warned = true
  trace('[DEPRECATED] RendererCompat is a temporary adapter. Use AppController/FaceView APIs directly.\n')
}

// Compatibility layer for legacy Renderer API. Mods compatibility is not fully verified yet.
export class RendererCompat {
  #controller: AppController

  constructor(options: RendererCompatOptions) {
    warnDeprecation()
    this.#controller = options.controller
  }

  get application() {
    return this.#controller.application
  }

  update(interval: number, faceContext: Readonly<FaceContext>): void {
    this.#controller.update(interval, faceContext)
  }

  addDecorator(effect: Effect, key?: string): void {
    warnDeprecation()
    this.#controller.addEffect(effect, key)
  }

  removeDecorator(effect: Effect): void {
    warnDeprecation()
    this.#controller.removeEffect(effect)
  }

  showScreenOverlay(content: PiuContent, key: string): void {
    warnDeprecation()
    this.#controller.showScreenOverlay(content, key)
  }

  removeScreenOverlay(key: string): void {
    warnDeprecation()
    this.#controller.removeScreenOverlay(key)
  }

  restoreScreenInput(): void {
    warnDeprecation()
    this.#controller.restoreScreenInput()
  }

  obscureMainForPhotoPreview(obscure: boolean): void {
    this.#controller.obscureMainForPhotoPreview(obscure)
  }

  tracePhotoUiLayers(phase: string, key?: string): void {
    this.#controller.tracePhotoUiLayers(phase, key)
  }

  tracePhotoOverlayMilestone(phase: string, key?: string): void {
    this.#controller.tracePhotoOverlayMilestone(phase, key)
  }

  tracePhotoInputState(phase: string, hit?: { target: string; id: number; x: number; y: number }, key?: string): void {
    this.#controller.tracePhotoInputState(phase, hit, key)
  }

  tracePhotoOverlayHitState(phase: string, key?: string): void {
    this.#controller.tracePhotoOverlayHitState(phase, key)
  }

  tracePhotoOverlayRuntimeSnapshot(phase: string, key?: string): void {
    this.#controller.tracePhotoOverlayRuntimeSnapshot(phase, key)
  }

  tracePhotoDisplayHierarchy(phase: string, key?: string): void {
    this.#controller.tracePhotoDisplayHierarchy(phase, key)
  }

  setFace(face: PiuContainer): void {
    this.#controller.setFace(face)
  }

  pauseFaceAnimation(): void {
    this.#controller.pauseFaceAnimation()
  }

  resumeFaceAnimation(): void {
    this.#controller.resumeFaceAnimation()
  }

  addDrawerButton(button: DrawerButtonSpec): void {
    this.#controller.addDrawerButton(button)
  }
}

export type Effect = PiuContent
export type LegacyDecorator = PiuContent
