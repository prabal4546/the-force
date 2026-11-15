import jsQR from "jsqr"

export type TargetID = "mac" | "externalDisplay" | "gimbal" | "personRed" | "personBlue"

const MARKERS: Record<string, TargetID> = {
  "bodyos://device/mac": "mac",
  "bodyos://device/external-display": "externalDisplay",
  "bodyos://device/gimbal": "gimbal",
  "bodyos://person/red": "personRed",
  "bodyos://person/blue": "personBlue",
}

export function targetForMarker(payload: string): TargetID | null {
  const text = payload.trim()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }

  if (url.protocol.toLowerCase() !== "bodyos:" || url.search || url.hash) return null
  const path = url.pathname.replace(/\/+$/, "")
  return MARKERS[`bodyos://${url.hostname.toLowerCase()}${path}`] ?? null
}

export async function targetFromPhoto(photoUrl: string): Promise<TargetID | null> {
  const source = photoUrl.startsWith("data:")
    ? await loadImageFromDataUrl(photoUrl)
    : await downloadImage(photoUrl)

  try {
    const maxDimension = 1600
    const scale = Math.min(1, maxDimension / Math.max(source.width, source.height))
    const width = Math.max(1, Math.round(source.width * scale))
    const height = Math.max(1, Math.round(source.height * scale))
    const detected = await detectWithNativeBarcodeAPI(source.image)
    for (const payload of detected) {
      const target = targetForMarker(payload)
      if (target) return target
    }

    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d", {willReadFrequently: true})
    if (!context) throw new Error("This phone cannot analyze the captured photo.")
    context.drawImage(source.image, 0, 0, width, height)
    const pixels = context.getImageData(0, 0, width, height)
    const code = jsQR(pixels.data, width, height, {inversionAttempts: "attemptBoth"})
    return code ? targetForMarker(code.data) : null
  } finally {
    source.release()
  }
}

async function downloadImage(photoUrl: string): Promise<LoadedImage> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 15_000)
  let response: Response
  try {
    response = await fetch(photoUrl, {signal: controller.signal})
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Timed out downloading the captured photo for QR analysis.")
    }
    throw new Error("The photo preview loaded, but Mentra blocked QR analysis of its URL.")
  } finally {
    window.clearTimeout(timeout)
  }
  if (!response.ok) throw new Error(`Could not download the glasses photo (${response.status}).`)
  const blob = await response.blob()
  return loadImage(blob)
}

async function detectWithNativeBarcodeAPI(image: CanvasImageSource): Promise<string[]> {
  type Detector = {
    detect(source: CanvasImageSource): Promise<Array<{rawValue: string}>>
  }
  type DetectorConstructor = new (options: {formats: string[]}) => Detector
  const BarcodeDetector = (globalThis as unknown as {BarcodeDetector?: DetectorConstructor}).BarcodeDetector
  if (!BarcodeDetector) return []
  try {
    const codes = await new BarcodeDetector({formats: ["qr_code"]}).detect(image)
    return codes.map((code) => code.rawValue)
  } catch {
    return []
  }
}

interface LoadedImage {
  image: CanvasImageSource
  width: number
  height: number
  release: () => void
}

async function loadImageFromDataUrl(dataUrl: string): Promise<LoadedImage> {
  const image = new Image()
  image.src = dataUrl
  try {
    await image.decode()
  } catch {
    throw new Error("Mentra supplied photo bytes, but the WebView could not decode the JPEG.")
  }
  return {
    image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    release: () => {},
  }
}

async function loadImage(blob: Blob): Promise<LoadedImage> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob)
    return {image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close()}
  }

  const objectUrl = URL.createObjectURL(blob)
  const image = new Image()
  image.src = objectUrl
  await image.decode()
  return {
    image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    release: () => URL.revokeObjectURL(objectUrl),
  }
}

export async function lockTargetOnMac(macAddress: string, target: TargetID): Promise<void> {
  const socketUrl = macWebSocketURL(macAddress)
  const requestId = createMessageId()

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(socketUrl)
    const timeout = window.setTimeout(() => finish(new Error("The Mac runtime did not confirm the target lock.")), 5_000)

    const finish = (error?: Error) => {
      window.clearTimeout(timeout)
      socket.close()
      error ? reject(error) : resolve()
    }

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        version: 1,
        id: requestId,
        type: "target.detected",
        target,
        confidence: 1,
      }))
    })
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {type?: string; replyTo?: string; message?: string}
        if (message.replyTo !== requestId) return
        if (message.type === "error") finish(new Error(message.message ?? "The Mac rejected the target lock."))
        else finish()
      } catch {
        // Ignore unrelated or malformed frames and keep waiting for the ack.
      }
    })
    socket.addEventListener("error", () => finish(new Error(`Cannot reach the Mac runtime at ${socketUrl}.`)), {once: true})
  })
}

export function macWebSocketURL(address: string): string {
  const trimmed = address.trim()
  if (!trimmed) throw new Error("Enter the Mac address before locking a target.")
  const candidate = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `ws://${trimmed}`
  const url = new URL(candidate)
  if (url.protocol === "http:") url.protocol = "ws:"
  if (url.protocol === "https:") url.protocol = "wss:"
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("Use a ws://, wss://, or plain Mac address.")
  if (!url.port) url.port = "8765"
  url.pathname = "/"
  url.search = ""
  url.hash = ""
  return url.toString()
}

function createMessageId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `mentra-${Date.now()}-${Math.random().toString(16).slice(2)}`
}
