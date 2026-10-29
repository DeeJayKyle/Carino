import type { Services } from '../context.ts';

export class TranscribeError extends Error {}

export const transcriptionConfigured = (s: Services) => !!s.config.TRANSCRIBE_BASE_URL;

/** Speech-to-text through an OpenAI-compatible /audio/transcriptions endpoint (Groq, local Whisper…). */
export async function transcribe(services: Services, audio: Uint8Array, filename: string, mime: string, language?: string): Promise<string> {
  const { TRANSCRIBE_BASE_URL: base, TRANSCRIBE_API_KEY: key, TRANSCRIBE_MODEL: model } = services.config;
  if (!base) throw new TranscribeError('Voice notes need speech-to-text set up on the Carino server (TRANSCRIBE_BASE_URL — Groq’s free tier works). Send a text message instead.');
  const form = new FormData();
  form.append('file', new File([audio as BlobPart], filename, { type: mime }));
  form.append('model', model);
  if (language) form.append('language', language.slice(0, 2));
  const f = services.netFetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${base.replace(/\/$/, '')}/audio/transcriptions`, {
      method: 'POST', body: form, headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new TranscribeError('The speech-to-text service could not be reached.');
  }
  if (!res.ok) throw new TranscribeError(`The speech-to-text service returned an error (${res.status}).`);
  const data = (await res.json().catch(() => ({}))) as { text?: string };
  const text = (data.text ?? '').trim();
  if (!text) throw new TranscribeError('No speech was recognised in that voice note.');
  return text;
}
