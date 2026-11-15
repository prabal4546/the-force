import {bytesToBase64, registerMiniapp, type TypedMiniappSession} from "@mentra/miniapp/background"
import type {CapturedPhoto, Channels} from "../shared/channels"

type CaptureSource = CapturedPhoto["source"]

registerMiniapp<Channels>((session) => {
  let captureInFlight: Promise<CapturedPhoto> | null = null

  const publish = (phase: "ready" | "capturing" | "captured" | "error", message: string, photo?: CapturedPhoto) => {
    session.ui.send("capture-status", {phase, message, photo})
  }

  const capture = (source: CaptureSource): Promise<CapturedPhoto> => {
    if (captureInFlight) return captureInFlight

    captureInFlight = captureFromGlasses(session, source, publish).finally(() => {
      captureInFlight = null
    })
    return captureInFlight
  }

  session.ui.onOpen(() => {
    publish("ready", "Glasses camera is ready.")
  })

  session.ui.handle("capture-photo", async () => capture("phone"))

  session.input.onButtonPress(() => {
    void capture("glasses").catch((error: unknown) => {
      console.error("Glasses-button capture failed:", error)
    })
  })
})

async function captureFromGlasses(
  session: TypedMiniappSession<Channels>,
  source: CaptureSource,
  publish: (phase: "ready" | "capturing" | "captured" | "error", message: string, photo?: CapturedPhoto) => void,
): Promise<CapturedPhoto> {
  if (session.capabilities && !session.capabilities.hasCamera) {
    const error = new Error("The connected glasses do not report a camera.")
    publish("error", error.message)
    throw error
  }

  publish("capturing", source === "glasses" ? "Glasses button pressed. Capturing…" : "Capturing from the glasses…")

  try {
    const photo = await session.camera.takePhoto({
      size: "medium",
      mode: "photo",
      transferMethod: "ble",
      sound: true,
      saveToGallery: false,
      timeoutMs: 60_000,
    })
    let dataUrl: string | undefined
    try {
      dataUrl = await downloadPhotoForAnalysis(session, photo.requestId, photo.photoUrl, photo.mimeType)
    } catch (error: unknown) {
      console.error("Could not stage photo bytes for target analysis:", error)
    }
    const captured: CapturedPhoto = {...photo, source, dataUrl}
    publish("captured", "Photo received from the glasses.", captured)
    return captured
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    publish("error", message)
    throw error
  }
}

async function downloadPhotoForAnalysis(
  session: TypedMiniappSession<Channels>,
  requestId: string,
  photoUrl: string,
  mimeType: string,
): Promise<string> {
  const key = `target-capture-${requestId}`
  try {
    await session.blob.setFromUrl(key, photoUrl, {mimeType})
    const bytes = await session.blob.bytes(key)
    if (!bytes?.length) throw new Error("Mentra downloaded an empty photo.")
    return `data:${mimeType || "image/jpeg"};base64,${bytesToBase64(bytes)}`
  } finally {
    await session.blob.delete(key).catch(() => {})
  }
}
