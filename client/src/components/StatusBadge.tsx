interface StatusBadgeProps {
  value: string | null;
  type?: 'severity' | 'status' | 'service';
}

function severityClasses(value: string): string {
  switch (value.toLowerCase()) {
    case 'critical': return 'bg-red-500/20 text-red-400 border-red-500/30';
    case 'high':     return 'bg-orange-500/20 text-orange-400 border-orange-500/30';
    case 'medium':   return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
    case 'low':      return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
    default:         return 'bg-gray-700/50 text-gray-400 border-gray-600/30';
  }
}

function statusClasses(value: string): string {
  switch (value.toLowerCase()) {
    case 'open':         return 'bg-red-500/20 text-red-400 border-red-500/30';
    case 'acknowledged': return 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30';
    case 'resolved':     return 'bg-green-500/20 text-green-400 border-green-500/30';
    case 'running':      return 'bg-green-500/20 text-green-400 border-green-500/30';
    case 'stopped':      return 'bg-gray-600/40 text-gray-400 border-gray-600/30';
    case 'exited':       return 'bg-red-500/20 text-red-400 border-red-500/30';
    default:             return 'bg-gray-700/50 text-gray-400 border-gray-600/30';
  }
}

export function StatusBadge({ value, type = 'severity' }: StatusBadgeProps) {
  const label = value ?? 'unknown';
  const classes =
    type === 'severity'
      ? severityClasses(label)
      : statusClasses(label);

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${classes}`}
    >
      {label}
    </span>
  );
}
