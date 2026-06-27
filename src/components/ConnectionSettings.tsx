import { useEffect, useState } from "react";
import { obsClient } from "@/lib/obs-client";
import { defaultPpState, ppClient, type PpState } from "@/lib/propresenter-client";
import { normalizeProPresenterBaseUrl } from "@/lib/propresenter-contract";
import { X, Plug, Loader2 } from "lucide-react";

const LS_KEY = "remote.config.v1";

type Config = {
  obsUrl: string;
  obsPassword: string;
  ppUrl: string;
};

const DEFAULTS: Config = {
  obsUrl: "ws://127.0.0.1:4455",
  obsPassword: "",
  ppUrl: "http://127.0.0.1:50001",
};

function load(): Config {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(LS_KEY) || "{}") };
  } catch {
    return DEFAULTS;
  }
}

export function ConnectionSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [cfg, setCfg] = useState<Config>(DEFAULTS);
  const [busy, setBusy] = useState<"obs" | "pp" | null>(null);
  const [obsErr, setObsErr] = useState<string>();
  const [ppErr, setPpErr] = useState<string>();
  const [ppState, setPpState] = useState<PpState>(defaultPpState);

  useEffect(() => {
    setCfg(load());
  }, [open]);

  useEffect(() => {
    const unsubscribe = ppClient.subscribe(setPpState);
    return () => {
      unsubscribe();
    };
  }, []);

  const save = (next: Config) => {
    setCfg(next);
    localStorage.setItem(LS_KEY, JSON.stringify(next));
  };

  const connectObs = async () => {
    setBusy("obs");
    setObsErr(undefined);
    try {
      await obsClient.connect({ url: cfg.obsUrl, password: cfg.obsPassword });
    } catch (e: any) {
      setObsErr(e?.message || "Failed");
    } finally {
      setBusy(null);
    }
  };

  const connectPp = async () => {
    setBusy("pp");
    setPpErr(undefined);
    try {
      const baseUrl = normalizeProPresenterBaseUrl(cfg.ppUrl);
      save({ ...cfg, ppUrl: baseUrl });
      await ppClient.connect({ baseUrl });
    } catch (error) {
      setPpErr(error instanceof Error ? error.message : "Failed to connect");
    } finally {
      setBusy(null);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-3 sm:items-center"
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} className="glass w-full max-w-lg rounded-2xl p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold tracking-tight">Connections</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-white/5">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div
          className="mt-4 rounded-xl border border-border p-4"
          style={{ background: "color-mix(in oklab, var(--obs) 6%, var(--card))" }}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold" style={{ color: "var(--obs)" }}>
              OBS WebSocket
            </h3>
            <button
              onClick={() => {
                void obsClient.disconnect();
              }}
              className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
            >
              Disconnect
            </button>
          </div>
          <label className="mt-3 block text-[11px] uppercase tracking-wider text-muted-foreground">
            WebSocket URL
          </label>
          <input
            value={cfg.obsUrl}
            onChange={(e) => save({ ...cfg, obsUrl: e.target.value })}
            className="mt-1 w-full rounded-lg border border-border bg-input/40 px-3 py-2 text-sm outline-none focus:border-[var(--obs)]"
            placeholder="ws://127.0.0.1:4455"
          />
          <label className="mt-3 block text-[11px] uppercase tracking-wider text-muted-foreground">
            Password
          </label>
          <input
            type="password"
            value={cfg.obsPassword}
            onChange={(e) => save({ ...cfg, obsPassword: e.target.value })}
            className="mt-1 w-full rounded-lg border border-border bg-input/40 px-3 py-2 text-sm outline-none focus:border-[var(--obs)]"
            placeholder="(optional)"
          />
          {obsErr && <p className="mt-2 text-xs text-destructive">{obsErr}</p>}
          <button
            onClick={connectObs}
            disabled={busy === "obs"}
            className="btn-tap mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold disabled:opacity-40"
            style={{ background: "var(--obs)", color: "var(--primary-foreground)" }}
          >
            {busy === "obs" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plug className="h-3.5 w-3.5" />
            )}{" "}
            Connect OBS
          </button>
        </div>

        <div
          className="mt-3 rounded-xl border border-border p-4"
          style={{ background: "color-mix(in oklab, var(--pp) 6%, var(--card))" }}
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold" style={{ color: "var(--pp)" }}>
              ProPresenter API
            </h3>
            <button
              onClick={() => {
                ppClient.disconnect();
              }}
              className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
            >
              Disconnect
            </button>
          </div>
          <label className="mt-3 block text-[11px] uppercase tracking-wider text-muted-foreground">
            Base URL
          </label>
          <input
            value={cfg.ppUrl}
            onChange={(e) => save({ ...cfg, ppUrl: e.target.value })}
            className="mt-1 w-full rounded-lg border border-border bg-input/40 px-3 py-2 text-sm outline-none focus:border-[var(--pp)]"
            placeholder="http://192.168.1.20:50001"
          />
          {ppState.connected && (
            <p className="mt-2 text-xs" style={{ color: "var(--pp)" }}>
              Connected to {ppState.machineName || "ProPresenter"}
              {ppState.degraded ? " · Degraded" : ""}
            </p>
          )}
          {ppErr && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {ppErr}
            </p>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            Enable <span className="font-semibold">Network</span> in ProPresenter
            {" -> "}Preferences{" -> "}Network. Stage Deck now relays these requests through its own
            app server, so the machine hosting this app still needs network access to the
            ProPresenter host on port 50001.
          </p>
          <button
            onClick={connectPp}
            disabled={busy === "pp"}
            className="btn-tap mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-bold disabled:opacity-40"
            style={{ background: "var(--pp)", color: "var(--primary-foreground)" }}
          >
            {busy === "pp" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plug className="h-3.5 w-3.5" />
            )}{" "}
            Connect ProPresenter
          </button>
        </div>

        <p className="mt-4 text-[11px] text-muted-foreground">Settings persist on this device.</p>
      </div>
    </div>
  );
}
