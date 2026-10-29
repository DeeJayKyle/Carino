import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Icon } from './Icon';

// ---------- Toasts ----------
type Toast = { id: number; text: string; kind: 'info' | 'error'; action?: { label: string; run: () => void } };
const ToastCtx = createContext<(text: string, kind?: Toast['kind'], action?: Toast['action']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info', action?: Toast['action']) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, kind, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>
            <Icon name={t.kind === 'error' ? 'alert' : 'check'} size={16} style={{ marginTop: 2, flex: 'none' }} />
            <span className="grow">{t.text}</span>
            {t.action && <button onClick={() => { t.action!.run(); setToasts((x) => x.filter((y) => y.id !== t.id)); }}>{t.action.label}</button>}
            <button aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}><Icon name="x" size={14} /></button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---------- Modal ----------
export function Modal({ title, onClose, children, footer, wide, labelledBy }: { title?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>('input, textarea, select, button:not([data-close])');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && el) {
        const items = [...el.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])')];
        if (!items.length) return;
        const [a, b] = [items[0], items[items.length - 1]];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); b.focus(); }
        else if (!e.shiftKey && document.activeElement === b) { e.preventDefault(); a.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      prev?.focus?.();
    };
  }, [onClose]);
  const id = labelledBy ?? 'modal-title';
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref}>
        {title && (
          <div className="modal-head">
            <h2 id={id} className="grow">{title}</h2>
            <button className="btn ghost icon sm" data-close onClick={onClose} aria-label="Close"><Icon name="x" /></button>
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- Confirm ----------
type ConfirmOpts = { title: string; body?: ReactNode; confirm?: string; danger?: boolean };
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const ask = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {state && (
        <Modal title={state.title} onClose={() => close(false)} footer={
          <>
            <button className="btn" onClick={() => close(false)}>Cancel</button>
            <button className={`btn ${state.danger ? 'danger solid' : 'primary'}`} onClick={() => close(true)}>{state.confirm ?? 'Confirm'}</button>
          </>
        }>
          <div className="muted">{state.body}</div>
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}

// ---------- Small pieces ----------
export const Spinner = ({ lg, label = 'Loading' }: { lg?: boolean; label?: string }) => <span className={`spinner ${lg ? 'lg' : ''}`} role="status" aria-label={label} />;

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="col" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="skeleton" style={{ height: 44, opacity: 1 - i * 0.2 }} />)}
    </div>
  );
}

export function Empty({ icon = 'sparkle', title, children, action }: { icon?: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="icon-wrap"><Icon name={icon} size={22} /></div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: { message: string } | null; retry?: () => void }) {
  if (!error) return null;
  return (
    <div className="callout danger" role="alert">
      <Icon name="alert" size={18} style={{ flex: 'none', marginTop: 2 }} />
      <div className="grow">{error.message}</div>
      {retry && <button className="btn sm" onClick={retry}><Icon name="refresh" size={14} />Retry</button>}
    </div>
  );
}

export function StaleNote({ savedAt }: { savedAt: number | null }) {
  if (!savedAt) return null;
  return (
    <div className="callout warning small" style={{ marginBottom: 12 }}>
      <Icon name="wifiOff" size={16} style={{ flex: 'none', marginTop: 2 }} />
      <span>Offline copy from {new Date(savedAt).toLocaleString()}. Changes need a connection.</span>
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <span className="switch">
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </span>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

// ---------- Markdown ----------
marked.setOptions({ gfm: true, breaks: true });
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});

/** Renders untrusted Markdown safely (sanitised; no images from remote hosts, no scripts). */
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text ?? '', { async: false }) as string;
    return DOMPurify.sanitize(raw, { FORBID_TAGS: ['img', 'style', 'iframe', 'form', 'input'], FORBID_ATTR: ['style'] });
  }, [text]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.copy-code')) return;
      const b = document.createElement('button');
      b.className = 'btn sm copy-code';
      b.textContent = 'Copy';
      b.onclick = () => {
        void navigator.clipboard?.writeText(pre.querySelector('code')?.textContent ?? '');
        b.textContent = 'Copied';
        setTimeout(() => (b.textContent = 'Copy'), 1500);
      };
      pre.appendChild(b);
    });
  }, [html]);
  return <div ref={ref} className={`md ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ---------- Charts (dependency-free SVG) ----------
export function BarChart({ data, height = 200, format = (v: number) => v.toLocaleString() }: { data: { label: string; value: number }[]; height?: number; format?: (v: number) => string }) {
  if (!data.length) return null;
  const W = 600, H = height, pad = { l: 8, r: 8, t: 16, b: 42 };
  const max = Math.max(...data.map((d) => d.value), 0) || 1;
  const min = Math.min(0, ...data.map((d) => d.value));
  const span = max - min || 1;
  const bw = (W - pad.l - pad.r) / data.length;
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - (v - min) / span);
  return (
    <div className="chart" role="img" aria-label={`Bar chart: ${data.map((d) => `${d.label} ${format(d.value)}`).join(', ')}`}>
      <svg viewBox={`0 0 ${W} ${H}`}>
        <line className="axis" x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} />
        {data.map((d, i) => (
          <g key={i}>
            <rect className="bar" x={pad.l + i * bw + bw * 0.15} width={bw * 0.7} y={Math.min(y(d.value), y(0))} height={Math.abs(y(d.value) - y(0))} rx={3}>
              <title>{`${d.label}: ${format(d.value)}`}</title>
            </rect>
            <text className="lbl" x={pad.l + i * bw + bw / 2} y={H - pad.b + 16} textAnchor="middle">{d.label.length > 12 ? d.label.slice(0, 11) + '…' : d.label}</text>
          </g>
        ))}
        <text className="lbl" x={W - pad.r} y={12} textAnchor="end">max {format(max)}</text>
      </svg>
    </div>
  );
}

export function LineChart({ data, height = 200, format = (v: number) => v.toLocaleString() }: { data: { label: string; value: number }[]; height?: number; format?: (v: number) => string }) {
  if (data.length < 2) return null;
  const W = 600, H = height, pad = { l: 12, r: 12, t: 16, b: 34 };
  const max = Math.max(...data.map((d) => d.value));
  const min = Math.min(...data.map((d) => d.value));
  const span = max - min || 1;
  const x = (i: number) => pad.l + (i * (W - pad.l - pad.r)) / (data.length - 1);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - (v - min) / span);
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${x(i)},${y(d.value)}`).join(' ');
  const step = Math.ceil(data.length / 8);
  return (
    <div className="chart" role="img" aria-label={`Line chart: ${data.map((d) => `${d.label} ${format(d.value)}`).join(', ')}`}>
      <svg viewBox={`0 0 ${W} ${H}`}>
        <line className="axis" x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} />
        <path className="line" d={path} />
        {data.map((d, i) => (
          <g key={i}>
            <circle className="pt" cx={x(i)} cy={y(d.value)} r={3.5}><title>{`${d.label}: ${format(d.value)}`}</title></circle>
            {i % step === 0 && <text className="lbl" x={x(i)} y={H - pad.b + 18} textAnchor="middle">{d.label}</text>}
          </g>
        ))}
        <text className="lbl" x={W - pad.r} y={12} textAnchor="end">{format(min)} – {format(max)}</text>
      </svg>
    </div>
  );
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
