import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ObsPanel } from "@/components/ObsPanel";
import { ProPresenterPanel } from "@/components/ProPresenterPanel";
import { ConnectionSettings } from "@/components/ConnectionSettings";
import { obsClient } from "@/lib/obs-client";
import { ppClient } from "@/lib/propresenter-client";
import { Settings, Zap, Radio, Presentation } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Stage Deck · OBS + ProPresenter Remote" },
      {
        name: "description",
        content:
          "A tablet-first remote control for OBS Studio and ProPresenter. Use either connection independently.",
      },
    ],
  }),
  component: Index,
});

function Index() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [obsOn, setObsOn] = useState(false);
  const [ppOn, setPpOn] = useState(false);
  const anyOn = obsOn || ppOn;

  useEffect(() => {
    const a = obsClient.subscribe((s) => setObsOn(s.connected));
    const b = ppClient.subscribe((s) => setPpOn(s.connected));
    return () => {
      a();
      b();
    };
  }, []);

  return (
    <main className="mx-auto flex h-[100dvh] max-w-[1400px] flex-col gap-3 overflow-y-auto p-3 sm:p-5">
      <header className="glass grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-2xl px-4 py-3 sm:flex sm:flex-wrap sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl"
            style={{ background: "linear-gradient(135deg, var(--obs), var(--pp))" }}
          >
            <Zap className="h-5 w-5 text-[var(--primary-foreground)]" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-black tracking-tight sm:text-lg">Stage Deck</h1>
            <p className="truncate text-[11px] text-muted-foreground">OBS or ProPresenter remote</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ConnDot label="OBS" on={obsOn} color="var(--obs)" />
          <ConnDot label="PP" on={ppOn} color="var(--pp)" />
          <button
            onClick={() => setSettingsOpen(true)}
            className="btn-tap inline-flex items-center gap-1.5 rounded-xl border border-border bg-card/60 px-3 py-2 text-xs font-semibold"
          >
            <Settings className="h-3.5 w-3.5" />{" "}
            <span className="hidden sm:inline">Connections</span>
          </button>
        </div>
      </header>

      {anyOn ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-2">
          <ObsPanel />
          <ProPresenterPanel />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4 py-10 text-center">
          <div className="relative">
            <div
              className="absolute inset-0 rounded-full blur-3xl"
              style={{ background: "color-mix(in oklab, var(--obs) 25%, transparent)" }}
            />
            <div
              className="relative grid h-16 w-16 place-items-center rounded-2xl"
              style={{ background: "linear-gradient(135deg, var(--obs), var(--pp))" }}
            >
              <Zap className="h-8 w-8 text-[var(--primary-foreground)]" />
            </div>
          </div>
          <div className="max-w-sm">
            <h2 className="text-xl font-black tracking-tight">Connect your booth</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Stage Deck works with either OBS Studio (WebSocket) or ProPresenter (Network API).
              Connect one or both to unlock the matching controls.
            </p>
          </div>
          <div className="flex w-full max-w-lg flex-col gap-3 sm:flex-row">
            <button
              onClick={() => setSettingsOpen(true)}
              className="btn-tap inline-flex flex-1 items-center justify-center gap-2 rounded-2xl px-5 py-4 text-sm font-bold"
              style={{ background: "var(--obs)", color: "var(--primary-foreground)" }}
            >
              <Radio className="h-4 w-4" /> Connect OBS
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              className="btn-tap inline-flex flex-1 items-center justify-center gap-2 rounded-2xl px-5 py-4 text-sm font-bold"
              style={{ background: "var(--pp)", color: "var(--primary-foreground)" }}
            >
              <Presentation className="h-4 w-4" /> Connect ProPresenter
            </button>
          </div>
          <p className="text-xs text-muted-foreground">Settings are saved to this device.</p>
        </div>
      )}

      <ConnectionSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </main>
  );
}

function ConnDot({ label, on, color }: { label: string; on: boolean; color: string }) {
  return (
    <span
      className="pill"
      style={{
        background: on
          ? `color-mix(in oklab, ${color} 18%, transparent)`
          : "color-mix(in oklab, white 6%, transparent)",
        color: on ? color : "var(--muted-foreground)",
      }}
    >
      <span
        className="dot"
        style={{
          background: on ? color : "var(--muted-foreground)",
          boxShadow: on ? `0 0 8px ${color}` : undefined,
        }}
      />
      {label}
    </span>
  );
}
