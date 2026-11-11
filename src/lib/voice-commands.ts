/** Spoken commands and speech text: pure helpers, shared by voice mode and the Home brief. */
export type VoiceCommand = 'end' | 'pause' | 'repeat' | 'brief' | 'skip';

/**
 * Short spoken commands in voice mode, handled on the device instead of being sent to the AI.
 * Only a whole short phrase counts, so “stop the meeting at 3” is still a normal message.
 */
export function voiceCommand(text: string): VoiceCommand | null {
  const t = text.toLowerCase().replace(/[.,!?'’]/g, '').replace(/\s+/g, ' ').trim()
    .replace(/^(hey |ok |okay )?(carino )?/, '').replace(/ please$/, '').replace(/^please /, '');
  if (!t || t.split(' ').length > 6) return null;
  if (/^(stop|end|goodbye|bye|thats all|that is all|end (the )?(call|conversation|voice( mode)?)|stop listening|close voice( mode)?)$/.test(t)) return 'end';
  if (/^(pause|wait|hold on|mute|mute (the )?mic(rophone)?|stop the mic(rophone)?)$/.test(t)) return 'pause';
  if (/^(repeat( that)?|say (that|it) again|again|what did you say)$/.test(t)) return 'repeat';
  if (/^(skip|next|never mind|nevermind|cancel)$/.test(t)) return 'skip';
  if (/^((read|give me|tell me|whats) )?(my |the )?(morning |daily )?(brief|briefing)$|^(whats|what is) my day( like| look like)?$|^read my day$/.test(t)) return 'brief';
  return null;
}

/** Markdown as plain speech: no marks or bullet symbols, lines read as sentences. */
export function speechText(md: string) {
  return md.replace(/[#*_`>]/g, '').replace(/^\s*[-•]\s*/gm, '').replace(/\n+/g, '. ').replace(/\.\s*\./g, '.').trim();
}
