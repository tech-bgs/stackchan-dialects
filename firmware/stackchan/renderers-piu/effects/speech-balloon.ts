// @ts-nocheck
import { defaultFaceContext, type FaceContext } from 'face-context'
import {
  Container,
  Content,
  type Container as PiuContainer,
  type Content as PiuContent,
  type Style as PiuStyle,
  type Text as PiuText,
  type Texture as PiuTexture,
  Skin,
  Style,
  Text,
  Texture,
} from 'piu/MC'

let bubbleTexture: PiuTexture | null = null

const MARQUEE_INTERVAL_MS = 50
const DEFAULT_MARQUEE_GAP = 24
const DEFAULT_MARQUEE_SPEED = 0.6
const BALLOON_TEXT_COLOR = '#000000'

const defaultOptions = {
  left: 16,
  right: 16,
  bottom: 12,
  minHeight: 32,
  paddingX: 18,
  paddingY: 10,
  text: 'Hello from Stack-chan',
  font: 'k8x12-12',
}

type BalloonOptions = {
  name?: string
  left?: number
  right?: number
  top?: number
  bottom?: number
  width?: number
  height?: number
  minHeight?: number
  padding?: number
  paddingX?: number
  paddingY?: number
  text?: string
  font?: string
  marquee?: boolean
  space?: number
  speed?: number
  radius?: number
}

type WithSkin = PiuContent & { skin?: unknown }
type MovableText = PiuText & { left?: number; visible?: boolean }

type BalloonContainerOptions = {
  name?: string
  left?: number
  right?: number
  top?: number
  bottom?: number
  width?: number
  height?: number
  clip: boolean
  active?: boolean
  Behavior: typeof Behavior
}

function resolveDimension(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  return value
}

