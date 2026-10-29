import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

/** The custom properties set in the first rule whose selector starts with `selector`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(selector + ' {');
  if (start < 0) throw new Error('No rule for ' + selector);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]]));
}
/**
 * WCAG 2 contrast ratio. (Checked against Adobe Leonardo's results, from Awesome Design Tools: they
 * match to 4 decimals. Leonardo itself isn't a dependency because it pulls in a vulnerable library.)
 */
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lum = (hex: string) => {
  const [r, g, b] = rgb(hex).map((c) => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (fg: string, bg: string) => {
  const [a, b] = [lum(fg), lum(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

// Merged in cascade order, as the app applies them (a midnight dark page also has the dark rules).
const light = tokens(':root');
const dark = { ...light, ...tokens(":root[data-theme='dark']") };
const midnight = tokens(":root[data-palette='midnight']");
const themes: [string, Record<string, string>][] = [
  ['light', light],
  ['dark', dark],
  ['midnight light', { ...light, ...midnight }],
  ['midnight dark', { ...dark, ...midnight, ...tokens(":root[data-palette='midnight'][data-theme='dark']") }],
];

// Text pairs that must reach WCAG AA (4.5:1). Large or bold-only uses and decoration are left out.
const body: [string, string][] = [
  ['text', 'bg'], ['text', 'surface'], ['text-2', 'bg'], ['text-2', 'surface'],
  ['on-brand', 'brand'], ['brand-text', 'surface'], ['brand-text', 'brand-soft'], ['text', 'brand-soft'],
  ['danger', 'surface'], ['success', 'success-soft'], ['warning', 'warning-soft'], ['danger', 'danger-soft'],
];

describe.each(themes)('colour contrast: %s theme', (_name, t) => {
  it.each(body)('%s on %s reaches 4.5:1', (fg, bg) => {
    expect(ratio(t[fg], t[bg]), `${fg} ${t[fg]} on ${bg} ${t[bg]}`).toBeGreaterThanOrEqual(4.5);
  });
  it('hints and small grey text (text-3) reach 4.5:1 against the page and cards', () => {
    expect(ratio(t['text-3'], t.bg)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(t['text-3'], t.surface)).toBeGreaterThanOrEqual(4.5);
  });
});
