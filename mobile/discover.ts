/**
 * Finds AI that runs on the user's own devices, without scanning their network:
 *   - this computer: Ollama (11434), LM Studio (1234) and llama.cpp / other OpenAI-style servers (8080);
 *   - the PC this phone is paired with (Devices), on the same ports;
 *   - the on-phone models already downloaded.
 * Nothing is connected automatically: the user picks what to add.
 */

export interface Found {
  kind: 'ollama' | 'lmstudio' | 'openai-compatible' | 'phone';
  label: string;
  baseUrl: string;
  where: 'this device' | 'paired PC' | 'this phone';
  models: { id: string; vision?: boolean; size?: string }[];
  /** Carino can see the server but the app's own requests are refused (Ollama's allowed-origins setting). */
  blocked?: string;
}

const PORTS: { port: number; kind: Found['kind']; label: string; path: string }[] = [
  { port: 11434, kind: 'ollama', label: 'Ollama', path: '/api/tags' },
  { port: 1234, kind: 'lmstudio', label: 'LM Studio', path: '/v1/models' },
  { port: 8080, kind: 'openai-compatible', label: 'Local AI server', path: '/v1/models' },
];

/** Reads a JSON listing: (port, path) → parsed body, or null when nothing answers. */
export type Probe = (host: string, port: number, path: string) => Promise<any | null>;

const VISION = /(llava|vision|-vl|vl:|bakllava|moondream|minicpm-v|gemma3|gemma4|qwen2\.5vl|qwen3-vl|llama3\.2-vision|mllama|pixtral)/i;

export function parseListing(kind: Found['kind'], body: any): Found['models'] {
  if (kind === 'ollama') {
    return (Array.isArray(body?.models) ? body.models : []).map((m: any) => ({
      id: String(m.name ?? m.model),
      vision: VISION.test(String(m.name)) || (m.details?.families ?? []).some((f: string) => /clip|mllama/i.test(f)) || undefined,
      size: m.details?.parameter_size,
    })).filter((m: any) => m.id && !/embed/i.test(m.id));
  }
  return (Array.isArray(body?.data) ? body.data : []).map((m: any) => ({ id: String(m.id), vision: VISION.test(String(m.id)) || undefined }))
    .filter((m: any) => m.id && !/embed/i.test(m.id));
}

export async function discover(opts: {
  probe: Probe;
  /** Paired PC host names or addresses (no port). */
  pairedHosts?: string[];
  /** Also look on this device (desktop, browser); false on a phone. */
  thisDevice?: boolean;
  /** On-phone models already downloaded. */
  phoneModels?: string[];
  /** Checks whether the app itself may call the server (CORS); true if unknown. */
  appCanReach?: (baseUrl: string) => Promise<boolean>;
}): Promise<Found[]> {
  const hosts: { host: string; where: Found['where'] }[] = [
    ...(opts.thisDevice ? [{ host: '127.0.0.1', where: 'this device' as const }] : []),
    ...(opts.pairedHosts ?? []).map((h) => ({ host: h, where: 'paired PC' as const })),
  ];
  const found: Found[] = [];
  await Promise.all(hosts.flatMap(({ host, where }) => PORTS.map(async (p) => {
    const body = await opts.probe(host, p.port, p.path).catch(() => null);
    if (!body) return;
    const models = parseListing(p.kind, body);
    // Port 8080 is common for other things: only count it when it lists models.
    if (p.kind === 'openai-compatible' && !models.length) return;
    const baseUrl = `http://${host === '127.0.0.1' ? 'localhost' : host}:${p.port}/v1`;
    const f: Found = { kind: p.kind, label: p.label, baseUrl, where, models };
    if (opts.appCanReach && !(await opts.appCanReach(baseUrl).catch(() => false))) {
      f.blocked = p.kind === 'ollama'
        ? 'Ollama is running but refuses Carino’s requests. Set the OLLAMA_ORIGINS environment variable to * (or to Carino’s address) and restart Ollama.'
        : `${p.label} is running but refuses Carino’s requests. Turn on CORS in its server settings.`;
    }
    if (where === 'paired PC' && p.kind === 'ollama' && !models.length) return;
    found.push(f);
  })));
  if (opts.phoneModels?.length) {
    found.push({ kind: 'phone', label: 'On this phone', baseUrl: '', where: 'this phone', models: opts.phoneModels.map((id) => ({ id })) });
  }
  const order = { 'this phone': 0, 'this device': 1, 'paired PC': 2 };
  return found.sort((a, b) => order[a.where] - order[b.where] || a.label.localeCompare(b.label));
}
