import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { defaultPpState, ppClient, type PpState } from "@/lib/propresenter-client";
import {
  ChevronLeft,
  ChevronRight,
  Image,
  Layers,
  Loader2,
  MessageSquare,
  Music,
  Presentation,
  Square,
  TimerReset,
} from "lucide-react";

const invoke = (operation: () => Promise<unknown>) => () => {
  void operation().catch(() => {});
};

export function ProPresenterPanel() {
  const [s, setS] = useState<PpState>(defaultPpState);

  useEffect(() => {
    const unsubscribe = ppClient.subscribe(setS);
    return () => {
      unsubscribe();
    };
  }, []);

  const offline = !s.connected;
  const statusLabel = !s.connected ? "Offline" : s.degraded ? "Degraded" : "Online";
  const navigationPending = s.activeAction === "navigation";
  const clearPending = s.activeAction === "clear";
  const timerPending = s.activeAction === "timer";
  const hostLabel =
    [s.machineName, s.hostDescription].filter(Boolean).join(" · ") || "REST API · :50001";

  const statusStyle = offline
    ? {
        background: "color-mix(in oklab, white 6%, transparent)",
        color: "var(--muted-foreground)",
      }
    : s.degraded
      ? {
          background: "color-mix(in oklab, #f59e0b 16%, transparent)",
          color: "#fbbf24",
        }
      : {
          background: "color-mix(in oklab, var(--pp) 18%, transparent)",
          color: "var(--pp)",
        };

  return (
    <section className="glass flex h-full min-h-0 flex-col rounded-2xl p-4 sm:p-5">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border"
            style={{
              background: "color-mix(in oklab, var(--pp) 18%, transparent)",
              borderColor: "color-mix(in oklab, var(--pp) 32%, transparent)",
              color: "var(--pp)",
            }}
          >
            <Presentation className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold tracking-tight">ProPresenter</h2>
            <p className="truncate text-[11px] text-muted-foreground">{hostLabel}</p>
          </div>
        </div>
        <span className="pill" style={statusStyle}>
          <span
            className="dot"
            style={{ background: offline ? "var(--muted-foreground)" : "currentColor" }}
          />
          {statusLabel}
        </span>
      </header>

      {s.refreshError && (
        <div
          role="status"
          aria-live="polite"
          className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
        >
          {s.refreshError}
        </div>
      )}
      {s.actionError && (
        <div
          role="alert"
          className="mt-3 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {s.actionError}
        </div>
      )}

      <div
        className="relative mt-4 overflow-hidden rounded-xl border border-border p-4"
        style={{ background: "color-mix(in oklab, var(--pp) 8%, var(--card))" }}
      >
        <div
          className="absolute inset-y-0 left-0 w-1"
          style={{ background: offline ? "var(--border)" : "var(--pp)" }}
        />
        <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Active Presentation
        </div>
        <div className="mt-1 truncate text-lg font-black tracking-tight">
          {s.activePresentationName || (s.connected ? "No active presentation" : "Not connected")}
        </div>
        <div className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">
          Slide {typeof s.currentSlideIndex === "number" ? s.currentSlideIndex + 1 : "—"}
          {typeof s.totalSlides === "number" ? ` of ${s.totalSlides}` : ""}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          onClick={invoke(() => ppClient.previous())}
          disabled={offline || navigationPending}
          className="btn-tap flex min-h-16 items-center justify-center gap-2 rounded-2xl border border-border bg-card/70 px-3 text-sm font-bold uppercase tracking-wider disabled:opacity-40"
        >
          {navigationPending ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <ChevronLeft className="h-5 w-5" />
          )}
          Previous
        </button>
        <button
          onClick={invoke(() => ppClient.next())}
          disabled={offline || navigationPending}
          className="btn-tap flex min-h-16 items-center justify-center gap-2 rounded-2xl px-3 text-sm font-black uppercase tracking-wider text-[var(--primary-foreground)] shadow-lg disabled:opacity-40"
          style={{
            background:
              "linear-gradient(135deg, var(--pp), color-mix(in oklab, var(--pp) 60%, var(--primary)))",
            boxShadow: "0 12px 32px color-mix(in oklab, var(--pp) 20%, transparent)",
          }}
        >
          Next
          {navigationPending ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <ChevronRight className="h-5 w-5" />
          )}
        </button>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Clear Layers
          </h3>
          {clearPending && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <ClearBtn
            onClick={invoke(() => ppClient.clearSlide())}
            disabled={offline || clearPending}
            icon={<Layers className="h-4 w-4" />}
            label="Slide"
          />
          <ClearBtn
            onClick={invoke(() => ppClient.clearProps())}
            disabled={offline || clearPending}
            icon={<Image className="h-4 w-4" />}
            label="Props"
          />
          <ClearBtn
            onClick={invoke(() => ppClient.clearMessages())}
            disabled={offline || clearPending}
            icon={<MessageSquare className="h-4 w-4" />}
            label="Msgs"
          />
          <ClearBtn
            onClick={invoke(() => ppClient.clearAudio())}
            disabled={offline || clearPending}
            icon={<Music className="h-4 w-4" />}
            label="Audio"
          />
          <ClearBtn
            onClick={invoke(() => ppClient.clearAnnouncements())}
            disabled={offline || clearPending}
            icon={<MessageSquare className="h-4 w-4" />}
            label="Annc"
          />
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button
                disabled={offline || clearPending}
                className="btn-tap flex min-h-11 items-center justify-center gap-1.5 rounded-xl border px-2 py-2.5 text-xs font-bold disabled:opacity-40"
                style={{
                  background: "color-mix(in oklab, var(--destructive) 16%, var(--card))",
                  borderColor: "color-mix(in oklab, var(--destructive) 45%, transparent)",
                  color: "var(--destructive)",
                }}
              >
                <Square className="h-4 w-4 fill-current" /> All
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear all ProPresenter layers?</AlertDialogTitle>
                <AlertDialogDescription>
                  This clears audio, props, messages, announcements, slides, media, and video
                  inputs.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={invoke(() => ppClient.clearAll())}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Clear all
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <div className="mt-4">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          Timer Control
        </h3>
        <TimerControls disabled={offline || timerPending} pending={timerPending} />
      </div>
    </section>
  );
}

