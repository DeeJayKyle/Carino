import { t } from '../lib/i18n';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { Wordmark, Icon } from '../components/Icon';
import { Spinner } from '../components/ui';

export function Login() {
  const { refresh } = useSession();
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [status, setStatus] = useState<{ signupOpen: boolean; hasUsers: boolean } | null>(null);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api('/auth/status').then((s) => {
      setStatus(s);
      if (!s.hasUsers && s.signupOpen) setMode('signup');
    }).catch(() => setStatus({ signupOpen: false, hasUsers: true }));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'signup') {
        await api('/auth/signup', {
          method: 'POST',
          body: { ...form, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: navigator.language },
        });
      } else {
        await api('/auth/login', { method: 'POST', body: { email: form.email, password: form.password } });
      }
      await refresh();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof typeof form) => (e: any) => setForm({ ...form, [k]: e.target.value });

  return (
    <main className="auth">
      <div className="card auth-card">
        <Wordmark size={34} />
        <h1 style={{ marginTop: 22 }}>{mode === 'signup' ? (status?.hasUsers ? 'Create an account' : 'Set up Carino') : 'Welcome back'}</h1>
        <p className="lead">
          {mode === 'signup'
            ? 'Your personal assistant: to-dos, reminders, routines and memory. Your data stays with you.'
            : 'Sign in to continue with Carino.'}
        </p>
        <form onSubmit={submit} className="stack" noValidate>
          {mode === 'signup' && (
            <div className="field">
              <label htmlFor="name">{t('Your name')}</label>
              <input id="name" className="input" autoComplete="name" required value={form.name} onChange={set('name')} />
            </div>
          )}
          <div className="field">
            <label htmlFor="email">{t('Email')}</label>
            <input id="email" className="input" type="email" autoComplete="email" required value={form.email} onChange={set('email')} />
          </div>
          <div className="field">
            <label htmlFor="password">{t('Password')}</label>
            <input id="password" className="input" type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required minLength={mode === 'signup' ? 10 : undefined} value={form.password} onChange={set('password')} />
            {mode === 'signup' && <span className="hint">{t('At least 10 characters. A passphrase of a few words works well.')}</span>}
          </div>
          {error && <div className="callout danger small" role="alert"><Icon name="alert" size={16} />{error}</div>}
          <button className="btn primary block" disabled={busy} style={{ height: 44 }}>
            {busy ? <Spinner /> : mode === 'signup' ? 'Create account' : 'Sign in'}
          </button>
        </form>
        {status?.signupOpen && status.hasUsers && (
          <p className="small muted" style={{ marginTop: 18, textAlign: 'center' }}>
            {mode === 'login' ? 'New here? ' : 'Already have an account? '}
            <button className="btn ghost sm" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(null); }}>
              {mode === 'login' ? 'Create an account' : 'Sign in'}
            </button>
          </p>
        )}
        {status && !status.signupOpen && mode === 'login' && !status.hasUsers && (
          <p className="small muted" style={{ marginTop: 18 }}>{t('Sign-ups are closed on this server.')}</p>
        )}
      </div>
    </main>
  );
}
