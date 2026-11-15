import type {Rpc} from "@mentra/miniapp/ui"

export interface CapturedPhoto {
  requestId: string
  photoUrl: string
  mimeType: string
  size: number
  source: "phone" | "glasses"
  dataUrl?: string
}

export interface CaptureStatus {
  phase: "ready" | "capturing" | "captured" | "locked" | "error"
  message: string
  photo?: CapturedPhoto
}

export interface Channels {
  "capture-photo": Rpc<Record<string, never>, CapturedPhoto>
  "capture-status": CaptureStatus
}

declare global {
  // The Mentra App injects this bridge into the miniapp WebView.
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
