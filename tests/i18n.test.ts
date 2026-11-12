import { describe, it, expect } from 'vitest';
import { resolveLanguage, setLanguage, t } from '../src/lib/i18n.ts';
import { getSettings } from '../server/services/settings.ts';
import { buildSystemPrompt } from '../server/ai/agent.ts';
import { setup, signup } from './helpers.ts';

describe('languages', () => {
  it('uses the browser language when the setting is automatic', () => {
    expect(resolveLanguage('', 'de-AT')).toBe('de');
    expect(resolveLanguage('', 'pt-PT')).toBe('pt-BR');
    expect(resolveLanguage('', 'sw-KE')).toBe('en');
    expect(resolveLanguage('fr', 'de-DE')).toBe('fr');
  });

  it('translates the web screens and fills in values, falling back to English', async () => {
    await setLanguage('de');
    expect(t('Settings')).toBe('Einstellungen');
    expect(t('Ask {0} anything.', ['Carino'])).toBe('Frag Carino irgendwas.');
    expect(t('Something not translated')).toBe('Something not translated');
    await setLanguage('en');
    expect(t('Settings')).toBe('Settings');
  });

  it('saves the app language and tells the assistant which one it is', async () => {
    const ctx = setup();
    try {
      const c = await signup(ctx);
      expect((await c.patch('/api/settings', { regional: { language: 'it' } })).status).toBe(200);
      const s = getSettings(ctx.services.db, c.user.id);
      expect(s.regional.language).toBe('it');
      expect(buildSystemPrompt(c.user as any, s)).toMatch(/app is set to Italian/);
      expect((await c.patch('/api/settings', { regional: { language: 'xx' } })).status).toBe(400);
    } finally {
      ctx.cleanup();
    }
  });
});
