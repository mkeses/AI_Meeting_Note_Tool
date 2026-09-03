import { useCallback, useEffect, useState } from 'react';
import { clearCsrfToken, fetchApi, refreshCsrfToken } from '../api';

export type AuthUser = {
  id: string;
  login: string;
  createdAt: string;
};

export type AuthStatus =
  | 'checking'
  | 'local'
  | 'authenticated'
  | 'unauthenticated'
  | 'unavailable';

type AuthAction = 'login' | 'register';

function isAuthUser(value: unknown): value is AuthUser {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const user = value as Record<string, unknown>;
  return (
    typeof user.id === 'string' &&
    typeof user.login === 'string' &&
    typeof user.createdAt === 'string'
  );
}

async function authRequest(
  path: string,
  init?: RequestInit
): Promise<Response> {
  return fetchApi(path, init);
}

function messageFor(action: AuthAction, status: number): string {
  if (action === 'login' && status === 401) {
    return 'Invalid login or password.';
  }

  if (action === 'register' && status === 409) {
    return 'That login is already in use.';
  }

  if (status === 422) {
    return 'Enter a valid login and password.';
  }

  return 'Unable to complete that request. Please try again.';
}

export function useAuth() {
  const [status, setStatus] = useState<AuthStatus>('checking');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const refresh = useCallback(async () => {
    clearCsrfToken();
    setStatus('checking');
    setError(null);

    try {
      const response = await authRequest('/api/auth/me');

      if (response.status === 404) {
        setUser(null);
        setStatus('local');
        return;
      }

      if (response.status === 401) {
        await refreshCsrfToken();
        setUser(null);
        setStatus('unauthenticated');
        return;
      }

      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      const responseUser: unknown = await response.json();
      if (!isAuthUser(responseUser)) {
        throw new Error('Authentication API returned invalid user data');
      }

      await refreshCsrfToken();
      setUser(responseUser);
      setStatus('authenticated');
    } catch (requestError) {
      console.error('Failed to check authentication session:', requestError);
      setUser(null);
      setStatus('unavailable');
      setError('The sign-in service is unavailable. Please try again.');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submitCredentials = useCallback(
    async (action: AuthAction, login: string, password: string) => {
      setIsSubmitting(true);
      setError(null);
      setMessage(null);

      try {
        const response = await authRequest(`/api/auth/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ login, password }),
        });

        if (!response.ok) {
          setError(messageFor(action, response.status));
          return false;
        }

        if (action === 'register') {
          setMessage('Account created. Sign in to open your workspace.');
          setStatus('unauthenticated');
          return true;
        }

        const responseUser: unknown = await response.json();
        if (!isAuthUser(responseUser)) {
          throw new Error('Authentication API returned invalid user data');
        }

        await refreshCsrfToken();
        setUser(responseUser);
        setStatus('authenticated');
        return true;
      } catch (requestError) {
        console.error(`Failed to ${action}:`, requestError);
        setError('Unable to complete that request. Please try again.');
        return false;
      } finally {
        setIsSubmitting(false);
      }
    },
    []
  );

  const login = useCallback(
    (loginValue: string, password: string) =>
      submitCredentials('login', loginValue, password),
    [submitCredentials]
  );

  const register = useCallback(
    (loginValue: string, password: string) =>
      submitCredentials('register', loginValue, password),
    [submitCredentials]
  );

  const logout = useCallback(async () => {
    try {
      await authRequest('/api/auth/logout', { method: 'POST' });
    } catch (logoutError) {
      console.error('Failed to end authentication session:', logoutError);
    } finally {
      clearCsrfToken();
      setUser(null);
      setStatus('unauthenticated');
      setMessage(null);
      setError(null);
    }
  }, []);

  const handleUnauthenticated = useCallback(() => {
    setUser(null);
    setStatus('unauthenticated');
    setError('Your session has expired. Sign in to continue.');
  }, []);

  return {
    status,
    user,
    error,
    message,
    isSubmitting,
    login,
    register,
    logout,
    refresh,
    handleUnauthenticated,
  };
}
