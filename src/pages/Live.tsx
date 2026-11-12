import { useEffect, useRef, useState } from 'react';
import { Shell } from '../components/Shell';
import { Icon } from '../components/Icon';
import { useToast } from '../components/ui';
import { get, post } from '../lib/api';

/**
 * Live voice: talk with Carino in real time. Audio goes straight between this page and the AI
 * service (OpenAI Realtime over WebRTC, or Gemini Live over a WebSocket) using a short-lived token
 * from the engine. Tools the model asks for run in the engine under the usual approvals.
 */
type Option = { id: 'openai' | 'gemini'; label: string; voices: string[] };
type Line = { who: 'you' | 'ai' | 'note'; text: string };

async function runTool(name: string, args: unknown) {
  try {
    const r = await post<{ output: unknown }>('/live/tool', { name, args });
    return JSON.stringify(r.output ?? null).slice(0, 8000);
  } catch (e: any) {
    return JSON.stringify({ error: String(e?.message ?? e) });
  }
}

/** OpenAI Realtime over WebRTC. Returns a function that ends the call. */
async function startOpenAI(token: string, say: (l: Line) => void) {
  const pc = new RTCPeerConnection();
  const audio = new Audio();
  audio.autoplay = true;
  pc.ontrack = (e) => { audio.srcObject = e.streams[0]; };
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  mic.getTracks().forEach((t) => pc.addTrack(t, mic));
  const dc = pc.createDataChannel('oai-events');
  dc.onmessage = async (m) => {
    const ev = JSON.parse(m.data);
    if (ev.type === 'conversation.item.input_audio_transcription.completed' && ev.transcript) say({ who: 'you', text: ev.transcript });
    if (ev.type === 'response.output_audio_transcript.done' && ev.transcript) say({ who: 'ai', text: ev.transcript });
    if (ev.type === 'response.done') {
      const calls = (ev.response?.output ?? []).filter((o: any) => o.type === 'function_call');
      for (const c of calls) {
        say({ who: 'note', text: `Using ${c.name.replace(/_/g, ' ')}…` });
        let args: unknown = {};
        try { args = JSON.parse(c.arguments || '{}'); } catch { /* keep empty */ }
        dc.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: c.call_id, output: await runTool(c.name, args) } }));
      }
      if (calls.length) dc.send(JSON.stringify({ type: 'response.create' }));
    }
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const res = await fetch('https://api.openai.com/v1/realtime/calls', { method: 'POST', body: offer.sdp, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/sdp' } });
  if (!res.ok) throw new Error(`OpenAI said ${res.status}`);
  await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
  return () => { dc.close(); pc.close(); mic.getTracks().forEach((t) => t.stop()); audio.srcObject = null; };
}

const b64 = (buf: ArrayBuffer) => {
  let s = '';
  const u = new Uint8Array(buf);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Gemini Live over a WebSocket: 16 kHz PCM up, 24 kHz PCM down. */
async function startGemini(token: string, setup: unknown, say: (l: Line) => void) {
  const ws = new WebSocket(`wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token)}`);
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const inCtx = new AudioContext({ sampleRate: 16000 });
  const outCtx = new AudioContext({ sampleRate: 24000 });
  let playAt = 0;
  const src = inCtx.createMediaStreamSource(mic);
  // ScriptProcessor is old but works everywhere this page runs, with no extra worklet file.
  const proc = inCtx.createScriptProcessor(2048, 1, 1);
  proc.onaudioprocess = (e) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const f = e.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) pcm[i] = Math.max(-1, Math.min(1, f[i])) * 0x7fff;
    ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64(pcm.buffer), mimeType: 'audio/pcm;rate=16000' } } }));
  };
  src.connect(proc);
  proc.connect(inCtx.destination);
  const play = (data: string) => {
    const bin = atob(data);
    const pcm = new Int16Array(bin.length / 2);
    for (let i = 0; i < pcm.length; i++) pcm[i] = (bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8)) << 16 >> 16;
    const buf = outCtx.createBuffer(1, pcm.length, 24000);
    buf.getChannelData(0).set(Float32Array.from(pcm, (v) => v / 0x8000));
    const node = outCtx.createBufferSource();
    node.buffer = buf;
    node.connect(outCtx.destination);
    playAt = Math.max(playAt, outCtx.currentTime);
    node.start(playAt);
    playAt += buf.duration;
  };
  await new Promise<void>((ok, fail) => {
    ws.onopen = () => { ws.send(JSON.stringify({ setup: { ...(setup as object), inputAudioTranscription: {}, outputAudioTranscription: {} } })); ok(); };
    ws.onerror = () => fail(new Error('Couldn’t reach Gemini Live.'));
  });
  ws.onmessage = async (m) => {
    const ev = JSON.parse(typeof m.data === 'string' ? m.data : await (m.data as Blob).text());
    const sc = ev.serverContent;
    if (sc?.interrupted) playAt = 0;
    for (const p of sc?.modelTurn?.parts ?? []) if (p.inlineData?.data) play(p.inlineData.data);
    if (sc?.inputTranscription?.text) say({ who: 'you', text: sc.inputTranscription.text });
    if (sc?.outputTranscription?.text) say({ who: 'ai', text: sc.outputTranscription.text });
    if (ev.toolCall?.functionCalls?.length) {
      const functionResponses = [];
      for (const c of ev.toolCall.functionCalls) {
        say({ who: 'note', text: `Using ${String(c.name).replace(/_/g, ' ')}…` });
        functionResponses.push({ id: c.id, name: c.name, response: { output: JSON.parse(await runTool(c.name, c.args ?? {})) } });
      }
      ws.send(JSON.stringify({ toolResponse: { functionResponses } }));
    }
  };
  ws.onclose = (e) => { if (e.code !== 1000) say({ who: 'note', text: `The call ended${e.reason ? `: ${e.reason}` : ''}.` }); };
  return () => { ws.close(1000); proc.disconnect(); src.disconnect(); mic.getTracks().forEach((t) => t.stop()); void inCtx.close(); void outCtx.close(); };
}

