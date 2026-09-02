import { FormEvent, useState } from 'react';
import styles from './AuthScreen.module.css';

type AuthMode = 'login' | 'register';

type AuthScreenProps = {
  error: string | null;
  message: string | null;
  isSubmitting: boolean;
  onLogin: (login: string, password: string) => Promise<boolean>;
  onRegister: (login: string, password: string) => Promise<boolean>;
  onRetry: () => void;
  unavailable?: boolean;
  checking?: boolean;
};

export function AuthScreen({
  error,
  message,
  isSubmitting,
  onLogin,
  onRegister,
  onRetry,
  unavailable = false,
  checking = false,
}: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const succeeded =
      mode === 'login'
        ? await onLogin(login, password)
        : await onRegister(login, password);

    if (succeeded) {
      setPassword('');
      if (mode === 'register') {
        setMode('login');
      }
    }
  };

  if (checking || unavailable) {
    return (
      <main className={styles.page}>
        <section className={styles.card} aria-labelledby="sign-in-title">
          <div className={styles.brand}>Signal Notes</div>
          <h1 id="sign-in-title">
            {checking ? 'Opening your workspace' : 'Sign-in is unavailable'}
          </h1>
          <p>
            {checking
              ? 'Checking your session…'
              : (error ?? 'Please try again.')}
          </p>
          {!checking && (
            <button
              className={styles.primaryButton}
              type="button"
              onClick={onRetry}
            >
              Try again
            </button>
          )}
        </section>
      </main>
    );
  }

  const isLogin = mode === 'login';

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="sign-in-title">
        <div className={styles.brand}>Signal Notes</div>
        <h1 id="sign-in-title">
          {isLogin
            ? 'Sign in to your workspace'
            : 'Create your workspace account'}
        </h1>
        <p>
          {isLogin
            ? 'Your meetings are available after you sign in.'
            : 'Create an account, then sign in to access your meetings.'}
        </p>

        {error && (
          <div className={styles.error} role="alert">
            {error}
          </div>
        )}
        {message && (
          <div className={styles.message} role="status">
            {message}
          </div>
        )}

        <form
          className={styles.form}
          onSubmit={(event) => void handleSubmit(event)}
        >
          <label>
            Login
            <input
              autoComplete="username"
              value={login}
              onChange={(event) => setLogin(event.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              autoComplete={isLogin ? 'current-password' : 'new-password'}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <button
            className={styles.primaryButton}
            disabled={isSubmitting}
            type="submit"
          >
            {isSubmitting
              ? 'Please wait…'
              : isLogin
                ? 'Sign in'
                : 'Create account'}
          </button>
        </form>

        <button
          className={styles.switchButton}
          type="button"
          disabled={isSubmitting}
          onClick={() => {
            setMode(isLogin ? 'register' : 'login');
            setPassword('');
          }}
        >
          {isLogin ? 'Create an account' : 'Back to sign in'}
        </button>
      </section>
    </main>
  );
}
