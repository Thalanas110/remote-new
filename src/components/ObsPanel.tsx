import { useEffect, useState } from "react";
import { obsClient, type ObsState, defaultObsState } from "@/lib/obs-client";
import { Radio, Circle, Pause, Play, Video, Repeat, Eye, ArrowRight } from "lucide-react";

export function ObsPanel() {
  const [s, setS] = useState<ObsState>(defaultObsState);
  useEffect(() => { const u = obsClient.subscribe(setS); return () => { u(); }; }, []);
  const offline = !s.connected;

  const call = (fn: () => Promise<unknown> | unknown) => () => Promise.resolve(fn()).catch(console.error);

  return (
    <section className="glass flex h-full flex-col rounded-2xl p-4 sm:p-5">
      <header className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl" style={{ background: "color-mix(in oklab, var(--obs) 22%, transparent)", color: "var(--obs)" }}>
            <Video className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold tracking-tight">OBS Studio</h2>
            <p className="truncate text-[11px] text-muted-foreground">WebSocket v5</p>
          </div>
        </div>
        <span className="pill" style={{
          background: s.connected ? "color-mix(in oklab, var(--obs) 18%, transparent)" : "color-mix(in oklab, white 6%, transparent)",
          color: s.connected ? "var(--obs)" : "var(--muted-foreground)",
        }}>
          <span className="dot" style={{ background: s.connected ? "var(--obs)" : "var(--muted-foreground)" }} />
          {s.connected ? "Online" : "Offline"}
        </span>
      </header>

      {offline && (
        <div className="mt-3 rounded-xl border border-dashed border-border bg-card/60 px-3 py-2 text-xs text-muted-foreground">
          OBS is disconnected. The ProPresenter panel can still be used if it is online.
        </div>
      )}

      {/* Live status row */}
      <div className="mt-4 grid grid-cols-3 gap-2">
        <StatusCard label="Stream" active={s.streaming} accent="var(--live)" icon={<Radio className="h-4 w-4" />} />
        <StatusCard label="Record" active={s.recording} paused={s.recordPaused} accent="var(--rec)" icon={<Circle className="h-4 w-4 fill-current" />} />
        <StatusCard label="Studio" active={s.studioMode} accent="var(--obs)" icon={<Eye className="h-4 w-4" />} />
      </div>

      {/* Controls */}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Btn onClick={call(() => obsClient.toggleStream())} active={s.streaming} accent="var(--live)" disabled={offline}>
          {s.streaming ? "Stop Stream" : "Go Live"}
        </Btn>
        <Btn onClick={call(() => obsClient.toggleRecord())} active={s.recording} accent="var(--rec)" disabled={offline}>
          {s.recording ? "Stop Rec" : "Record"}
        </Btn>
        <Btn onClick={call(() => obsClient.toggleRecordPause())} disabled={offline || !s.recording}>
          {s.recordPaused ? <><Play className="h-3.5 w-3.5" /> Resume</> : <><Pause className="h-3.5 w-3.5" /> Pause</>}
        </Btn>
        <Btn onClick={call(() => obsClient.toggleStudio())} active={s.studioMode} accent="var(--obs)" disabled={offline}>
          Studio Mode
        </Btn>
      </div>

      {/* Scenes */}
      <div className="mt-4 flex flex-1 flex-col min-h-0">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Scenes</h3>
          {s.studioMode && (
            <button
              onClick={call(() => obsClient.triggerTransition())}
              disabled={offline}
              className="btn-tap inline-flex items-center gap-1.5 rounded-lg bg-[var(--obs)]/15 px-3 py-1.5 text-xs font-semibold text-[var(--obs)] hover:bg-[var(--obs)]/25 disabled:opacity-40"
            >
              Transition <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="grid flex-1 auto-rows-min grid-cols-2 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-2">
          {s.scenes.length === 0 && (
            <div className="col-span-2 rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
              {offline ? "Connect to OBS to see scenes" : "No scenes"}
            </div>
          )}
          {s.scenes.map((name) => {
            const isProgram = s.currentScene === name;
            const isPreview = s.studioMode && s.previewScene === name;
            return (
              <button
                key={name}
                onClick={call(() => obsClient.setScene(name))}
                onDoubleClick={call(() => obsClient.setProgramScene(name))}
                className={`btn-tap group relative overflow-hidden rounded-xl border p-3 text-left transition ${
                  isProgram ? "border-transparent live-glow" : isPreview ? "border-[var(--obs)]" : "border-border hover:border-foreground/30"
                }`}
                style={{
                  background: isProgram
                    ? "color-mix(in oklab, var(--live) 20%, var(--card))"
                    : isPreview
                    ? "color-mix(in oklab, var(--obs) 14%, var(--card))"
                    : "color-mix(in oklab, var(--card) 80%, transparent)",
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold">{name}</span>
                  {isProgram && <span className="pill" style={{ background: "var(--live)", color: "white" }}>LIVE</span>}
                  {isPreview && !isProgram && <span className="pill" style={{ background: "color-mix(in oklab, var(--obs) 30%, transparent)", color: "var(--obs)" }}>PREV</span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function StatusCard({ label, active, paused, accent, icon }: { label: string; active: boolean; paused?: boolean; accent: string; icon: React.ReactNode }) {
  return (
    <div
      className="rounded-xl border border-border px-3 py-2.5"
      style={{ background: active ? `color-mix(in oklab, ${accent} 18%, var(--card))` : "color-mix(in oklab, var(--card) 80%, transparent)" }}
    >
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span style={{ color: active ? accent : "currentColor" }}>{icon}</span>
        {label}
      </div>
      <div className="mt-0.5 text-sm font-bold" style={{ color: active ? accent : "var(--foreground)" }}>
        {paused ? "Paused" : active ? "On" : "Off"}
      </div>
    </div>
  );
}

function Btn({ children, onClick, active, accent, disabled }: { children: React.ReactNode; onClick: () => void; active?: boolean; accent?: string; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="btn-tap inline-flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-xs font-semibold transition disabled:opacity-40"
      style={{
        background: active && accent ? `color-mix(in oklab, ${accent} 25%, var(--card))` : "color-mix(in oklab, var(--card) 80%, transparent)",
        borderColor: active && accent ? accent : "var(--border)",
        color: active && accent ? accent : "var(--foreground)",
      }}
    >
      {children}
    </button>
  );
}
