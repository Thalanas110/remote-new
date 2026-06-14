import { useEffect, useState } from "react";
import { ppClient, type PpState, defaultPpState } from "@/lib/propresenter-client";
import {
  ChevronLeft,
  ChevronRight,
  Square,
  Image,
  MessageSquare,
  Music,
  Layers,
  Presentation,
} from "lucide-react";

export function ProPresenterPanel() {
  const [s, setS] = useState<PpState>(defaultPpState);
  useEffect(() => {
    const u = ppClient.subscribe(setS);
    return () => {
      u();
    };
  }, []);
  const offline = !s.connected;

  const call = (fn: () => Promise<unknown> | unknown) => () =>
    Promise.resolve(fn()).catch(console.error);

  return (
    <section className="glass flex h-full min-h-0 flex-col rounded-2xl p-4 sm:p-5">
      <header className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl"
            style={{
              background: "color-mix(in oklab, var(--pp) 22%, transparent)",
              color: "var(--pp)",
            }}
          >
            <Presentation className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold tracking-tight">ProPresenter</h2>
            <p className="truncate text-[11px] text-muted-foreground">
              {s.version || "REST API · :1025"}
            </p>
          </div>
        </div>
        <span
          className="pill"
          style={{
            background: s.connected
              ? "color-mix(in oklab, var(--pp) 18%, transparent)"
              : "color-mix(in oklab, white 6%, transparent)",
            color: s.connected ? "var(--pp)" : "var(--muted-foreground)",
          }}
        >
          <span
            className="dot"
            style={{ background: s.connected ? "var(--pp)" : "var(--muted-foreground)" }}
          />
          {s.connected ? "Online" : "Offline"}
        </span>
      </header>

      {offline && (
        <div className="mt-3 rounded-xl border border-dashed border-border bg-card/60 px-3 py-2 text-xs text-muted-foreground">
          ProPresenter is disconnected. The OBS panel can still be used if it is online.
        </div>
      )}

      <div
        className="mt-4 rounded-xl border border-border p-4"
        style={{ background: "color-mix(in oklab, var(--pp) 8%, var(--card))" }}
      >
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Active Presentation
        </div>
        <div className="mt-1 truncate text-base font-bold">
          {s.activePresentationName || (s.connected ? "—" : "Not connected")}
        </div>
        <div className="mt-1 font-mono text-xs text-muted-foreground">
          Slide {typeof s.currentSlideIndex === "number" ? s.currentSlideIndex + 1 : "—"}
          {s.totalSlides ? ` / ${s.totalSlides}` : ""}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          onClick={call(() => ppClient.prev())}
          disabled={offline}
          className="btn-tap flex items-center justify-center gap-2 rounded-2xl border border-border py-5 text-sm font-bold uppercase tracking-wider disabled:opacity-40"
          style={{ background: "color-mix(in oklab, var(--card) 80%, transparent)" }}
        >
          <ChevronLeft className="h-5 w-5" /> Prev
        </button>
        <button
          onClick={call(() => ppClient.next())}
          disabled={offline}
          className="btn-tap flex items-center justify-center gap-2 rounded-2xl py-5 text-sm font-bold uppercase tracking-wider text-[var(--primary-foreground)] disabled:opacity-40"
          style={{
            background:
              "linear-gradient(135deg, var(--pp), color-mix(in oklab, var(--pp) 60%, var(--primary)))",
          }}
        >
          Next <ChevronRight className="h-5 w-5" />
        </button>
      </div>

      <div className="mt-4">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Clear Layers
        </h3>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-3">
          <ClearBtn
            onClick={call(() => ppClient.clearSlide())}
            disabled={offline}
            icon={<Layers className="h-4 w-4" />}
            label="Slide"
          />
          <ClearBtn
            onClick={call(() => ppClient.clearProps())}
            disabled={offline}
            icon={<Image className="h-4 w-4" />}
            label="Props"
          />
          <ClearBtn
            onClick={call(() => ppClient.clearMessages())}
            disabled={offline}
            icon={<MessageSquare className="h-4 w-4" />}
            label="Msgs"
          />
          <ClearBtn
            onClick={call(() => ppClient.clearAudio())}
            disabled={offline}
            icon={<Music className="h-4 w-4" />}
            label="Audio"
          />
          <ClearBtn
            onClick={call(() => ppClient.clearAnnouncements())}
            disabled={offline}
            icon={<MessageSquare className="h-4 w-4" />}
            label="Annc"
          />
          <button
            onClick={call(() => ppClient.clearAll())}
            disabled={offline}
            className="btn-tap col-span-1 flex items-center justify-center gap-1.5 rounded-xl border px-2 py-2.5 text-xs font-bold disabled:opacity-40"
            style={{
              background: "color-mix(in oklab, var(--destructive) 20%, var(--card))",
              borderColor: "color-mix(in oklab, var(--destructive) 50%, transparent)",
              color: "var(--destructive)",
            }}
          >
            <Square className="h-4 w-4 fill-current" /> All
          </button>
        </div>
      </div>

      <div className="mt-4">
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Timer (by id/name)
        </h3>
        <TimerControls disabled={offline} />
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
      className="btn-tap flex items-center justify-center gap-1.5 rounded-xl border border-border px-2 py-2.5 text-xs font-semibold disabled:opacity-40"
      style={{ background: "color-mix(in oklab, var(--card) 80%, transparent)" }}
    >
      {icon} {label}
    </button>
  );
}

function TimerControls({ disabled }: { disabled: boolean }) {
  const [id, setId] = useState("");
  const call = (fn: () => Promise<unknown>) => () => fn().catch(console.error);
  return (
    <div className="flex gap-2">
      <input
        value={id}
        onChange={(e) => setId(e.target.value)}
        placeholder="Timer name or UUID"
        className="min-w-0 flex-1 rounded-xl border border-border bg-[color-mix(in_oklab,var(--card)_80%,transparent)] px-3 py-2 text-xs outline-none focus:border-[var(--pp)]"
      />
      <button
        onClick={call(() => ppClient.timerStart(id))}
        disabled={disabled || !id}
        className="btn-tap rounded-xl border border-border px-3 py-2 text-xs font-semibold disabled:opacity-40"
        style={{ color: "var(--pp)" }}
      >
        Start
      </button>
      <button
        onClick={call(() => ppClient.timerStop(id))}
        disabled={disabled || !id}
        className="btn-tap rounded-xl border border-border px-3 py-2 text-xs font-semibold disabled:opacity-40"
      >
        Stop
      </button>
      <button
        onClick={call(() => ppClient.timerReset(id))}
        disabled={disabled || !id}
        className="btn-tap rounded-xl border border-border px-3 py-2 text-xs font-semibold disabled:opacity-40"
      >
        Reset
      </button>
    </div>
  );
}
