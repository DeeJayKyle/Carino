import { useCallback, useEffect, useRef, useState } from 'react';
import { listen, nativeSpeech, speakNative, stopListening, stopSpeakingNative } from '../../mobile/native';

/**
 * Speech-to-text via the browser's Web Speech API. Recording only happens while the user
 * holds the mic on (clear indicator, stops automatically). In Chrome and Edge, audio is
 * processed by the browser vendor's cloud service — the UI says so.
 */
export function speechSupported() {
  if (nativeSpeech) return true; // the Android app uses the phone's own speech recognition
  return typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

/**
 * `continuous` keeps listening through pauses (for long brain-dumps) until stop() is called;
 * browsers end a session after a while, so it quietly starts a new one.
 */
export function useDictation(lang: string, onFinal: (text: string) => void, opts: { continuous?: boolean } = {}) {
  const [listening, setListening] = useState(false);
  const wanted = useRef(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<any>(null);
  const finalRef = useRef(onFinal);
  finalRef.current = onFinal;

  const stop = useCallback(() => {
    wanted.current = false;
    if (nativeSpeech) stopListening();
    else rec.current?.stop();
  }, []);

  const startNative = useCallback(() => {
    setError(null);
    wanted.current = !!opts.continuous;
    setListening(true);
    const onEvent = (e: { partial?: string; final?: string; error?: string; end?: boolean }) => {
      if (e.partial !== undefined) setInterim(e.partial);
      if (e.final) {
        setInterim('');
        finalRef.current(e.final.trim());
      }
      if (e.error) {
        if (e.error === 'no-speech' && wanted.current) return;
        wanted.current = false;
        setError(e.error === 'not-allowed' ? 'Microphone access was blocked. Allow it for this app in your phone’s settings.' : e.error === 'no-speech' ? 'No speech was heard. Try again.' : `Voice input error: ${e.error}`);
      }
      if (e.end) {
        setInterim('');
        // Android ends each session after a pause; keep going for continuous dictation.
        if (wanted.current) listen(lang || 'en-US', onEvent);
        else setListening(false);
      }
    };
    listen(lang || 'en-US', onEvent);
  }, [lang, opts.continuous]);

  const start = useCallback(() => {
    if (nativeSpeech) return startNative();
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      setError('Voice input is not supported in this browser. Try Chrome or Edge, or type instead.');
      return;
    }
    setError(null);
    const r = new SR();
    r.lang = lang || 'en-US';
    r.interimResults = true;
    r.continuous = !!opts.continuous;
    r.maxAlternatives = 1;
    r.onresult = (e: any) => {
      let fin = '';
      let mid = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) fin += t;
        else mid += t;
      }
      setInterim(mid);
      if (fin) finalRef.current(fin.trim());
    };
    r.onerror = (e: any) => {
      const msg: Record<string, string> = {
        'not-allowed': 'Microphone access was blocked. Allow it in your browser’s site settings to use voice input.',
        'service-not-allowed': 'Microphone access was blocked. Allow it in your browser’s site settings to use voice input.',
        'no-speech': 'No speech was heard. Try again.',
        network: 'Voice recognition needs an internet connection.',
        'audio-capture': 'No microphone was found.',
      };
      if (e.error === 'no-speech' && wanted.current) return; // a pause, not a failure
      wanted.current = false;
      if (e.error !== 'aborted') setError(msg[e.error] ?? `Voice input error: ${e.error}`);
    };
    r.onend = () => {
      setInterim('');
      if (wanted.current) {
        try {
          r.start();
          return;
        } catch {
          wanted.current = false;
        }
      }
      setListening(false);
    };
    rec.current = r;
    try {
      wanted.current = !!opts.continuous;
      r.start();
      setListening(true);
    } catch {
      wanted.current = false;
      setListening(false);
    }
  }, [lang, opts.continuous]);

  useEffect(() => () => {
    wanted.current = false;
    if (nativeSpeech) stopListening();
    else rec.current?.abort?.();
  }, []);
  return { listening, interim, error, start, stop, supported: speechSupported(), clearError: () => setError(null) };
}

/** Text-to-speech with the browser's built-in voices (works offline for local voices). */
const plainText = (text: string) => text
  .replace(/```[\s\S]*?```/g, ' (code omitted) ')
  .replace(/[#*_`>|]/g, '')
  .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .slice(0, 4000);

export function speak(text: string, opts: { lang?: string; voiceName?: string } = {}) {
  if (nativeSpeech) {
    speakNative(plainText(text), opts.lang || 'en-US');
    return true;
  }
  if (!('speechSynthesis' in window)) return false;
  window.speechSynthesis.cancel();
  const plain = plainText(text);
  const u = new SpeechSynthesisUtterance(plain);
  u.lang = opts.lang || 'en-US';
  const voice = window.speechSynthesis.getVoices().find((v) => v.name === opts.voiceName);
  if (voice) u.voice = voice;
  window.speechSynthesis.speak(u);
  return true;
}

/** Speaks and resolves when finished (or immediately when speech isn't available). */
export function speakAsync(text: string, opts: { lang?: string; voiceName?: string } = {}) {
  return new Promise<void>((resolve) => {
    if (nativeSpeech) return speakNative(plainText(text), opts.lang || 'en-US', resolve);
    if (!('speechSynthesis' in window)) return resolve();
    if (!speak(text, opts)) return resolve();
    // speak() queued exactly one utterance; poll for the end, since onend is unreliable on some browsers.
    const started = Date.now();
    const timer = setInterval(() => {
      if ((!window.speechSynthesis.speaking && Date.now() - started > 300) || Date.now() - started > 120_000) {
        clearInterval(timer);
        resolve();
      }
    }, 200);
  });
}

export function stopSpeaking() {
  if (nativeSpeech) return stopSpeakingNative();
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}
