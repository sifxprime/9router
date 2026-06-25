"use client";

import { cn } from "@/shared/utils/cn";
import { formatResetTime } from "./utils";

// Calculate color based on remaining percentage
const getColorClasses = (remainingPercentage) => {
  if (remainingPercentage > 70) {
    return {
      text: "text-green-500",
      bg: "bg-green-500",
      bgLight: "bg-green-500/10",
      emoji: "🟢"
    };
  }
  
  if (remainingPercentage >= 30) {
    return {
      text: "text-yellow-500",
      bg: "bg-yellow-500",
      bgLight: "bg-yellow-500/10",
      emoji: "🟡"
    };
  }
  
  // 0-29% including 0% (out of quota) - show red
  return {
    text: "text-red-500",
    bg: "bg-red-500",
    bgLight: "bg-red-500/10",
    emoji: "🔴"
  };
};

// Format reset time display
const formatResetTimeDisplay = (resetTime) => {
  if (!resetTime) return null;
  
  try {
    const resetDate = new Date(resetTime);
    const now = new Date();
    const isToday = resetDate.toDateString() === now.toDateString();
    const isTomorrow = resetDate.toDateString() === new Date(now.getTime() + 86400000).toDateString();
    
    const timeStr = resetDate.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
    
    if (isToday) return `Today, ${timeStr}`;
    if (isTomorrow) return `Tomorrow, ${timeStr}`;
    
    return resetDate.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return null;
  }
};

export default function QuotaProgressBar({
  percentage = 0,
  label = "",
  used = 0,
  total = 0,
  unlimited = false,
  resetTime = null,
  exhaustedAwaitingReset = false
}) {
  const colors = getColorClasses(percentage);
  const countdown = formatResetTime(resetTime);
  const resetDisplay = formatResetTimeDisplay(resetTime);

  // percentage is already remaining percentage (from ProviderLimitCard)
  const remaining = percentage;

  // 0.5.56 — Google's fetchAvailableModels omits remainingFraction on quota-
  // exhausted Claude models; we only know the resetTime. Render that state
  // explicitly instead of faking a 100%-used red bar.
  if (exhaustedAwaitingReset) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="font-semibold text-text-primary">{label}</span>
          <span className="font-medium text-amber-500 text-xs">Exhausted</span>
        </div>
        <div className="h-2 rounded-full overflow-hidden bg-amber-500/10">
          <div className="h-full bg-amber-500/40" style={{ width: "100%" }} />
        </div>
        <div className="text-xs text-text-muted/80 italic">
          Awaiting reset{countdown !== "-" ? ` in ${countdown}` : ""}
          {resetDisplay ? ` (at ${resetDisplay})` : ""}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Label and percentage */}
      <div className="flex items-center justify-between text-sm">
        <span className="font-semibold text-text-primary">
          {label}
        </span>
        <div className="flex items-center gap-1.5">
          <span className="text-xs">{colors.emoji}</span>
          <span className={cn("font-medium", colors.text)}>
            {remaining}%
          </span>
        </div>
      </div>

      {/* Progress bar */}
      {!unlimited && (
        <div className={cn("h-2 rounded-full overflow-hidden", colors.bgLight)}>
          <div
            className={cn("h-full transition-all duration-300", colors.bg)}
            style={{ width: `${Math.min(remaining, 100)}%` }}
          />
        </div>
      )}

      {/* Usage details and countdown */}
      <div className="flex items-center justify-between text-xs text-text-muted">
        <span>
          {/* Percentage-only quotas (Antigravity/Gemini/Claude — total=100 means
              the upstream API only exposes a fraction, not raw counts) display
              as "X% used" instead of "X / 100 requests" which misleads users
              into thinking 100 is a real cap. */}
          {total === 100
            ? `${used}% used`
            : `${used.toLocaleString()} / ${total.toLocaleString()} requests`}
        </span>
        {countdown !== "-" && (
          <div className="flex items-center gap-1">
            <span>•</span>
            <span className="font-medium">Reset in {countdown}</span>
          </div>
        )}
      </div>

      {/* Reset time display */}
      {resetDisplay && (
        <div className="text-xs text-text-muted/70">
          Reset at {resetDisplay}
        </div>
      )}
    </div>
  );
}
