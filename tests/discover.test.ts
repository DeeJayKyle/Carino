import { describe, it, expect } from 'vitest';
import { discover, parseListing } from '../mobile/discover.ts';

describe('finding local AI', () => {
  it('finds Ollama and LM Studio on this device and the paired PC, and nothing else', async () => {
    const asked: string[] = [];
    const probe = async (host: string, port: number, path: string) => {
      asked.push(`${host}:${port}${path}`);
      if (host === '127.0.0.1' && port === 11434) return { models: [{ name: 'qwen3:8b', details: { parameter_size: '8B', families: ['qwen3'] } }, { name: 'llava:7b', details: { families: ['llama', 'clip'] } }, { name: 'nomic-embed-text' }] };
      if (host === '192.168.1.20' && port === 1234) return { data: [{ id: 'gemma-4-e4b' }] };
      if (port === 8080) return { data: [] }; // something else on 8080: ignored
      return null;
    };
    const found = await discover({ probe, thisDevice: true, pairedHosts: ['192.168.1.20'], appCanReach: async (b) => !b.includes('localhost:11434') });
    expect(found.map((f) => `${f.label}@${f.where}`)).toEqual(['Ollama@this device', 'LM Studio@paired PC']);
    expect(found[0].models).toEqual([{ id: 'qwen3:8b', size: '8B' }, { id: 'llava:7b', vision: true }]);
    expect(found[0].blocked).toMatch(/OLLAMA_ORIGINS/);
    expect(found[1].baseUrl).toBe('http://192.168.1.20:1234/v1');
    // Only the two hosts and three ports were looked at: no network scan.
    expect(new Set(asked.map((a) => a.split(':')[0]))).toEqual(new Set(['127.0.0.1', '192.168.1.20']));
    expect(asked).toHaveLength(6);
  });

  it('lists downloaded on-phone models without looking anywhere on a phone', async () => {
    const asked: string[] = [];
    const found = await discover({ probe: async (h) => { asked.push(h); return null; }, thisDevice: false, phoneModels: ['qwen3-0.6b'] });
    expect(asked).toHaveLength(0);
    expect(found).toEqual([{ kind: 'phone', label: 'On this phone', baseUrl: '', where: 'this phone', models: [{ id: 'qwen3-0.6b' }] }]);
  });

  it('reads OpenAI-style listings and leaves out embedding models', () => {
    expect(parseListing('lmstudio', { data: [{ id: 'qwen2.5-vl-7b' }, { id: 'text-embedding-nomic' }] })).toEqual([{ id: 'qwen2.5-vl-7b', vision: true }]);
  });
});
