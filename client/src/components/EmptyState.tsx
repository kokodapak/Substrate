interface EmptyStateProps {
  message: string;
  hint?: string;
}

export function EmptyState({ message, hint }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <p className="text-gray-300 font-medium">{message}</p>
      {hint && <p className="mt-2 text-sm text-gray-500">{hint}</p>}
    </div>
  );
}
