"use client";

import { useEffect, useState } from "react";
import PropTypes from "prop-types";
import Card from "./Card";
import Input from "./Input";
import Select from "./Select";
import Badge from "./Badge";
import { AI_PROVIDERS } from "@/shared/constants/providers";

const NONE_PROXY_POOL_VALUE = "__none__";

export default function NoAuthProxyCard({ providerId }) {
  const [proxyPools, setProxyPools] = useState([]);
  const [proxyPoolId, setProxyPoolId] = useState(NONE_PROXY_POOL_VALUE);
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState(null);

  const providerInfo = AI_PROVIDERS[providerId];
  const defaultBaseUrl = providerInfo?.searchConfig?.baseUrl || "";
  const hasLiveCatalog = providerInfo?.passthroughModels === true || !!providerInfo?.modelsFetcher;

  const handleRefreshModels = async () => {
    setRefreshing(true);
    setRefreshResult(null);
    try {
      const res = await fetch(`/api/providers/${providerId}/models`, { cache: "no-store" });
      const data = res.ok ? await res.json() : null;
      if (res.ok && Array.isArray(data?.models)) {
        setRefreshResult({ kind: "ok", count: data.models.length });
      } else {
        setRefreshResult({ kind: "err", message: data?.error || `HTTP ${res.status}` });
      }
    } catch (e) {
      setRefreshResult({ kind: "err", message: e.message });
    } finally {
      setRefreshing(false);
      setTimeout(() => setRefreshResult(null), 4000);
    }
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/proxy-pools?isActive=true", { cache: "no-store" }).then((r) => r.ok ? r.json() : { proxyPools: [] }),
      fetch("/api/settings", { cache: "no-store" }).then((r) => r.ok ? r.json() : {}),
    ]).then(([poolData, settingsData]) => {
      if (cancelled) return;
      setProxyPools(poolData.proxyPools || []);
      const override = (settingsData.providerStrategies || {})[providerId] || {};
      setProxyPoolId(override.proxyPoolId || NONE_PROXY_POOL_VALUE);
      setCustomBaseUrl(override.baseUrl || "");
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [providerId]);

  const patchProviderStrategy = async (patch) => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", { cache: "no-store" });
      const data = res.ok ? await res.json() : {};
      const current = data.providerStrategies || {};
      const override = { ...(current[providerId] || {}), ...patch };
      for (const k of Object.keys(override)) {
        if (override[k] === undefined || override[k] === NONE_PROXY_POOL_VALUE) delete override[k];
      }
      const updated = { ...current };
      if (Object.keys(override).length === 0) delete updated[providerId];
      else updated[providerId] = override;
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerStrategies: updated }),
      });
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      console.log("Save provider strategy error:", e);
    } finally {
      setSaving(false);
    }
  };

  const handleChange = async (newValue) => {
    setProxyPoolId(newValue);
    await patchProviderStrategy({ proxyPoolId: newValue === NONE_PROXY_POOL_VALUE ? undefined : newValue });
  };

  const handleBaseUrlSave = async () => {
    const trimmed = customBaseUrl.trim();
    await patchProviderStrategy({ baseUrl: trimmed || undefined });
  };

  return (
    <Card>
      <div className="flex items-center gap-3 mb-4">
        <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-green-500/10 text-green-500">
          <span className="material-symbols-outlined text-[20px]">lock_open</span>
        </div>
        <div className="flex-1">
          <p className="text-sm font-medium">No authentication required</p>
          <p className="text-xs text-text-muted">This provider is ready to use. Optionally route requests through a proxy pool to bypass IP-based limits.</p>
        </div>
        {savedFlash && <Badge variant="success" size="sm">Saved</Badge>}
      </div>
      <Select
        label="Proxy Pool"
        value={proxyPoolId}
        onChange={(e) => handleChange(e.target.value)}
        disabled={saving}
        options={[
          { value: NONE_PROXY_POOL_VALUE, label: "None (direct)" },
          ...proxyPools.map((pool) => ({ value: pool.id, label: pool.name })),
        ]}
      />
      {defaultBaseUrl && (
        <div className="mt-4">
          <Input
            label="Base URL"
            placeholder={defaultBaseUrl}
            value={customBaseUrl}
            onChange={(e) => setCustomBaseUrl(e.target.value)}
            onBlur={handleBaseUrlSave}
            disabled={saving}
          />
          <p className="text-xs text-text-muted mt-1">
            Default: {defaultBaseUrl}
          </p>
        </div>
      )}
      {hasLiveCatalog && (
        <div className="mt-4 pt-4 border-t border-border">
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1">
              <p className="text-sm font-medium">Live model catalog</p>
              <p className="text-xs text-text-muted">
                Pulled from upstream. Refresh to pick up new free-promo models the vendor just released.
              </p>
            </div>
            <button
              type="button"
              onClick={handleRefreshModels}
              disabled={refreshing}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium bg-surface-elevated border border-border hover:bg-surface-hover disabled:opacity-50"
            >
              <span className="material-symbols-outlined text-[16px]">refresh</span>
              {refreshing ? "Refreshing..." : "Refresh Models"}
            </button>
          </div>
          {refreshResult?.kind === "ok" && (
            <p className="text-xs text-green-500 mt-2">Found {refreshResult.count} model{refreshResult.count === 1 ? "" : "s"} from upstream.</p>
          )}
          {refreshResult?.kind === "err" && (
            <p className="text-xs text-red-500 mt-2">Failed: {refreshResult.message}</p>
          )}
        </div>
      )}
    </Card>
  );
}

NoAuthProxyCard.propTypes = {
  providerId: PropTypes.string.isRequired,
};
