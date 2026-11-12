import type { ChatMessage, ToolSpec } from './types.ts';
import { CORE_TOOLS, compactSpec } from '../tools/registry.ts';

/**
 * Fitting a request into a model with a small limit (free plans often allow only 6,000–12,000
 * tokens per request or minute). Carino has 100+ tools; most messages need a handful. When the
 * whole set wouldn't fit, it sends the everyday tools plus the ones this message is about, then
 * shorter history, then short tool descriptions.
 */

/** Rough token count for text sent to a model (about 3.5 characters per token for JSON and English). */
export const estimateTokens = (x: unknown) => Math.ceil((typeof x === 'string' ? x : JSON.stringify(x)).length / 3.5);

const STOP = new Set('the and for you your can with what that this from have are was how about please could would should will just like into out get got make let me my our its it is to of in on at an a do does did any all some'.split(' '));

/** What a word in a message may refer to, in tool-name terms. */
const SYNONYMS: Record<string, string[]> = {
  email: ['gmail', 'outlook', 'email', 'inbox'], mail: ['gmail', 'outlook', 'email', 'inbox'], inbox: ['gmail', 'outlook', 'inbox', 'email'],
  gmail: ['gmail'], outlook: ['outlook'], google: ['gmail', 'drive', 'calendar', 'sheets', 'docs'], microsoft: ['outlook', 'onedrive', 'word', 'excel', 'powerpoint'],
  calendar: ['calendar', 'event'], meeting: ['calendar', 'event'], event: ['calendar', 'event'], schedule: ['calendar', 'event', 'routine'], appointment: ['calendar', 'event'],
  drive: ['drive', 'onedrive', 'docs', 'sheets'], file: ['drive', 'onedrive', 'local', 'file', 'files', 'document'], folder: ['drive', 'onedrive', 'local', 'file', 'files'],
  document: ['docs', 'word', 'document', 'drive', 'onedrive'], doc: ['docs', 'word', 'document'], pdf: ['document', 'drive', 'file'],
  spreadsheet: ['sheets', 'excel', 'spreadsheet'], sheet: ['sheets', 'excel', 'spreadsheet'], excel: ['excel', 'spreadsheet'],
  slide: ['slides', 'powerpoint'], presentation: ['slides', 'powerpoint'], deck: ['slides', 'powerpoint'],
  money: ['expense', 'budget', 'income', 'bill', 'debt', 'saving', 'money', 'spending'], spent: ['expense', 'spending'], spend: ['expense', 'spending', 'budget'],
  budget: ['budget'], income: ['income'], salary: ['income'], bill: ['bill'], debt: ['debt'], owe: ['debt', 'split'], saving: ['saving'], statement: ['statement', 'bank'], bank: ['statement', 'bank'],
  note: ['note'], remember: ['memory'], forget: ['memory'], routine: ['routine'], every: ['routine'], daily: ['routine'], brief: ['overview', 'brief'],
  job: ['application'], scholarship: ['application'], application: ['application'],
  post: ['post', 'x', 'linkedin', 'facebook', 'instagram'], tweet: ['x'], twitter: ['x'], linkedin: ['linkedin'], facebook: ['facebook'], instagram: ['instagram'], tiktok: ['tiktok'],
  place: ['places'], near: ['places'], nearby: ['places'], restaurant: ['places', 'food'], shop: ['places'], pharmacy: ['places'], hospital: ['places'], where: ['places'],
  food: ['food'], hungry: ['food'], order: ['food'], deliver: ['food'], trip: ['trip'], travel: ['trip'], flight: ['trip'], hotel: ['trip'],
  call: ['call'], phone: ['call'], ring: ['call'], split: ['split'], share: ['share', 'split'], group: ['group', 'catchup'], missed: ['catchup'],
  picture: ['image'], image: ['image'], photo: ['image'], draw: ['image'], video: ['video'], sticker: ['stickers'], page: ['page'], invite: ['page'], website: ['browse', 'page', 'webpage'],
  browse: ['browse'], site: ['browse', 'webpage'], link: ['webpage', 'browse'], url: ['webpage', 'browse'], read: ['read'], code: ['code'], calculate: ['code'],
  skill: ['skill'], earlier: ['past'], chat: ['past', 'chats'], research: ['delegate', 'team', 'web'], search: ['search', 'web'],
  explore: ['search', 'list', 'read'], open: ['open', 'read'], list: ['list'], find: ['search', 'find'], look: ['search', 'read'],
  task: ['task'], todo: ['task'], remind: ['reminder'], reminder: ['reminder'], weather: ['web'], news: ['web'],
  slack: ['slack'], todoist: ['todoist'], ticktick: ['ticktick'], notion: ['notion'], linear: ['linear'], github: ['github'], issue: ['github', 'linear'],
  health: ['withings'], weight: ['withings'], sleep: ['withings'], steps: ['withings'], music: ['sonos'], play: ['sonos'], speaker: ['sonos'], sonos: ['sonos'],
};

