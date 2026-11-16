// @ts-nocheck
import { fetch } from 'fetch'
import type { RobotCamera } from '../camera.js'

const OPENAI_VISION_URL = 'https://api.openai.com/v1/chat/completions'
const VISION_MODEL = 'gpt-4o-mini'

export async function captureAndDescribe(
  camera: RobotCamera,
  apiKey: string,
  onCaptured?: () => void,
  prompt = '이 사진에서 뭐가 보여? 한국어로 짧게 대답해줘.',
): Promise<string> {
  trace('[Vision] starting rgb565 capture\n')
  try {
    await camera.teardownAfterCapture?.()
    await camera.start({ imageType: 'rgb565le', width: 160, height: 120 })
    await camera.capture({ imageType: 'rgb565le', width: 160, height: 120 })
    await camera.teardownAfterCapture?.()
    await camera.start({ imageType: 'rgb565le', width: 160, height: 120 })
    const frame = await camera.capture({ imageType: 'rgb565le', width: 160, height: 120 })
    if (!frame) {
      await camera.teardownAfterCapture?.()
      trace('[Vision] no frame captured\n')
      return '사진을 찍지 못했어.'
    }
    trace(`[Vision] captured ${frame.buffer.byteLength} bytes rgb565\n`)
    const srcBytes = new Uint8Array(frame.buffer)
    const copiedBuffer = new ArrayBuffer(srcBytes.byteLength)
    const dstBytes = new Uint8Array(copiedBuffer)
    dstBytes.set(srcBytes)
    onCaptured?.()
    await camera.teardownAfterCapture?.()
    let png: ArrayBuffer | Uint8Array | undefined
    try {
      const actualPixels = copiedBuffer.byteLength / 2
      const actualWidth = frame.width
      const actualHeight = actualPixels / actualWidth
      trace(`[Vision] actual=${actualWidth}x${actualHeight} pixels=${actualPixels}\n`)
      png = native('xs_photo_storage_rgb565_to_png').call(undefined, actualWidth, actualHeight, copiedBuffer)
      trace(`[Vision] png type=${typeof png} isAB=${png instanceof ArrayBuffer} isU8=${png instanceof Uint8Array}\n`)
    } catch (e) {
      trace(`[Vision] png encode error: ${String(e)}\n`)
      frame.close?.()
      return '사진 변환 실패'
    }
    frame.close?.()
    const pngBuffer =
      png instanceof ArrayBuffer ? png : png instanceof Uint8Array ? png.buffer : new Uint8Array(png).buffer
    trace(`[Vision] encoded to PNG ${pngBuffer.byteLength} bytes\n`)
    const base64 = bufferToBase64(pngBuffer)
    trace('[Vision] sending to OpenAI Vision API\n')
    const response = await fetch(OPENAI_VISION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}` } },
            ],
          },
        ],
      }),
    })
    const json = await response.json()
    trace(`[Vision] response status=${response.status}\n`)
    trace(`[Vision] response json=${JSON.stringify(json).slice(0, 200)}\n`)
    const answer = json?.choices?.[0]?.message?.content ?? '잘 모르겠어.'
    trace(`[Vision] answer: ${answer}\n`)
    return answer
  } catch (error) {
    trace(`[Vision] error: ${String(error)}\n`)
    return '오류가 생겼어.'
  }
}

function bufferToBase64(buffer: ArrayBuffer): string {
  try {
    return native('xs_photo_storage_base64_encode').call(undefined, buffer)
  } catch {
    trace('[Vision] native base64 failed, falling back to JS\n')
    const bytes = new Uint8Array(buffer)
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    let result = ''
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i]
      const b1 = bytes[i + 1] ?? 0
      const b2 = bytes[i + 2] ?? 0
      result += chars[b0 >> 2]
      result += chars[((b0 & 3) << 4) | (b1 >> 4)]
      result += i + 1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '='
      result += i + 2 < bytes.length ? chars[b2 & 63] : '='
    }
    return result
  }
}
