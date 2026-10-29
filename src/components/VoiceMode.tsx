import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { Avatar } from './Avatar';
import { speakAsync, stopSpeaking, useDictation } from '../lib/voice';
import { useSession } from '../lib/session';
import { useMascot } from '../lib/mascot';

/**
 * Hands-free conversation: listen → send when you pause → read the reply aloud → listen again.
 * Uses the browser's own speech recognition and voices, so it costs nothing extra.
 */
export function VoiceMode({ send, onClose }: { send: (text: string) => Promise<string | null>; onClose: () => void }) {
  const { me } = useSession();
  const v = me!.settings.voice;
  const name = me!.settings.profile.assistantName || 'Carino';
  const { accessory } = useMascot();
  const [phase, setPhase] = useState<'listening' | 'thinking' | 'speaking' | 'paused'>('listening');
  const [heard, setHeard] = useState('');
  const [said, setSaid] = useState('');
  const pending = useRef('');
  const closed = useRef(false);
  const voice = useDictation(v.language, (t) => {
    pending.current = pending.current ? `${pending.current} ${t}` : t;
    setHeard(pending.current);
  });

  const listen = useCallback(() => {
    if (closed.current) return;
    pending.current = '';
    setHeard('');
    setPhase('listening');
    voice.start();
  }, [voice]);

  useEffect(() => {
    listen();
    return () => {
      closed.current = true;
      stopSpeaking();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // When recognition stops after a pause, send what was heard, speak the answer, listen again.
  useEffect(() => {
    if (voice.listening || phase !== 'listening' || closed.current) return;
    const text = pending.current.trim();
    if (!text) {
      if (!voice.error) setPhase('paused');
      return;
    }
    setPhase('thinking');
    void (async () => {
      const reply = await send(text).catch(() => null);
      if (closed.current) return;
      if (reply) {
        setSaid(reply);
        setPhase('speaking');
        await speakAsync(reply, { lang: v.language, voiceName: v.voiceName });
      }
      listen();
    })();
  }, [voice.listening]); // eslint-disable-line react-hooks/exhaustive-deps

  const label = phase === 'listening' ? 'Listening…' : phase === 'thinking' ? 'Thinking…' : phase === 'speaking' ? `${name} is talking` : 'Paused';
  return (
    <div className="voice-mode" role="dialog" aria-modal="true" aria-label="Voice conversation">
      <button className="btn ghost icon voice-close" onClick={onClose} aria-label="End voice conversation"><Icon name="x" /></button>
      <Avatar state={phase === 'paused' ? 'idle' : phase} size={170} accessory={accessory} />
      <div className="voice-status" aria-live="polite">{label}</div>
      <p className="voice-text">{phase === 'speaking' ? said.replace(/[#*_`>]/g, '').slice(0, 400) : heard || voice.interim || (phase === 'paused' ? 'Tap the mic and say something.' : 'Say something — pause when you’re done.')}</p>
      {!voice.supported && <p className="small" style={{ color: 'var(--danger)' }}>This browser can’t listen. Voice mode works in Chrome and Edge (on Android and Windows). You can still type in the chat.</p>}
      {voice.supported && voice.error && <p className="small" style={{ color: 'var(--danger)' }}>{voice.error}</p>}
      <div className="row" style={{ gap: 14, marginTop: 18 }}>
        {phase === 'speaking' && <button className="btn" onClick={() => { stopSpeaking(); }}><Icon name="stop" size={16} />Skip</button>}
        {phase === 'paused' && <button className="btn primary" onClick={listen}><Icon name="mic" size={16} />Talk</button>}
        {phase === 'listening' && <button className="btn" onClick={() => { voice.stop(); }}><Icon name="send" size={16} />Done talking</button>}
        <button className="btn danger" onClick={onClose}><Icon name="x" size={16} />End</button>
      </div>
      <p className="tiny faint" style={{ marginTop: 18 }}>Uses your browser’s speech service and voices (choose a voice in Settings → Voice). Everything is saved in this chat.</p>
    </div>
  );
}