export default function Live() {
  const toast = useToast();
  const [opts, setOpts] = useState<{ available: Option[]; reason?: string } | null>(null);
  const [provider, setProvider] = useState<Option['id'] | null>(null);
  const [state, setState] = useState<'idle' | 'connecting' | 'live'>('idle');
  const [lines, setLines] = useState<Line[]>([]);
  const stop = useRef<null | (() => void)>(null);

  useEffect(() => {
    get<{ available: Option[]; reason?: string }>('/live').then((o) => { setOpts(o); setProvider(o.available[0]?.id ?? null); }).catch(() => setOpts({ available: [], reason: 'Couldn’t check live voice.' }));
    return () => stop.current?.();
  }, []);

  // Transcripts arrive in pieces; join consecutive pieces from the same speaker.
  const say = (l: Line) => setLines((xs) => {
    const last = xs[xs.length - 1];
    if (last && last.who === l.who && l.who !== 'note') return [...xs.slice(0, -1), { ...last, text: `${last.text}${/\s$/.test(last.text) ? '' : ' '}${l.text}`.trim() }];
    return [...xs, l].slice(-60);
  });

  const start = async () => {
    if (!provider) return;
    setState('connecting');
    try {
      const s = await post<{ provider: string; token: string; setup?: unknown }>('/live/session', { provider });
      stop.current = s.provider === 'openai' ? await startOpenAI(s.token, say) : await startGemini(s.token, s.setup, say);
      setState('live');
    } catch (e: any) {
      toast(String(e?.message ?? 'Couldn’t start live voice.'), 'error');
      setState('idle');
    }
  };
  const end = () => { stop.current?.(); stop.current = null; setState('idle'); };

  return (
    <Shell title="Live voice">
      <div className="stack" style={{ maxWidth: 640, margin: '0 auto' }}>
        {opts && !opts.available.length && <p className="muted">{opts.reason}</p>}
        {opts && opts.available.length > 1 && state === 'idle' && (
          <div className="row" role="radiogroup" aria-label="Service">
            {opts.available.map((o) => (
              <button key={o.id} className={`chip${provider === o.id ? ' on' : ''}`} aria-pressed={provider === o.id} onClick={() => setProvider(o.id)}>{o.label}</button>
            ))}
          </div>
        )}
        {opts && opts.available.length > 0 && (
          <div style={{ display: 'grid', placeItems: 'center', padding: 24 }}>
            <button className={`btn ${state === 'live' ? 'danger' : 'primary'}`} style={{ borderRadius: 999, width: 120, height: 120 }} disabled={state === 'connecting'} onClick={state === 'live' ? end : start} aria-label={state === 'live' ? 'End the call' : 'Start talking'}>
              <Icon name={state === 'live' ? 'x' : 'mic'} size={36} />
            </button>
            <p className="muted" style={{ marginTop: 12 }}>{state === 'live' ? 'Listening — just talk. Tap to end.' : state === 'connecting' ? 'Connecting…' : 'Tap to start a live conversation.'}</p>
          </div>
        )}
        <div className="stack" aria-live="polite">
          {lines.map((l, i) => (
            <p key={i} className={l.who === 'note' ? 'muted small' : undefined}><strong>{l.who === 'you' ? 'You: ' : ''}</strong>{l.text}</p>
          ))}
        </div>
        <p className="muted small">Live voice sends your audio to the service you picked while the call is on. Changes it makes still wait for your approval.</p>
      </div>
    </Shell>
  );
}
