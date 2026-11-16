// @ts-nocheck
import { Outline } from 'commodetto/outline'
import { defaultFaceContext, type FaceContext } from 'face-context'
import type { FaceSkinPalette } from 'face-skin'
import type { Skin as PiuSkin } from 'piu/MC'
import type { Shape as PiuShape } from 'piu/shape'
import { defineShapeTemplate } from 'template'

export type MouthOptions = {
  cx: number
  cy: number
  minWidth?: number
  maxWidth?: number
  minHeight?: number
  maxHeight?: number
  cornerRadius?: number
  canvasWidth?: number
  canvasHeight?: number
}

type PositionedShape = Omit<PiuShape, 'fillOutline' | 'strokeOutline'> & {
  skin?: PiuSkin
  state?: number
  fillOutline?: Outline
}

export const Mouth = defineShapeTemplate((opts: MouthOptions) => {
  const cx = opts.cx
  const cy = opts.cy
  const minWidth = opts.minWidth ?? 52
  const maxWidth = opts.maxWidth ?? 80
  const minHeight = opts.minHeight ?? 6
  const maxHeight = opts.maxHeight ?? 22
  const canvasWidth = opts.canvasWidth ?? 200
  const canvasHeight = opts.canvasHeight ?? 120

  return {
    left: 0,
    top: 0,
    width: canvasWidth,
    height: canvasHeight,
    skin: new Skin({ fill: defaultFaceContext.theme.primary }),
    Behavior: class extends Behavior {
      lastOpen = -1
      palette: FaceSkinPalette | null = null

      onFaceSkin(shape: PositionedShape, palette: FaceSkinPalette) {
        this.palette = palette
        shape.skin = palette.palette
        shape.state = palette.primaryState
      }

      onCreate(shape: PositionedShape) {
        this.updatePath(shape, 0)
      }

      onFaceContext(shape: PositionedShape, face: FaceContext) {
        if (!this.palette) {
          shape.skin = new Skin({ fill: face.theme.primary })
        }
        const open = face.mouth.open
        if (open !== this.lastOpen) {
          this.updatePath(shape, open)
        }
      }

      updatePath(shape: PositionedShape, open: number) {
        this.lastOpen = open
        const h = minHeight + (maxHeight - minHeight) * open
        const w = minWidth + (maxWidth - minWidth) * (1 - open)
        const x = cx - w / 2
        const y = cy - h / 2
        const radius = opts.cornerRadius ?? Math.min(6, w * 0.08, h * 0.22)
        shape.fillOutline = Outline.fill(Outline.RoundRectPath(x, y, w, h, radius))
      }
    },
  }
})
