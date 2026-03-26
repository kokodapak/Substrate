interface ErrorStateProps {
  message: string;
  onRetry?: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <p className="text-red-400 font-medium">Error: {message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-4 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-sm text-gray-200 rounded-md border border-gray-700 transition-colors"
        >
          Retry
        </button>
      )}
    </div>
  );
}