function normalizeMarqueeText(text: string) {
  return (text ?? '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim()
}

export const SpeechBalloon = Container.template((opts: BalloonOptions = {}) => {
  const o = { ...defaultOptions, ...opts }
  const paddingX = resolveDimension(opts.paddingX ?? opts.padding, defaultOptions.paddingX)
  const paddingY = resolveDimension(opts.paddingY ?? opts.padding, defaultOptions.paddingY)
  const minHeight = resolveDimension(opts.minHeight, defaultOptions.minHeight)
  const fixedHeight = opts.height
  const marquee = opts.marquee === true
  const scrollGap = opts.space ?? DEFAULT_MARQUEE_GAP
  const scrollSpeed = opts.speed ?? DEFAULT_MARQUEE_SPEED

  const style: PiuStyle = new Style({ font: o.font, color: BALLOON_TEXT_COLOR, horizontal: 'left' })
  const lineHeight = Math.max(1, style.measure('Mg').height ?? 0)
  let background: WithSkin | null = null
  let bodyText: MovableText | null = null
  let bodyText2: MovableText | null = null
  let currentText = o.text ?? ''
  let currentPrimary: string | null = null
  let currentSecondary: string | null = null
  let currentFace: Readonly<FaceContext> = defaultFaceContext
  let layoutWidth = 0

  const applyTextStyle = (): PiuStyle | null => {
    if (!bodyText) return null
    const textStyle = new Style({ font: o.font, color: BALLOON_TEXT_COLOR, horizontal: 'left' })
    bodyText.style = textStyle
    if (bodyText2) bodyText2.style = textStyle
    return textStyle
  }

  const left = opts.left ?? defaultOptions.left
  const right = opts.right ?? defaultOptions.right
  const top = opts.top
  const bottom = opts.bottom ?? defaultOptions.bottom
  const width = opts.width

  const resolveWidth = (self: PiuContainer) => {
    const w = self.width
    if (w > 0) return w
    if (opts.width !== undefined) return opts.width
    return 240
  }

  const viewTextWidth = (self: PiuContainer) => Math.max(1, resolveWidth(self) - paddingX * 2)

  const countWrappedLines = (text: string, maxWidth: number) => {
    if (!text || text.length === 0) return 1
    const widthLimit = Math.max(1, maxWidth)
    let lines = 1
    let line = ''
    for (const ch of text) {
      if (ch === '\n') {
        lines += 1
        line = ''
        continue
      }
      const candidate = line + ch
      if ((style.measure(candidate).width ?? 0) <= widthLimit) {
        line = candidate
        continue
      }
      lines += 1
      line = ch
    }
    return lines
  }

  const resolveHeight = (self: PiuContainer, text: string) => {
    if (fixedHeight !== undefined) return fixedHeight
    if (marquee) return Math.max(minHeight, paddingY * 2 + lineHeight)
    const availableWidth = resolveWidth(self) - paddingX * 2
    const lines = countWrappedLines(text ?? '', availableWidth)
    return Math.max(minHeight, paddingY * 2 + lineHeight * lines)
  }

  const containerOptions: BalloonContainerOptions = {
    name: opts.name ?? 'SpeechBalloon',
    clip: true,
    active: marquee,
    Behavior: class extends Behavior {
      scrollOffset = 0
      textWidth = 0
      marqueeActive = false

      ensureParts(self: PiuContainer) {
        const w = resolveWidth(self)
        if (background && bodyText && layoutWidth === w && (!marquee || bodyText2)) {
          applyTextStyle()
          return
        }
        if (background || bodyText || bodyText2) {
          self.empty()
          background = null
          bodyText = null
          bodyText2 = null
        }
        currentPrimary = null
        currentSecondary = null
        layoutWidth = w
        background = new Content(null, { left: 0, right: 0, top: 0, bottom: 0 }) as WithSkin

        if (marquee) {
          bodyText = new Text(null, {
            left: paddingX,
            top: paddingY,
            bottom: paddingY,
            string: '',
            style,
          }) as MovableText
          bodyText2 = new Text(null, {
            left: paddingX,
            top: paddingY,
            bottom: paddingY,
            string: '',
            style,
          }) as MovableText
          self.add(background)
          self.add(bodyText)
          self.add(bodyText2)
        } else {
          bodyText = new Text(null, {
            left: paddingX,
            right: paddingX,
            top: paddingY,
            string: '',
            style,
          })
          self.add(background)
          self.add(bodyText)
        }

        this.updatePalette(currentFace)
        this.updateText(self, currentText)
      }

      updatePalette(face: FaceContext) {
        currentFace = face
        applyTextStyle()
        if (!background || !bodyText) return
        if (!bubbleTexture) bubbleTexture = new Texture('bubble.png')
        const primary = face.theme.primary
        const secondary = face.theme.secondary
        if (primary === currentPrimary && secondary === currentSecondary) return
        currentPrimary = primary
        currentSecondary = secondary
        background.skin = new Skin({
          texture: bubbleTexture,
          color: [primary],
          x: 0,
          y: 0,
          width: 204,
          height: 332,
          left: 24,
          right: 24,
          top: 12,
          bottom: 12,
        })
      }

      measureTextWidth(text: string) {
        if (!text || !bodyText?.style) return 0
        return bodyText.style.measure(text).width ?? 0
      }

      updateMarqueeLayout(self: PiuContainer) {
        if (!marquee || !bodyText || !bodyText2) return
        bodyText.string = currentText
        bodyText2.string = currentText
        this.textWidth = this.measureTextWidth(currentText)
        const visibleWidth = viewTextWidth(self)
        const needsScroll = this.textWidth > visibleWidth
        bodyText2.visible = needsScroll
        if (!needsScroll) {
          this.scrollOffset = 0
          bodyText.left = paddingX
          bodyText2.left = paddingX
          return
        }
        bodyText.left = paddingX - this.scrollOffset
        bodyText2.left = paddingX - this.scrollOffset + this.textWidth + scrollGap
      }

      updateMarqueeTimer(self: PiuContainer) {
        if (!marquee) return
        const needsScroll = this.textWidth > viewTextWidth(self)
        if (needsScroll && !this.marqueeActive) {
          this.marqueeActive = true
          self.interval = MARQUEE_INTERVAL_MS
          return
        }
        if (!needsScroll && this.marqueeActive) {
          this.marqueeActive = false
          self.interval = 0
        }
      }

      updateText(self: PiuContainer, text: string) {
        if (!bodyText) return
        if (marquee) {
          this.updateMarqueeLayout(self)
          this.updateMarqueeTimer(self)
          if (fixedHeight === undefined) {
            const nextHeight = resolveHeight(self, currentText)
            if (self.height !== nextHeight) self.height = nextHeight
          }
          return
        }
        bodyText.string = text ?? ''
        if (fixedHeight === undefined) {
          const nextHeight = resolveHeight(self, text ?? '')
          if (self.height !== nextHeight) self.height = nextHeight
        }
      }

      setText(self: PiuContainer, text: string) {
        currentText = marquee ? normalizeMarqueeText(text) : (text ?? '')
        this.scrollOffset = 0
        this.ensureParts(self)
        applyTextStyle()
        this.updateText(self, currentText)
      }

      clear(self: PiuContainer) {
        this.setText(self, '')
      }

      onTimeChanged(_self: PiuContainer) {
        if (!marquee || !this.marqueeActive || !bodyText || !bodyText2) return
        this.scrollOffset += scrollSpeed
        const loop = this.textWidth + scrollGap
        if (this.scrollOffset >= loop) this.scrollOffset = 0
        bodyText.left = paddingX - this.scrollOffset
        bodyText2.left = paddingX - this.scrollOffset + this.textWidth + scrollGap
      }

      onDisplaying(content: PiuContainer) {
        this.ensureParts(content)
        this.updatePalette(currentFace)
      }

      onFaceContext(content: PiuContainer, face: FaceContext) {
        this.ensureParts(content)
        this.updatePalette(face)
      }

      onUndisplaying(content: PiuContainer) {
        content.interval = 0
        this.marqueeActive = false
      }
    },
  }

  if (width !== undefined) {
    containerOptions.width = width
    if (opts.left !== undefined) {
      containerOptions.left = left
    } else if (opts.right !== undefined) {
      containerOptions.right = right
    } else {
      containerOptions.left = left
    }
  } else {
    containerOptions.left = left
    containerOptions.right = right
  }
  if (fixedHeight !== undefined) {
    containerOptions.height = fixedHeight
  }
  if (top !== undefined) {
    containerOptions.top = top
  } else {
    containerOptions.bottom = bottom
  }

  return containerOptions
})

export type { BalloonOptions as SpeechBalloonOptions }
