import { useEffect, useState, type ReactNode } from "react";
import { obsClient, type ObsState, defaultObsState } from "@/lib/obs-client";
import { formatSceneGuardReason } from "@/lib/obs-scene-guard";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ArrowRight, Circle, Eye, Pause, Play, Radio, TriangleAlert, Video } from "lucide-react";

export function ObsPanel() {
  const [s, setS] = useState<ObsState>(defaultObsState);

  useEffect(() => {
    const unsubscribe = obsClient.subscribe(setS);
    return () => {
      unsubscribe();
    };
  }, []);

  const offline = !s.connected;
  const remoteStudioOn = s.remoteStudioMode;
  const previewScene = s.remotePreviewScene;
  const monitor = s.programMonitor;
  const compactSceneCards = s.scenes.length >= 8;
  const pendingProgramSwitch = s.pendingProgramSwitch;
  const pendingReasonLabels = pendingProgramSwitch?.reasons.map(formatSceneGuardReason) ?? [];
  const pendingActionLabel =
    pendingProgramSwitch?.requestedFrom === "transition"
      ? "finish this transition"
      : "take this cut live";
  const monitorUpdatedAt = monitor.lastUpdatedAt
    ? new Date(monitor.lastUpdatedAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : null;
  const monitorStatus = !s.connected
    ? "Disconnected"
    : monitor.loading && !monitor.imageDataUrl
      ? "Loading..."
      : monitor.error && !monitor.imageDataUrl
        ? "Unavailable"
        : monitorUpdatedAt
          ? `Updated ${monitorUpdatedAt}`
          : "Waiting for frame";

  const call = (fn: () => Promise<unknown> | unknown) => () =>
    Promise.resolve(fn()).catch(console.error);

  return (
    <>
      <AlertDialog
        open={pendingProgramSwitch != null}
        onOpenChange={(open) => {
          if (!open) {
            obsClient.cancelPendingProgramSwitch();
          }
        }}
      >
        <AlertDialogContent className="border-amber-500/40 bg-zinc-950 text-zinc-50">
          <AlertDialogHeader>
            <div className="flex items-center gap-2 text-amber-300">
              <TriangleAlert className="h-5 w-5" />
              <AlertDialogTitle>Confirm program switch</AlertDialogTitle>
            </div>
            <AlertDialogDescription className="text-zinc-300">
              {pendingProgramSwitch ? (
                <>
                  Scene{" "}
                  <span className="font-semibold text-zinc-50">
                    {pendingProgramSwitch.sceneName}
                  </span>{" "}
                  may be unsafe to air live. Confirm to {pendingActionLabel}.
                </>
              ) : (
                "Confirm this program switch."
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-amber-300">
              Detection reasons
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {pendingReasonLabels.map((reason) => (
                <span
                  key={reason}
                  className="rounded-full border border-amber-400/30 bg-amber-300/10 px-2.5 py-1 text-xs font-medium text-amber-100"
                >
                  {reason}
                </span>
              ))}
            </div>
          </div>

          <AlertDialogFooter>
            <button
              onClick={() => obsClient.cancelPendingProgramSwitch()}
              className="btn-tap inline-flex items-center justify-center rounded-xl border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-semibold text-zinc-100 transition hover:bg-zinc-800"
            >
              Cancel
            </button>
            <button
              onClick={call(() => obsClient.confirmPendingProgramSwitch())}
              className="btn-tap inline-flex items-center justify-center rounded-xl bg-amber-400 px-3 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-amber-300"
            >
              Switch Anyway
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <section className="glass flex h-full min-h-0 flex-col rounded-2xl p-4 sm:p-5">
        <header className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex items-center gap-2.5">
            <div
              className="grid h-9 w-9 shrink-0 place-items-center rounded-xl"
              style={{
                background: "color-mix(in oklab, var(--obs) 22%, transparent)",
                color: "var(--obs)",
              }}
            >
              <Video className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold tracking-tight">OBS Studio</h2>
              <p className="truncate text-[11px] text-muted-foreground">WebSocket v5</p>
            </div>
          </div>

          <span
            className="pill"
            style={{
              background: s.connected
                ? "color-mix(in oklab, var(--obs) 18%, transparent)"
                : "color-mix(in oklab, white 6%, transparent)",
              color: s.connected ? "var(--obs)" : "var(--muted-foreground)",
            }}
          >
            <span
              className="dot"
              style={{
                background: s.connected ? "var(--obs)" : "var(--muted-foreground)",
              }}
            />
            {s.connected ? "Online" : "Offline"}
          </span>
        </header>

        {offline && (
          <div className="mt-3 rounded-xl border border-dashed border-border bg-card/60 px-3 py-2 text-xs text-muted-foreground">
            OBS is disconnected. The ProPresenter panel can still be used if it is online.
          </div>
        )}

        <div className="mt-4 rounded-xl border border-border bg-card/60 p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Live Program
              </h3>
              <p className="text-xs text-muted-foreground">{monitorStatus}</p>
            </div>
            {monitor.error && monitor.imageDataUrl && (
              <span
                className="pill text-amber-200"
                style={{ background: "rgba(245, 158, 11, 0.12)" }}
              >
                Stale Frame
              </span>
            )}
          </div>

          <div className="overflow-hidden rounded-xl border border-border bg-black/70">
            <div className="aspect-video">
              {monitor.imageDataUrl ? (
                <img
                  src={monitor.imageDataUrl}
                  alt="OBS live program monitor"
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
                  {!s.connected
                    ? "Connect OBS to load the live program monitor."
                    : monitor.error
                      ? "Program monitor unavailable for this scene."
                      : "Loading live program monitor..."}
                </div>
              )}
            </div>
          </div>

          {monitor.error && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              {monitor.imageDataUrl
                ? "Monitor refresh failed. Showing the last good frame."
                : monitor.error}
            </p>
          )}
        </div>

        <div className="mt-4 grid grid-cols-3 gap-2">
          <StatusCard
            label="Stream"
            active={s.streaming}
            accent="var(--live)"
            icon={<Radio className="h-4 w-4" />}
          />
          <StatusCard
            label="Record"
            active={s.recording}
            paused={s.recordPaused}
            accent="var(--rec)"
            icon={<Circle className="h-4 w-4 fill-current" />}
          />
          <StatusCard
            label="Remote Studio"
            active={remoteStudioOn}
            accent="var(--obs)"
            icon={<Eye className="h-4 w-4" />}
          />
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Btn
            onClick={call(() => obsClient.toggleStream())}
            active={s.streaming}
            accent="var(--live)"
            disabled={offline}
          >
            {s.streaming ? "Stop Stream" : "Go Live"}
          </Btn>
          <Btn
            onClick={call(() => obsClient.toggleRecord())}
            active={s.recording}
            accent="var(--rec)"
            disabled={offline}
          >
            {s.recording ? "Stop Rec" : "Record"}
          </Btn>
          <Btn
            onClick={call(() => obsClient.toggleRecordPause())}
            disabled={offline || !s.recording}
          >
            {s.recordPaused ? (
              <>
                <Play className="h-3.5 w-3.5" /> Resume
              </>
            ) : (
              <>
                <Pause className="h-3.5 w-3.5" /> Pause
              </>
            )}
          </Btn>
          <Btn
            onClick={call(() => obsClient.toggleRemoteStudio())}
            active={remoteStudioOn}
            accent="var(--obs)"
            disabled={offline}
          >
            Remote Studio
          </Btn>
          <Btn
            onClick={call(() => obsClient.toggleSceneGuard())}
            active={s.sceneGuardEnabled}
            accent="#f59e0b"
            disabled={offline}
          >
            {s.sceneGuardEnabled ? "Guard On" : "Guard Off"}
          </Btn>
        </div>

        <div className="mt-4 flex min-h-0 flex-1 flex-col">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Scene Matrix
              </h3>
              <p className="text-[11px] text-muted-foreground">
                {remoteStudioOn
                  ? "Tap a scene to stage it, then press Transition."
                  : "All scenes stay visible for fast live cuts."}
              </p>
            </div>
            {remoteStudioOn && (
              <button
                onClick={call(() => obsClient.triggerTransition())}
                disabled={offline || !previewScene || previewScene === s.currentScene}
                className="btn-tap inline-flex items-center gap-1.5 rounded-lg bg-[var(--obs)]/15 px-3 py-1.5 text-xs font-semibold text-[var(--obs)] hover:bg-[var(--obs)]/25 disabled:opacity-40"
              >
                Transition <ArrowRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          <div className="grid h-full auto-rows-fr grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {s.scenes.length === 0 && (
              <div className="col-span-full rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                {offline ? "Connect to OBS to see scenes." : "No scenes."}
              </div>
            )}
            {s.scenes.map((sceneName) => (
              <SceneButton
                key={sceneName}
                sceneName={sceneName}
                isProgram={s.currentScene === sceneName}
                isPreview={remoteStudioOn && previewScene === sceneName}
                guardState={s.sceneGuard[sceneName]}
                compact={compactSceneCards}
                onSelect={call(() => obsClient.setScene(sceneName))}
              />
            ))}
          </div>
        </div>
      </section>
    </>
  );
}

function SceneButton({
  sceneName,
  isProgram,
  isPreview,
  guardState,
  compact,
  onSelect,
}: {
  sceneName: string;
  isProgram: boolean;
  isPreview: boolean;
  guardState?: ObsState["sceneGuard"][string];
  compact: boolean;
  onSelect: () => void;
}) {
  const flagged = guardState?.status === "flagged";

  return (
    <button
      onClick={onSelect}
      className={`btn-tap relative h-full min-h-0 overflow-hidden rounded-xl border text-left transition ${
        compact ? "p-2" : "p-2.5"
      } ${
        isProgram
          ? "border-transparent live-glow"
          : isPreview
            ? "border-[var(--obs)]"
            : flagged
              ? "border-amber-400/80 hover:border-amber-300"
              : "border-border hover:border-foreground/30"
      }`}
      style={{
        background: isProgram
          ? "color-mix(in oklab, var(--live) 20%, var(--card))"
          : isPreview
            ? "color-mix(in oklab, var(--obs) 14%, var(--card))"
            : flagged
              ? "color-mix(in oklab, rgb(245 158 11) 10%, var(--card))"
              : "color-mix(in oklab, var(--card) 80%, transparent)",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <span
          className={`block truncate leading-tight font-semibold ${compact ? "text-[11px]" : "text-xs sm:text-sm"}`}
        >
          {sceneName}
        </span>
        {isProgram ? (
          <SceneBadge background="var(--live)" color="white" label="LIVE" />
        ) : isPreview ? (
          <SceneBadge
            background="color-mix(in oklab, var(--obs) 30%, transparent)"
            color="var(--obs)"
            label="PREV"
          />
        ) : flagged ? (
          <SceneBadge background="rgba(245, 158, 11, 0.18)" color="#fbbf24" label="WARN" />
        ) : null}
        {flagged && (
          <span className="sr-only">
            {guardState?.reasons.map(formatSceneGuardReason).join(", ")}
          </span>
        )}
      </div>
    </button>
  );
}

function SceneBadge({
  background,
  color,
  label,
}: {
  background: string;
  color: string;
  label: string;
}) {
  return (
    <span className="pill shrink-0" style={{ background, color }}>
      {label}
    </span>
  );
}

function StatusCard({
  label,
  active,
  paused,
  accent,
  icon,
}: {
  label: string;
  active: boolean;
  paused?: boolean;
  accent: string;
  icon: ReactNode;
}) {
  return (
    <div
      className="rounded-xl border border-border px-3 py-2.5"
      style={{
        background: active
          ? `color-mix(in oklab, ${accent} 18%, var(--card))`
          : "color-mix(in oklab, var(--card) 80%, transparent)",
      }}
    >
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        <span style={{ color: active ? accent : "currentColor" }}>{icon}</span>
        {label}
      </div>
      <div
        className="mt-0.5 text-sm font-bold"
        style={{ color: active ? accent : "var(--foreground)" }}
      >
        {paused ? "Paused" : active ? "On" : "Off"}
      </div>
    </div>
  );
}

function Btn({
  children,
  onClick,
  active,
  accent,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
  accent?: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="btn-tap inline-flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-xs font-semibold transition disabled:opacity-40"
      style={{
        background:
          active && accent
            ? `color-mix(in oklab, ${accent} 25%, var(--card))`
            : "color-mix(in oklab, var(--card) 80%, transparent)",
        borderColor: active && accent ? accent : "var(--border)",
        color: active && accent ? accent : "var(--foreground)",
      }}
    >
      {children}
    </button>
  );
}
