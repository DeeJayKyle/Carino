/** Simple marks for the apps in My apps, drawn here (no images are loaded from the web). */
export type AppLogoId = 'google' | 'microsoft' | 'facebook' | 'instagram' | 'x' | 'linkedin' | 'tiktok' | 'whatsapp' | 'telegram' | 'more';

export function AppLogo({ id, size = 40 }: { id: AppLogoId; size?: number }) {
  const s = { width: size, height: size, flex: 'none' as const };
  switch (id) {
    case 'google':
      return (
        <svg viewBox="0 0 40 40" style={s} aria-hidden="true">
          <rect width="40" height="40" rx="10" fill="#fff" stroke="#e3e3e3" />
          <g fill="none" strokeWidth="5" transform="translate(20 20)">
            <path d="M10.4 -6 A12 12 0 0 0 -10.4 -6" stroke="#EA4335" />
            <path d="M-10.4 -6 A12 12 0 0 0 -10.4 6" stroke="#FBBC05" />
            <path d="M-10.4 6 A12 12 0 0 0 10.4 6" stroke="#34A853" />
            <path d="M10.4 6 A12 12 0 0 0 12 0 L1 0" stroke="#4285F4" />
          </g>
        </svg>
      );
    case 'microsoft':
      return (
        <svg viewBox="0 0 40 40" style={s} aria-hidden="true">
          <rect width="40" height="40" rx="10" fill="#fff" stroke="#e3e3e3" />
          <rect x="9" y="9" width="10.5" height="10.5" fill="#F25022" /><rect x="20.5" y="9" width="10.5" height="10.5" fill="#7FBA00" />
          <rect x="9" y="20.5" width="10.5" height="10.5" fill="#00A4EF" /><rect x="20.5" y="20.5" width="10.5" height="10.5" fill="#FFB900" />
        </svg>
      );
    case 'facebook':
      return (
        <svg viewBox="0 0 40 40" style={s} aria-hidden="true">
          <circle cx="20" cy="20" r="20" fill="#1877F2" />
          <path d="M22.5 33V22h3.6l.6-4.3h-4.2v-2.7c0-1.2.4-2.1 2.1-2.1h2.2V9.1c-.4 0-1.7-.2-3.2-.2-3.2 0-5.3 1.9-5.3 5.5v3.3H14.7V22h3.6v11z" fill="#fff" />
        </svg>
      );
    case 'instagram':
      return (
        <svg viewBox="0 0 40 40" style={s} aria-hidden="true">
          <defs><linearGradient id="ig-g" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="#FEDA75" /><stop offset=".35" stopColor="#FA7E1E" /><stop offset=".6" stopColor="#D62976" /><stop offset=".85" stopColor="#962FBF" /><stop offset="1" stopColor="#4F5BD5" /></linearGradient></defs>
          <rect width="40" height="40" rx="11" fill="url(#ig-g)" />
          <rect x="9.5" y="9.5" width="21" height="21" rx="6" fill="none" stroke="#fff" strokeWidth="2.6" />
          <circle cx="20" cy="20" r="5" fill="none" stroke="#fff" strokeWidth="2.6" /><circle cx="26.3" cy="13.7" r="1.6" fill="#fff" />
        </svg>
      );
    case 'x':
      return (
        <svg viewBox="0 0 40 40" style={s} aria-hidden="true">
          <rect width="40" height="40" rx="10" fill="#000" />
          <path d="M11 11h5.2l13.8 18h-5.2zM28.6 11 21.8 18.8M11.4 29l6.9-7.9" stroke="#fff" strokeWidth="2.2" fill="none" strokeLinejoin="round" />
        </svg>
      );
    case 'linkedin':
      return (
        <svg viewBox="0 0 40 40" style={s} aria-hidden="true">
          <rect width="40" height="40" rx="9" fill="#0A66C2" />
          <circle cx="12.6" cy="12.6" r="2.6" fill="#fff" /><rect x="10.4" y="16.8" width="4.4" height="13" fill="#fff" />
          <path d="M18.4 16.8h4.2v1.9c.7-1.2 2.2-2.2 4.4-2.2 4 0 4.8 2.6 4.8 6v7.3h-4.4v-6.4c0-1.6-.1-3.4-2.2-3.4s-2.4 1.6-2.4 3.3v6.5h-4.4z" fill="#fff" />
        </svg>
      );
    case 'tiktok': {
      const note = 'M22 9v14.2a4.3 4.3 0 1 1-3.6-4.2v4a.9.9 0 1 0 .6.8V9h3c.3 2.5 2 4.3 4.6 4.6v3.2a7.8 7.8 0 0 1-4.6-1.5';
      return (
        <svg viewBox="0 0 40 40" style={s} aria-hidden="true">
          <rect width="40" height="40" rx="10" fill="#000" />
          <path d={note} fill="#25F4EE" transform="translate(-1.2 -1.2)" /><path d={note} fill="#FE2C55" transform="translate(1.2 1.2)" /><path d={note} fill="#fff" />
        </svg>
      );
    }
    case 'whatsapp':
      return (
        <svg viewBox="0 0 40 40" style={s} aria-hidden="true">
          <circle cx="20" cy="20" r="20" fill="#25D366" />
          <path d="M20 9.5a10.5 10.5 0 0 0-9 15.9L9.6 30.5l5.2-1.4A10.5 10.5 0 1 0 20 9.5z" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinejoin="round" />
          <path d="M16.3 15.3c.3-.6.6-.6.9-.6h.7c.2 0 .5.1.7.5l1 2.3c.1.3 0 .6-.1.8l-.6.8c-.2.2-.2.4 0 .7.5.9 1.6 2.1 3 2.7.3.1.5.1.7-.1l.8-.9c.2-.3.5-.3.8-.2l2.2 1.1c.3.2.4.4.3.7-.1.9-.9 1.9-2 2.1-1 .2-2.3-.1-4.4-1.2-2.4-1.4-4-3.6-4.4-4.6-.5-1.2-.2-2.8.4-3.5z" fill="#fff" />
        </svg>
      );
    case 'telegram':
      return (
        <svg viewBox="0 0 40 40" style={s} aria-hidden="true">
          <circle cx="20" cy="20" r="20" fill="#2AABEE" />
          <path d="M9.5 19.6 28.6 12c.9-.3 1.7.2 1.4 1.6l-3.2 15.2c-.2 1.1-.9 1.4-1.8.9l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.4-5 9-8.2c.4-.4-.1-.6-.6-.2l-11.2 7-4.8-1.5c-1-.3-1.1-1 .2-1.4z" fill="#fff" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 40 40" style={s} aria-hidden="true">
          <rect width="40" height="40" rx="10" fill="var(--brand-soft)" />
          <path d="M17.5 22.5l5-5M16 18l-2 2a4 4 0 0 0 5.7 5.7l2-2M24 22l2-2a4 4 0 0 0-5.7-5.7l-2 2" stroke="var(--brand-text)" strokeWidth="2.2" fill="none" strokeLinecap="round" />
        </svg>
      );
  }
}
