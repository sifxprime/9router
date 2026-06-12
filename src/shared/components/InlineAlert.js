export default function InlineAlert({ children, type = "info" }) {
  const colors = {
    info: "text-blue-600 bg-blue-50 border-blue-200",
    warning: "text-amber-600 bg-amber-50 border-amber-200",
    error: "text-red-600 bg-red-50 border-red-200",
    success: "text-green-600 bg-green-50 border-green-200",
  };
  return (
    <div className={`px-3 py-2 rounded-lg border text-sm ${colors[type] || colors.info}`}>
      {children}
    </div>
  );
}
