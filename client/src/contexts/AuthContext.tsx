import { createContext, useContext, useState, ReactNode } from 'react';

interface AuthContextValue {
  apiKey: string;
  setApiKey: (key: string) => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [apiKey, setApiKeyState] = useState<string>(
    () => localStorage.getItem('substrate_api_key') ?? ''
  );

  function setApiKey(key: string) {
    localStorage.setItem('substrate_api_key', key);
    setApiKeyState(key);
  }

  return (
    <AuthContext.Provider
      value={{
        apiKey,
        setApiKey,
        isAuthenticated: apiKey.length > 0,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