function ClearBtn({
  onClick,
  disabled,
  icon,
  label,
}: {
  onClick: () => void;
  disabled: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="btn-tap flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-border bg-card/70 px-2 py-2.5 text-xs font-semibold disabled:opacity-40"
    >
      {icon} {label}
    </button>
  );
}

function TimerControls({ disabled, pending }: { disabled: boolean; pending: boolean }) {
  const [id, setId] = useState("");
  const empty = !id.trim();

  return (
    <div className="rounded-xl border border-border bg-card/45 p-2.5">
      <div className="flex items-center gap-2">
        <TimerReset className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          value={id}
          onChange={(event) => setId(event.target.value)}
          placeholder="Timer UUID, name, or index"
          className="min-w-0 flex-1 rounded-lg border border-border bg-input/40 px-3 py-2 text-xs outline-none transition-colors focus:border-[var(--pp)]"
        />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        <button
          onClick={invoke(() => ppClient.timerStart(id.trim()))}
          disabled={disabled || empty}
          className="btn-tap rounded-lg border border-border px-2 py-2 text-xs font-bold disabled:opacity-40"
          style={{ color: "var(--pp)" }}
        >
          {pending ? <Loader2 className="mx-auto h-3.5 w-3.5 animate-spin" /> : "Start"}
        </button>
        <button
          onClick={invoke(() => ppClient.timerStop(id.trim()))}
          disabled={disabled || empty}
          className="btn-tap rounded-lg border border-border px-2 py-2 text-xs font-semibold disabled:opacity-40"
        >
          Stop
        </button>
        <button
          onClick={invoke(() => ppClient.timerReset(id.trim()))}
          disabled={disabled || empty}
          className="btn-tap rounded-lg border border-border px-2 py-2 text-xs font-semibold disabled:opacity-40"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
