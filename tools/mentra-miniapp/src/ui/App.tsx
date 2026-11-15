import {useEffect, useState} from "react"
import type {CaptureStatus, CapturedPhoto} from "../shared/channels"
import {lockTargetOnMac, targetFromPhoto, type TargetID} from "./target-lock"

const configuredMacHost = process.env.MENTRA_PUBLIC_MAC_HOST ?? ""

const initialStatus: CaptureStatus = {
  phase: "ready",
  message: "Ready to capture what the glasses see.",
}

export function App() {
  const [status, setStatus] = useState<CaptureStatus>(initialStatus)
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null)
  const [macHost, setMacHost] = useState(() => localStorage.getItem("the-force.mac-host") ?? configuredMacHost)
  const [lockedTarget, setLockedTarget] = useState<TargetID | null>(null)
  const [analysis, setAnalysis] = useState("No photo analyzed yet.")

  useEffect(() => {
    return mentra.on("capture-status", (next) => {
      setStatus(next)
      if (next.photo) setPhoto(next.photo)
    })
  }, [])

  const capture = async () => {
    setStatus({phase: "capturing", message: "Capturing from the glasses…"})
    try {
      const result = await mentra.request("capture-photo", {}, {timeout: 65_000})
      setPhoto(result)
      await analyzeAndLock(result)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      setStatus({phase: "error", message})
    }
  }

  const analyzeAndLock = async (captured: CapturedPhoto) => {
    setStatus({phase: "captured", message: "Analyzing the captured photo…", photo: captured})
    setAnalysis("Downloading full photo from Mentra…")
    try {
      if (!captured.dataUrl) {
        throw new Error("Mentra could not provide photo bytes for QR analysis. Use the demo fallback below.")
      }
      const target = await targetFromPhoto(captured.dataUrl)
      if (!target) {
        setAnalysis("No marker detected; using the selected Mac target for this demo capture.")
        await deliverTarget("mac", captured, "Mac locked from the glasses capture.")
        return
      }

      await deliverTarget(target, captured, `${labelForTarget(target)} marker detected.`)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      setAnalysis(`FAILED: ${message}`)
      setStatus({phase: "error", message, photo: captured})
    }
  }

  const deliverTarget = async (target: TargetID, captured: CapturedPhoto, reason: string) => {
    setAnalysis(`${reason} Contacting ${macHost || "the Mac"}…`)
    localStorage.setItem("the-force.mac-host", macHost)
    await lockTargetOnMac(macHost, target)
    setLockedTarget(target)
    setAnalysis(`${labelForTarget(target)} target delivered to the Mac coordinator.`)
    setStatus({phase: "locked", message: `${labelForTarget(target)} LOCKED — use the Vexo band now.`, photo: captured})
  }

  const fallbackLockMac = async () => {
    setAnalysis(`Demo fallback: contacting ${macHost || "the Mac"}…`)
    try {
      localStorage.setItem("the-force.mac-host", macHost)
      await lockTargetOnMac(macHost, "mac")
      setLockedTarget("mac")
      setAnalysis("Mac target delivered using the demo fallback.")
      setStatus({phase: "locked", message: "Mac LOCKED — use the Vexo band now.", photo: photo ?? undefined})
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      setAnalysis(`FAILED: ${message}`)
      setStatus({phase: "error", message, photo: photo ?? undefined})
    }
  }

  return (
    <main className="app">
      <p className="eyebrow">THE FORCE</p>
      <h1>Target Capture</h1>
      <p className={`status status--${status.phase}`}>{status.message}</p>

      <label className="field">
        <span>Mac runtime</span>
        <input
          value={macHost}
          onChange={(event) => setMacHost(event.target.value)}
          placeholder="172.17.26.156:8765"
          autoCapitalize="none"
          autoCorrect="off"
        />
      </label>

      <button type="button" onClick={capture} disabled={status.phase === "capturing"}>
        {status.phase === "capturing" ? "Capturing…" : "Capture from glasses"}
      </button>

      <p className="hint">You can also press the glasses button while this miniapp is enabled.</p>

      {lockedTarget ? <p className="lock">LOCKED · {labelForTarget(lockedTarget)}</p> : null}

      <section className="analysis" aria-live="polite">
        <strong>Target analysis</strong>
        <span>{analysis}</span>
      </section>

      {photo && !lockedTarget ? (
        <div className="fallbacks">
          <button type="button" className="secondary" onClick={() => analyzeAndLock(photo)}>
            Analyze this photo again
          </button>
          <button type="button" className="text-button" onClick={fallbackLockMac}>
            Lock Mac (demo fallback)
          </button>
        </div>
      ) : null}

      {photo ? (
        <figure>
          <img src={photo.dataUrl ?? photo.photoUrl} alt="Latest view captured by the Mentra glasses" />
          <figcaption>{Math.max(1, Math.round(photo.size / 1024))} KB · {photo.source} trigger</figcaption>
        </figure>
      ) : (
        <div className="empty">The latest glasses photo will appear here.</div>
      )}
    </main>
  )
}

function labelForTarget(target: TargetID): string {
  return {
    mac: "Mac",
    externalDisplay: "External display",
    gimbal: "Gimbal",
    personRed: "Red person",
    personBlue: "Blue person",
  }[target]
}
