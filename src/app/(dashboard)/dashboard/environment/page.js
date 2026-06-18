"use client";

import { useEffect, useState, useMemo } from "react";
import { Card, CardSkeleton } from "@/shared/components";

export default function EnvironmentPage() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState({ categories: [], vars: [] });
  const [filter, setFilter] = useState("");
  const [revealed, setRevealed] = useState(() => new Set());
  const [showOnlySet, setShowOnlySet] = useState(false);

  useEffect(() => {
    fetch("/api/settings/environment", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const grouped = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const out = new Map();
    for (const v of data.vars) {
      if (showOnlySet && !v.isSet) continue;
      if (needle && !`${v.name} ${v.desc}`.toLowerCase().includes(needle)) continue;
      const arr = out.get(v.category) || [];
      arr.push(v);
      out.set(v.category, arr);
    }
    return out;
  }, [data.vars, filter, showOnlySet]);

  const totalSet = data.vars.filter((v) => v.isSet).length;

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Environment</h1>
        <p className="text-sm text-text-muted">
          Every environment variable kRouter recognizes, what it does, and whether it's currently set on this process.
          Secrets are masked — click the eye icon to reveal.{" "}
          <span className="text-text-main font-medium">{totalSet}/{data.vars.length} set.</span>
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-3 sm:items-center">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search by name or description…"
          className="flex-1 px-3 py-2 rounded-lg bg-surface-2 border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
        />
        <label className="flex items-center gap-2 text-sm text-text-muted whitespace-nowrap cursor-pointer">
          <input
            type="checkbox"
            checked={showOnlySet}
            onChange={(e) => setShowOnlySet(e.target.checked)}
            className="size-4 accent-primary"
          />
          Only show set
        </label>
      </div>

      <div className="flex flex-col gap-4">
        {data.categories.map((cat) => {
          const vars = grouped.get(cat.key) || [];
          if (vars.length === 0) return null;
          return (
            <Card key={cat.key} padding="sm">
              <div className="flex items-center gap-2 mb-3">
                <span className="material-symbols-outlined text-primary text-[20px]">{cat.icon}</span>
                <h2 className="text-base font-semibold">{cat.label}</h2>
                <span className="text-xs text-text-muted">({vars.length})</span>
              </div>
              <div className="flex flex-col gap-1.5">
                {vars.map((v) => (
                  <EnvVarRow
                    key={v.name}
                    v={v}
                    revealed={revealed.has(v.name)}
                    onToggleReveal={() => {
                      const next = new Set(revealed);
                      next.has(v.name) ? next.delete(v.name) : next.add(v.name);
                      setRevealed(next);
                    }}
                  />
                ))}
              </div>
            </Card>
          );
        })}
        {grouped.size === 0 && (
          <Card padding="sm">
            <p className="text-sm text-text-muted text-center py-4">No env vars match the current filter.</p>
          </Card>
        )}
      </div>
    </div>
  );
}

function EnvVarRow({ v, revealed, onToggleReveal }) {
  const showActual = v.isSet && v.secret && revealed;
  return (
    <div
      className={`flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-3 rounded-md px-2 py-2 ${
        v.deprecated
          ? "bg-amber-500/[0.04] border border-amber-500/20"
          : v.isSet
            ? "bg-green-500/[0.03] border border-transparent"
            : "border border-transparent"
      }`}
    >
      <div className="flex items-center gap-2 min-w-0 sm:w-[280px] shrink-0">
        <code className="text-xs font-mono font-medium truncate">{v.name}</code>
        {v.deprecated && (
          <span className="text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 shrink-0">
            deprecated
          </span>
        )}
        {v.isSet && (
          <span className="text-[10px] uppercase tracking-wide font-bold px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400 shrink-0">
            set
          </span>
        )}
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <p className="text-xs text-text-muted">{v.desc}</p>
        <div className="flex items-center gap-2 min-w-0">
          {v.isSet ? (
            <>
              <code className="text-xs font-mono truncate bg-black/5 dark:bg-white/5 px-1.5 py-0.5 rounded">
                {showActual ? v.value : v.value}
              </code>
              {v.secret && (
                <button
                  onClick={onToggleReveal}
                  className="shrink-0 text-text-muted hover:text-primary transition-colors"
                  title={revealed ? "Hide value" : "Reveal (still masked)"}
                >
                  <span className="material-symbols-outlined text-[16px]">
                    {revealed ? "visibility_off" : "visibility"}
                  </span>
                </button>
              )}
            </>
          ) : (
            <span className="text-xs text-text-muted italic">
              default: <code className="font-mono">{v.default}</code>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
