import { describe, it, expect } from 'vitest';
import { voiceCommand, speechText } from '../src/lib/voice-commands.ts';

describe('voice commands', () => {
  it('recognises short spoken commands', () => {
    expect(voiceCommand('Stop.')).toBe('end');
    expect(voiceCommand('Okay Carino, that’s all')).toBe('end');
    expect(voiceCommand('pause')).toBe('pause');
    expect(voiceCommand('Mute the mic please')).toBe('pause');
    expect(voiceCommand('Say that again?')).toBe('repeat');
    expect(voiceCommand('read my brief')).toBe('brief');
    expect(voiceCommand("What's my day like")).toBe('brief');
    expect(voiceCommand('never mind')).toBe('skip');
  });
  it('leaves normal requests for the assistant', () => {
    expect(voiceCommand('stop the meeting at 3')).toBeNull();
    expect(voiceCommand('remind me to pause the washing machine')).toBeNull();
    expect(voiceCommand('add read my brief to my to-dos for tomorrow morning')).toBeNull();
    expect(voiceCommand('')).toBeNull();
  });
  it('turns Markdown into plain speech', () => {
    expect(speechText('**Good morning**\n- 3 to-dos\n- Rent due')).toBe('Good morning. 3 to-dos. Rent due');
  });
});
