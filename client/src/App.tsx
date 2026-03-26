import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';
import { OverviewPage } from './pages/OverviewPage';
import { RemediationPage } from './pages/RemediationPage';
import { AccessPage } from './pages/AccessPage';
import { TimelinePage } from './pages/TimelinePage';
import { SettingsPage } from './pages/SettingsPage';
import { FederationPage } from './pages/FederationPage';
import { RuleRegistryPage } from './pages/RuleRegistryPage';

function LoginGate() {
  const { setApiKey } = useAuth();
  const [input, setInput] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (input.trim()) setApiKey(input.trim());
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="w-full max-w-sm bg-gray-900 border border-gray-800 rounded-xl p-8 shadow-2xl">
        <h1 className="text-xl font-semibold text-gray-100 mb-1">Substrate</h1>
        <p className="text-sm text-gray-400 mb-6">Enter your API key to continue.</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="X-Api-Key"
            className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-600"
            autoFocus
          />
          <button
            type="submit"
            className="w-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-md py-2 transition-colors"
          >
            Enter
          </button>
        </form>
      </div>
    </div>
  );
}

function ProtectedRoutes() {
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) return <LoginGate />;

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/overview" replace />} />
      <Route path="/overview" element={<OverviewPage />} />
      <Route path="/remediation" element={<RemediationPage />} />
      <Route path="/access" element={<AccessPage />} />
      <Route path="/timeline" element={<TimelinePage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/federation" element={<FederationPage />} />
      <Route path="/rule-registry" element={<RuleRegistryPage />} />
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <ProtectedRoutes />
    </BrowserRouter>
  );
}
