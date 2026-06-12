export function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024));
  const idx = Math.min(i, units.length - 1);
  return `${(bytes / Math.pow(1024, idx)).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

export function formatCompressionDisplay(stats, kind) {
  const ratio = stats?.ratio ?? 0;
  return {
    headline: `${(ratio * 100).toFixed(1)}% saved`,
    subline: kind || "",
  };
}

export default function CompressionStatRow({ stats, proxyStats, children }) {
  return (
    <div className="flex items-center gap-4 text-sm">
      {stats && (
        <span className="text-text-muted">
          {formatBytes(stats.bytesSaved || 0)} saved
        </span>
      )}
      {children}
    </div>
  );
}