/** Words a message is about, as tool-name terms. */
export function topics(text: string): Set<string> {
  const out = new Set<string>();
  for (let w of text.toLowerCase().match(/[a-z0-9-]+/g) ?? []) {
    if (w.length < 2 || STOP.has(w)) continue;
    w = w.replace(/-/g, '');
    const base = w.length > 4 ? w.replace(/(ings|ing|ies|es|s|ed)$/, (m) => (m === 'ies' ? 'y' : '')) : w;
    for (const k of [w, base]) {
      out.add(k);
      for (const s of SYNONYMS[k] ?? []) out.add(s);
    }
  }
  return out;
}

/** The tools that fit: the everyday set, those already used in this chat, and those this message is about. */
export function pickTools(all: ToolSpec[], text: string, used: Set<string>, level: number): ToolSpec[] {
  const want = topics(text);
  const nameHit = (t: ToolSpec) => t.name.split('_').some((p) => want.has(p) || want.has(p.replace(/s$/, '')));
  const descHit = (t: ToolSpec) => level < 2 && (t.description.toLowerCase().match(/^.*?[.!?](\s|$)/)?.[0] ?? '').split(/[^a-z]+/).some((w) => w.length > 4 && want.has(w));
  const keep = all.filter((t) => CORE_TOOLS.has(t.name) || used.has(t.name) || nameHit(t) || descHit(t));
  // Tighter: the tools most clearly about this message first (a named app or thing beats a
  // generic verb like "search"), then a few everyday ones.
  const GENERIC = new Set(['search', 'list', 'read', 'find', 'open', 'get', 'create', 'add', 'update', 'web']);
  const score = (t: ToolSpec) => (used.has(t.name) ? 2 : 0) + t.name.split('_').reduce((n, p) => n + (want.has(p) || want.has(p.replace(/s$/, '')) ? (GENERIC.has(p) ? 1 : 4) : 0), 0);
  const ESSENTIAL = ['ask_user', 'web_search', 'create_task', 'create_reminder', 'save_memory', 'recall_memories'];
  const picked = level >= 2
    ? [...keep.filter((t) => score(t) > 0).sort((a, b) => score(b) - score(a)).slice(0, 12), ...keep.filter((t) => score(t) === 0 && ESSENTIAL.includes(t.name))].slice(0, 16)
    : keep;
  return level >= 3 ? picked.map(compactSpec) : picked;
}

/** Older turns dropped (keeping whole turns, so tool calls stay paired with their results). */
export function recentMessages(messages: ChatMessage[], keep: number, turnStart: number): ChatMessage[] {
  if (messages.length <= keep) return messages;
  let cut = Math.min(messages.length - keep, turnStart);
  while (cut > 0 && !(messages[cut].role === 'user' && !messages[cut].content.some((b) => b.type === 'tool_result'))) cut--;
  return cut > 0 ? messages.slice(cut) : messages;
}

/** Tool names this conversation has already used (it may well need them again). */
export function usedTools(messages: ChatMessage[]): Set<string> {
  const s = new Set<string>();
  for (const m of messages) for (const b of m.content) if (b.type === 'tool_use') s.add(String((b as { name?: unknown }).name));
  return s;
}

export interface Fitted { tools: ToolSpec[]; messages: ChatMessage[]; maxTokens?: number; level: number }

/**
 * The request at the gentlest level that fits `limit` tokens (prompt plus reply room), starting at
 * `from`. Level 0 sends everything; 1 only relevant tools; 2 fewer tools and recent turns; 3 short
 * tool descriptions and the last turn only.
 */
export function fit(o: { system: string; messages: ChatMessage[]; tools: ToolSpec[]; text: string; turnStart: number; limit: number | null; from?: number }): Fitted {
  const used = usedTools(o.messages);
  const build = (level: number): Fitted => {
    if (level === 0) return { tools: o.tools, messages: o.messages, level };
    const msgs = level === 1 ? recentMessages(o.messages, 16, o.turnStart) : level === 2 ? recentMessages(o.messages, 6, o.turnStart) : recentMessages(o.messages, 1, o.turnStart);
    return { tools: pickTools(o.tools, o.text, used, level), messages: msgs, level };
  };
  let f = build(o.from ?? 0);
  if (!o.limit) return f;
  for (let level = f.level; ; level++) {
    f = build(level);
    const size = estimateTokens(o.system) + estimateTokens(f.messages) + estimateTokens(f.tools);
    const room = o.limit - size;
    if (room >= 1500 || level >= 3) {
      // Free plans count the reply allowance too: ask for no more than what's left.
      f.maxTokens = Math.max(512, Math.min(4096, room - 200));
      return f;
    }
  }
}
