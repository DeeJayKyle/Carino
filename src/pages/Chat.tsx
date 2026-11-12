import { useCallback, useEffect, useRef, useState } from 'react';
import { Shell } from '../components/Shell';
import { HandoffButton } from '../components/Handoff';
import { Icon, Mark } from '../components/Icon';
import { Empty, ErrorBox, Markdown, Modal, Spinner, useConfirm, useToast } from '../components/ui';
import { ApprovalCard } from '../components/ApprovalCard';
import { del, patch, post, streamPost, upload, ApiError } from '../lib/api';
import { useData, useDebounced, useMediaQuery } from '../lib/hooks';
import { Link, navigate, useLocation } from '../lib/router';
import { relative } from '../lib/format';
import { useSession } from '../lib/session';
import { speak, stopSpeaking, useDictation } from '../lib/voice';
import { IMAGE_ACCEPT } from '../lib/images';
import { VoiceMode } from '../components/VoiceMode';
import { Avatar } from '../components/Avatar';
import { useMascot } from '../lib/mascot';
import { ApiImg } from '../components/ApiFile';
import { isNative, shareText } from '../../mobile/native';

type Msg = { id: string; role: 'user' | 'assistant'; content: string; meta: any; created_at: string; pending?: boolean };
type ToolEv = { id: string; name: string; status: string; summary?: string; error?: string; actionId?: string; result?: any };

const TOOL_LABEL: Record<string, string> = {
  search_knowledge: 'Looking through your stuff', list_tasks: 'Checking to-dos', get_daily_overview: 'Reading your day',
  recall_memories: 'Remembering', read_document: 'Reading the file', web_search: 'Searching the web', parse_datetime: 'Working out the date',
  create_task: 'Adding a to-do', update_task: 'Updating a to-do', complete_task: 'Ticking it off', reopen_task: 'Reopening a to-do',
  create_reminder: 'Setting a reminder', save_memory: 'Remembering this', update_memory: 'Updating a memory', find_places: 'Finding places',
  prepare_call: 'Preparing the call', create_routine: 'Creating a routine', list_routines: 'Checking routines', delete_task: 'Delete a to-do', delete_memory: 'Forget a memory',
};

export default function Chat({ id }: { id?: string }) {
  const isNew = id === 'new' || !id;
  const { query } = useLocation();
  const wide = useMediaQuery('(min-width: 861px)');
  const [listOpen, setListOpen] = useState(false);
  const [listKey, setListKey] = useState(0);

  // "/chat" on desktop opens the most recent conversation list with an empty state; "/chat/new" creates one.
  useEffect(() => setListOpen(false), [id]);

  return (
    <Shell title={<ChatTitle id={isNew ? undefined : id} />} actions={
      <>
        <button className="btn ghost sm mobile-only" onClick={() => setListOpen((o) => !o)} aria-expanded={listOpen}><Icon name="chat" size={16} /> Chats</button>
        {id && id !== 'new' && <PrivateToggle id={id} />}
        {id && id !== 'new' && <HandoffButton kind="chat" refId={id} />}
        <Link to="/chat/new" className="btn sm"><Icon name="plus" size={16} /><span className="desktop-only">New chat</span></Link>
      </>
    }>
      <div className="chat-layout">
        <ConversationList activeId={id} open={listOpen} refreshKey={listKey} />
        {id && id !== 'new' ? (
          <Conversation key={id} id={id} onChanged={() => setListKey((k) => k + 1)} />
        ) : (
          <NewConversation initial={query.get('q') ?? ''} wide={wide} voice={query.get('voice') === '1'} />
        )}
      </div>
    </Shell>
  );
}

function ChatTitle({ id }: { id?: string }) {
  const { data } = useData<any>(id ? `/conversations/${id}` : null);
  const t = data?.conversation.title;
  // the stored placeholder until the first reply names the chat; shorter fits the phone header
  return <>{!id || t === 'New conversation' ? 'New chat' : t ?? 'Chat'}</>;
}

function ConversationList({ activeId, open, refreshKey }: { activeId?: string; open: boolean; refreshKey: number }) {
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const dq = useDebounced(q, 250);
  const { data, loading, reload } = useData<any>(`/conversations?archived=${archived ? 1 : 0}${dq ? `&q=${encodeURIComponent(dq)}` : ''}`);
  useEffect(() => {
    if (refreshKey) void reload();
  }, [refreshKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <aside className={`chat-list ${open ? 'open' : ''}`} aria-label="Conversations">
      <input className="input" placeholder="Search conversations" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search conversations" style={{ marginBottom: 8 }} />
      <div className="seg" style={{ marginBottom: 8 }}>
        <button className={!archived ? 'on' : ''} onClick={() => setArchived(false)}>Active</button>
        <button className={archived ? 'on' : ''} onClick={() => setArchived(true)}>Archived</button>
      </div>
      {loading && !data ? <div className="faint small" style={{ padding: 8 }}>Loading…</div> : null}
      {data?.conversations.length === 0 && <p className="faint small" style={{ padding: 8 }}>{dq ? 'No conversations match.' : archived ? 'No archived conversations.' : 'No conversations yet.'}</p>}
      {data?.conversations.map((c: any) => (
        <Link key={c.id} to={`/chat/${c.id}`} className={`conv ${c.id === activeId ? 'active' : ''}`}>
          <div className="t ellipsis">{c.title}</div>
          <div className="p ellipsis">{relative(c.updated_at)}{c.preview ? ` · ${c.preview}` : ''}</div>
        </Link>
      ))}
    </aside>
  );
}

function NewConversation({ initial, wide, voice }: { initial: string; wide: boolean; voice?: boolean }) {
  const toast = useToast();
  const started = useRef(false);
  const { me } = useSession();
  const configured = me!.server.providers.some((p) => p.configured);
  const mascot = useMascot();

  const start = useCallback(async (text: string, attachments: string[] = []) => {
    try {
      const conv = await post('/conversations', {});
      sessionStorage.setItem(`carino:first:${conv.id}`, JSON.stringify({ text, attachments }));
      navigate(`/chat/${conv.id}`, { replace: true });
    } catch (e: any) {
      toast(e.message, 'error');
    }
  }, [toast]);

  useEffect(() => {
    if (initial && !started.current) {
      started.current = true;
      void start(initial);
    }
  }, [initial, start]);
  // "Talk to Carino" opens a fresh conversation straight in voice mode.
  useEffect(() => {
    if (!voice || started.current || !configured) return;
    started.current = true;
    void post('/conversations', { title: 'Voice conversation' })
      .then((conv) => navigate(`/chat/${conv.id}?voice=1`, { replace: true }))
      .catch((e) => toast(e.message, 'error'));
  }, [voice, configured, toast]);

  if (initial) return <div className="chat-main" style={{ display: 'grid', placeItems: 'center' }}><Spinner lg /></div>;
  return (
    <div className="chat-main">
      <div className="chat-scroll">
        <div className="chat-thread" style={{ paddingTop: wide ? '8vh' : 12 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ display: 'grid', placeItems: 'center', paddingTop: 16 }}><Avatar size={88} accessory={mascot.accessory} /></div>
            <h2 style={{ marginTop: 14, fontSize: '1.4rem' }}>How can I help?</h2>
            <p className="muted" style={{ marginTop: 6 }}>Ask anything, plan your day, set reminders, or send me a photo or file to look at.</p>
          </div>
          {!configured && <NotConfigured />}
          <div className="quick" style={{ marginTop: 10 }}>
            {[
              ['sun', 'Plan my day', 'Look at my to-dos and reminders and help me plan today.'],
              ['bell', 'Set a reminder', 'Remind me tomorrow morning to call the bank.'],
              ['pin', 'Find a place', 'Find a good place to eat near me. Ask me where I am first.'],
              ['brain', 'What do you remember?', 'What do you remember about me and my preferences?'],
            ].map(([icon, label, prompt]) => (
              <button key={label} disabled={!configured} onClick={() => void start(prompt)}><span className="qi"><Icon name={icon} /></span>{label}</button>
            ))}
          </div>
        </div>
      </div>
      <Composer onSend={(t, a) => start(t, a)} busy={false} disabled={!configured} onVoice={() => navigate('/chat/new?voice=1')} />
    </div>
  );
}

function NotConfigured() {
  return (
    <div className="callout warning">
      <Icon name="info" size={18} style={{ flex: 'none', marginTop: 2 }} />
      <div>
        <strong>Carino needs an AI service to chat.</strong> Groq and Google Gemini are free: get a key and paste it in <Link to="/settings#ai">Settings → AI service</Link>. Your to-dos, reminders and memories work without one.
      </div>
    </div>
  );
}

function Conversation({ id, onChanged }: { id: string; onChanged: () => void }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { me, refreshCounts } = useSession();
  const { data, error, loading, reload, setData } = useData<any>(`/conversations/${id}`);
  const { query } = useLocation();
  const [voiceOn, setVoiceOn] = useState(query.get('voice') === '1');
  const [streaming, setStreaming] = useState<{ text: string; tools: ToolEv[] } | null>(null);
  const [sendError, setSendError] = useState<{ message: string; retryable: boolean; lastText: string; attachments: string[] } | null>(null);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentFirst = useRef(false);
  const configured = me!.server.providers.some((p) => p.configured);
  const active = me!.server.providers.find((p) => p.id === me!.settings.ai.provider && p.configured) ?? me!.server.providers.find((p) => p.configured);

  const scrollDown = () => requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }));

  const send = useCallback(async (text: string, attachments: string[] = [], quiet = false): Promise<string | null> => {
    let replyText: string | null = null;
    setSendError(null);
    const temp: Msg = { id: `tmp-${Date.now()}`, role: 'user', content: text, meta: { attachments: attachments.map((a) => ({ id: a })) }, created_at: new Date().toISOString(), pending: true };
    setData((d: any) => (d ? { ...d, messages: [...d.messages, temp] } : d));
    setStreaming({ text: '', tools: [] });
    scrollDown();
    const ac = new AbortController();
    abortRef.current = ac;
    let finished = false;
    try {
      await streamPost(`/conversations/${id}/messages`, { text, attachments }, (event, payload) => {
        if (event === 'start') {
          setData((d: any) => d && ({ ...d, messages: d.messages.map((m: Msg) => (m.id === temp.id ? { ...payload.userMessage, meta: payload.userMessage.meta } : m)) }));
        } else if (event === 'switch') {
          // The chosen model failed before answering; another allowed one took over.
          toast(payload.provider?.reason ?? 'Switched to another model', 'info');
        } else if (event === 'text') {
          setStreaming((s) => s && { ...s, text: s.text + payload.delta });
          scrollDown();
        } else if (event === 'tool') {
          setStreaming((s) => {
            if (!s) return s;
            const others = s.tools.filter((t) => t.id !== payload.id);
            return { ...s, tools: [...others, payload] };
          });
          if (payload.status === 'pending_approval') refreshCounts();
        } else if (event === 'message') {
          finished = true;
          if (payload.message) setData((d: any) => d && ({ ...d, messages: [...d.messages, payload.message] }));
          replyText = payload.message?.content ?? null;
          setStreaming(null);
          if (!quiet && me!.settings.voice.speakReplies && payload.message?.content) speak(payload.message.content, { lang: me!.settings.voice.language, voiceName: me!.settings.voice.voiceName });
        } else if (event === 'error') {
          finished = true;
          setStreaming(null);
          setSendError({ message: payload.message, retryable: payload.retryable, lastText: text, attachments });
        }
      }, ac.signal);
    } catch (e: any) {
      setStreaming(null);
      if (e?.name === 'AbortError') {
        toast('Stopped.');
      } else {
        setSendError({ message: e.message, retryable: e instanceof ApiError ? e.retryable : true, lastText: text, attachments });
        setData((d: any) => d && ({ ...d, messages: d.messages.filter((m: Msg) => m.id !== temp.id) }));
      }
    } finally {
      abortRef.current = null;
      if (!finished) setStreaming(null);
      await reload();
      onChanged();
      scrollDown();
    }
    return replyText;
  }, [id, me, onChanged, refreshCounts, reload, setData, toast]);

  // A conversation started from Home or "New chat" carries its first message here.
  useEffect(() => {
    if (sentFirst.current || !data) return;
    const raw = sessionStorage.getItem(`carino:first:${id}`);
    if (!raw) return;
    sentFirst.current = true;
    sessionStorage.removeItem(`carino:first:${id}`);
    const { text, attachments } = JSON.parse(raw);
    void send(text, attachments);
  }, [data, id, send]);

  useEffect(() => {
    if (data) scrollDown();
  }, [!!data]); // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = async () => {
    abortRef.current?.abort();
    await post(`/conversations/${id}/cancel`).catch(() => undefined);
  };

  const conv = data?.conversation;

  const summarize = async () => {
    setMenu(false);
    const save = await confirm({ title: 'Summarise this conversation?', body: 'Carino will write a short summary of decisions and next steps. Save it to long-term memory too, so future conversations can use it?', confirm: 'Summarise & remember' });
    try {
      toast('Summarising…');
      const r = await post(`/conversations/${id}/summarize`, { save });
      toast(save ? 'Summary saved to memory' : 'Summary ready');
      setData((d: any) => d && ({ ...d, conversation: { ...d.conversation, summary: r.summary } }));
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <div className="chat-main">
      <div className="row" style={{ padding: '8px 16px', borderBottom: '1px solid var(--border)', gap: 6 }}>
        <span className="badge brand" title="Active AI provider">
          {active ? `${active.label} · ${active.model}` : 'No AI provider'}
        </span>
        <span className="spacer" />
        <div style={{ position: 'relative' }}>
          <button className="btn ghost icon sm" onClick={() => setMenu((m) => !m)} aria-label="Conversation options" aria-expanded={menu}><Icon name="more" /></button>
          {menu && (
            <div className="card" style={{ position: 'absolute', right: 0, top: 36, zIndex: 25, minWidth: 220, padding: 6, boxShadow: 'var(--shadow-2)' }} role="menu">
              <button className="nav-item" role="menuitem" onClick={() => { setMenu(false); setRenaming(true); }}><Icon name="edit" size={16} />Rename</button>
              <button className="nav-item" role="menuitem" onClick={summarize}><Icon name="sparkle" size={16} />Summarise & remember</button>
              <button className="nav-item" role="menuitem" onClick={async () => { setMenu(false); await patch(`/conversations/${id}`, { archived: !conv.archived }); toast(conv.archived ? 'Restored' : 'Archived'); onChanged(); reload(); }}>
                <Icon name="archive" size={16} />{conv?.archived ? 'Unarchive' : 'Archive'}
              </button>
              <button className="nav-item" role="menuitem" style={{ color: 'var(--danger)' }} onClick={async () => {
                setMenu(false);
                if (!(await confirm({ title: 'Delete this conversation?', body: 'All its messages will be permanently deleted. Saved memories, to-dos and reminders are kept.', confirm: 'Delete', danger: true }))) return;
                await del(`/conversations/${id}`);
                onChanged();
                navigate('/chat/new', { replace: true });
              }}><Icon name="trash" size={16} />Delete</button>
            </div>
          )}
        </div>
      </div>
      <div className="chat-scroll" ref={scrollRef}>
        <div className="chat-thread" aria-live="polite">
          <ErrorBox error={error} retry={reload} />
          {loading && !data && <div style={{ textAlign: 'center' }}><Spinner lg /></div>}
          {conv?.summary && (
            <details className="card pad small"><summary style={{ cursor: 'pointer', fontWeight: 600 }}>Conversation summary</summary><div style={{ marginTop: 8 }}><Markdown text={conv.summary} /></div></details>
          )}
          {data?.messages.length === 0 && !streaming && <Empty icon="chat" title="Start the conversation">Type a message below.</Empty>}
          {data?.messages.map((m: Msg, i: number) => <MessageView key={m.id} m={m} onAnswer={!streaming && i === data.messages.length - 1 ? (t: string) => void send(t) : undefined} />)}
          {streaming && (
            <div className="msg assistant">
              <div className="avatar"><Mark size={30} /></div>
              <div className="body">
                <ToolChips tools={streaming.tools} />
                {streaming.text ? <Markdown text={streaming.text} /> : <div className="typing" aria-label="Carino is thinking"><span /><span /><span /></div>}
              </div>
            </div>
          )}
          {data?.pendingActions?.map((a: any) => (
            <ApprovalCard key={a.id} action={a} onDecided={() => reload()} />
          ))}
          {sendError && (
            <div className="callout danger" role="alert">
              <Icon name="alert" size={18} style={{ flex: 'none', marginTop: 2 }} />
              <div className="grow">{sendError.message}</div>
              {sendError.retryable && <button className="btn sm" onClick={() => send(sendError.lastText, sendError.attachments)}><Icon name="refresh" size={14} />Retry</button>}
            </div>
          )}
          {!configured && <NotConfigured />}
        </div>
      </div>
      <Composer onSend={send} busy={!!streaming} onCancel={cancel} disabled={!configured} onVoice={() => setVoiceOn(true)} />
      {voiceOn && <VoiceMode send={(t) => send(t, [], true)} onClose={() => { setVoiceOn(false); stopSpeaking(); if (query.get('voice')) navigate(`/chat/${id}`, { replace: true }); }} />}
      {renaming && conv && <RenameModal conv={conv} onClose={() => setRenaming(false)} onSaved={() => { reload(); onChanged(); }} />}
    </div>
  );
}

function RenameModal({ conv, onClose, onSaved }: { conv: any; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(conv.title);
  const toast = useToast();
  return (
    <Modal title="Rename conversation" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={async () => { try { await patch(`/conversations/${conv.id}`, { title }); onSaved(); onClose(); } catch (e: any) { toast(e.message, 'error'); } }}>Save</button></>}>
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" maxLength={200} />
    </Modal>
  );
}

function ToolChips({ tools }: { tools: ToolEv[] }) {
  if (!tools?.length) return null;
  return (
    <div style={{ marginBottom: 6 }}>
      {tools.map((t) => {
        const cls = t.status === 'running' ? '' : t.status === 'error' ? 'error' : t.status === 'pending_approval' ? 'pending' : 'done';
        const label = t.status === 'pending_approval' ? `Awaiting approval: ${t.summary}` : t.status === 'error' ? `${TOOL_LABEL[t.name] ?? t.name} failed` : t.summary ?? TOOL_LABEL[t.name] ?? t.name;
        return (
          <span key={t.id} className={`tool-chip ${cls}`} title={t.error ?? t.summary}>
            {t.status === 'running' ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Icon name={t.status === 'error' ? 'alert' : t.status === 'pending_approval' ? 'shield' : 'check'} size={12} />}
            <span className="ellipsis" style={{ maxWidth: 360 }}>{label}</span>
            {t.result?.download_url && <a href={t.result.download_url} style={{ fontWeight: 700 }}>Download</a>}
          </span>
        );
      })}
    </div>
  );
}

/** A question from Carino with answers to tap; the pick is sent as the next message. */
function AskCard({ q, onAnswer }: { q: { question: string; options: string[]; allow_other?: boolean; multiple?: boolean }; onAnswer?: (t: string) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [other, setOther] = useState('');
  const toggle = (o: string) => setPicked((p) => (p.includes(o) ? p.filter((x) => x !== o) : [...p, o]));
  return (
    <div className="card pad ask-card" style={{ margin: '6px 0' }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>{q.question}</div>
      <div className="row wrap" style={{ gap: 8 }}>
        {q.options.map((o) => (
          <button key={o} className={`btn sm ${q.multiple && picked.includes(o) ? 'primary' : ''}`} disabled={!onAnswer} aria-pressed={q.multiple ? picked.includes(o) : undefined}
            onClick={() => (q.multiple ? toggle(o) : onAnswer?.(o))}>{o}</button>
        ))}
      </div>
      {q.allow_other && onAnswer && (
        <form className="row" style={{ gap: 8, marginTop: 8 }} onSubmit={(e) => { e.preventDefault(); if (!q.multiple && other.trim()) onAnswer(other.trim()); }}>
          <input className="input grow" placeholder="Something else…" value={other} onChange={(e) => setOther(e.target.value)} aria-label="Your own answer" />
        </form>
      )}
      {q.multiple && onAnswer && (
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="btn primary sm" disabled={!picked.length && !other.trim()} onClick={() => onAnswer([...picked, ...(other.trim() ? [other.trim()] : [])].join(', '))}>Send</button>
        </div>
      )}
    </div>
  );
}

function MessageView({ m, onAnswer }: { m: Msg; onAnswer?: (t: string) => void }) {
  const toast = useToast();
  const { me } = useSession();
  const [speaking, setSpeaking] = useState(false);
  if (m.role === 'user') {
    return (
      <div className="msg user">
        <div className="bubble" style={{ opacity: m.pending ? 0.7 : 1 }}>
          {m.meta?.attachments?.length > 0 && (
            <div>{m.meta.attachments.map((a: any) => a.kind === 'image'
              ? <span key={a.id} className="attach-thumb"><ApiImg src={`/api/documents/${a.id}/preview`} alt={a.filename ?? 'Attached image'} loading="lazy" /></span>
              : <span key={a.id} className="attach-chip"><Icon name="paperclip" size={12} />{a.filename ?? 'Attachment'}</span>)}</div>
          )}
          {m.content}
        </div>
      </div>
    );
  }
  const meta = m.meta ?? {};
  return (
    <div className="msg assistant">
      <div className="avatar"><Mark size={30} /></div>
      <div className="body">
        <ToolChips tools={(meta.tools ?? []).filter((t: ToolEv) => t.name !== 'ask_user')} />
        {(meta.tools ?? []).filter((t: ToolEv) => t.name === 'ask_user' && t.result?.options).map((t: ToolEv) => <AskCard key={t.id} q={t.result} onAnswer={onAnswer} />)}
        {m.content ? <Markdown text={m.content} /> : <p className="faint small">(No text reply)</p>}
        {meta.sources?.length > 0 && (
          <div className="sources" aria-label="Sources">
            {meta.sources.map((s: any, i: number) => s.url
              ? <a key={i} className="source ellipsis" href={s.url} target="_blank" rel="noopener noreferrer nofollow" title={s.snippet}><Icon name="globe" size={11} /> {s.title}</a>
              : <span key={i} className="source ellipsis" title={s.snippet}><Icon name="file" size={11} /> {s.title}</span>)}
          </div>
        )}
        {meta.memoriesUsed?.length > 0 && (
          <details className="mem-used">
            <summary>Used {meta.memoriesUsed.length} saved memor{meta.memoriesUsed.length === 1 ? 'y' : 'ies'} as context</summary>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{meta.memoriesUsed.map((x: any) => <li key={x.id}>{x.content}</li>)}</ul>
          </details>
        )}
        <div className="msg-actions">
          <button className="btn ghost sm" onClick={() => { void navigator.clipboard.writeText(m.content); toast('Copied'); }}><Icon name="copy" size={14} />Copy</button>
          {me!.settings.voice.enabled && 'speechSynthesis' in window && (
            <button className="btn ghost sm" onClick={() => { if (speaking) { stopSpeaking(); setSpeaking(false); } else { speak(m.content, { lang: me!.settings.voice.language, voiceName: me!.settings.voice.voiceName }); setSpeaking(true); } }}>
              <Icon name={speaking ? 'stop' : 'speaker'} size={14} />{speaking ? 'Stop' : 'Listen'}
            </button>
          )}
          <RememberThis text={m.content} />
          <ShareReply text={m.content} />
          <Rating m={m} />
          {meta.model && <span className="faint tiny" style={{ alignSelf: 'center', marginLeft: 6 }} title={meta.route ? `Why this model: ${meta.route}` : undefined}>{meta.model}</span>}
        </div>
      </div>
    </div>
  );
}

/** Shares a reply through the phone's share sheet (WhatsApp, Telegram, email…), or copies it. */
function ShareReply({ text }: { text: string }) {
  const toast = useToast();
  const plain = text.replace(/\n\n> [⚠ℹ][\s\S]*$/u, '');
  return (
    <button className="btn ghost sm" onClick={async () => {
      if (isNative || 'share' in navigator) return shareText(plain);
      window.open(`https://wa.me/?text=${encodeURIComponent(plain.slice(0, 3000))}`, '_blank', 'noopener');
      toast('Opening WhatsApp…');
    }}><Icon name="send" size={14} />Share</button>
  );
}

/** Thumbs up/down on a reply, kept with the message so you can find good and bad answers later. */
function Rating({ m }: { m: Msg }) {
  const [r, setR] = useState<number>(m.meta?.rating ?? 0);
  const rate = async (v: number) => {
    const next = r === v ? 0 : v;
    setR(next);
    await patch(`/messages/${m.id}/rating`, { rating: next }).catch(() => setR(r));
  };
  return (
    <>
      <button className={`btn ghost icon sm ${r === 1 ? 'rated' : ''}`} aria-pressed={r === 1} aria-label="Good reply" onClick={() => rate(1)}>👍</button>
      <button className={`btn ghost icon sm ${r === -1 ? 'rated' : ''}`} aria-pressed={r === -1} aria-label="Bad reply" onClick={() => rate(-1)}>👎</button>
    </>
  );
}

function RememberThis({ text }: { text: string }) {
  const toast = useToast();
  return (
    <button className="btn ghost sm" onClick={async () => {
      try {
        await post('/memories', { content: text.replace(/\s+/g, ' ').trim().slice(0, 1900) });
        toast('Remembered', 'info', { label: 'See memories', run: () => navigate('/memory') });
      } catch (e: any) {
        toast(e.message, 'error');
      }
    }}><Icon name="brain" size={14} />Remember this</button>
  );
}

function Composer({ onSend, busy, onCancel, disabled, onVoice }: { onSend: (text: string, attachments: string[]) => void; busy: boolean; onCancel?: () => void; disabled?: boolean; onVoice?: () => void }) {
  const { me } = useSession();
  const toast = useToast();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<{ id: string; filename: string; kind?: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [locating, setLocating] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const voice = useDictation(me!.settings.voice.language, (t) => setText((x) => (x ? `${x} ${t}` : t)));

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t || busy || disabled) return;
    onSend(t, files.map((f) => f.id));
    setText('');
    setFiles([]);
  };

  const attach = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    try {
      for (const original of [...list].slice(0, 5 - files.length)) {
        // Videos become a few still frames, which any model that reads images can look at. The
        // video itself is kept too (up to 50 MB), so Carino can pass it on, e.g. to TikTok.
        const isVideo = original.type.startsWith('video/');
        const parts = isVideo ? await videoFrames(original) : [original];
        if (isVideo && original.size <= 50 * 1024 * 1024 && /^video\/(mp4|quicktime|webm)$/.test(original.type)) parts.unshift(original);
        if (isVideo) toast(`Took ${parts.length - (parts[0] === original ? 1 : 0)} frames from the video for Carino to look at`);
        for (const f of parts) {
          const r = await upload(f);
          setFiles((x) => [...x, { id: r.document.id, filename: r.document.filename, kind: r.document.kind }]);
        }
      }
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="composer-wrap">
      <div className="composer" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void attach(e.dataTransfer.files); }}>
        {files.length > 0 && (
          <div style={{ padding: '4px 6px 0' }}>
            {files.map((f) => (
              <span key={f.id} className="attach-chip">{f.kind === 'image' ? <ApiImg className="chip-thumb" src={`/api/documents/${f.id}/preview`} alt="" /> : <Icon name="paperclip" size={12} />}{f.filename}
                <button className="btn ghost icon sm" style={{ width: 20, height: 20 }} onClick={() => setFiles(files.filter((x) => x.id !== f.id))} aria-label={`Remove ${f.filename}`}><Icon name="x" size={12} /></button>
              </span>
            ))}
          </div>
        )}
        <label htmlFor="composer" className="sr-only">Message Carino</label>
        <textarea
          id="composer" ref={taRef} data-composer rows={1} value={voice.interim ? `${text} ${voice.interim}` : text}
          placeholder={disabled ? 'Connect an AI provider to chat' : voice.listening ? 'Listening…' : `Message ${me!.settings.profile.assistantName || 'Carino'}…${coarsePointer() ? '' : '  (Enter to send, Shift+Enter for a new line)'}`}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="bar">
          <input ref={fileRef} type="file" hidden multiple accept={`.pdf,.txt,.md,.markdown,.docx,.csv,.xlsx,${IMAGE_ACCEPT},video/*`} onChange={(e) => attach(e.target.files)} />
          <button className="btn ghost icon sm" onClick={() => fileRef.current?.click()} disabled={uploading || disabled} aria-label="Attach a file" title="Attach a photo, PDF, Word, text, CSV or Excel file">
            {uploading ? <Spinner /> : <Icon name="paperclip" size={17} />}
          </button>
          {me!.settings.voice.enabled && voice.supported && (
            <button className={`btn ghost icon sm ${voice.listening ? 'recording' : ''}`} onClick={voice.listening ? voice.stop : voice.start} disabled={disabled} aria-label={voice.listening ? 'Stop recording' : 'Voice input'} aria-pressed={voice.listening}>
              <Icon name={voice.listening ? 'stop' : 'mic'} size={17} />
            </button>
          )}
          {'geolocation' in navigator && (
            <button className="btn ghost icon sm" disabled={disabled || locating} aria-label="Add my location" title="Add my current location (for nearby places)" onClick={() => {
              setLocating(true);
              navigator.geolocation.getCurrentPosition(
                (p) => {
                  setLocating(false);
                  const loc = `[My location: ${p.coords.latitude.toFixed(4)}, ${p.coords.longitude.toFixed(4)} (±${Math.round(p.coords.accuracy)} m)]`;
                  setText((x) => (x ? `${x} ${loc}` : loc));
                  taRef.current?.focus();
                },
                (e) => { setLocating(false); toast(e.code === 1 ? 'Location access was blocked. Allow it in your browser’s site settings.' : 'Couldn’t get your location.', 'error'); },
                { enableHighAccuracy: false, timeout: 15_000, maximumAge: 300_000 },
              );
            }}>{locating ? <Spinner /> : <Icon name="pin" size={17} />}</button>
          )}
          {onVoice && me!.settings.voice.enabled && voice.supported && (
            <button className="btn ghost icon sm" onClick={onVoice} disabled={disabled || busy} aria-label="Voice conversation" title="Talk hands-free (voice mode)"><Icon name="speaker" size={17} /></button>
          )}
          <span className="grow faint tiny" style={{ paddingLeft: 4 }}>
            {voice.listening ? '● Recording — processed by your browser’s speech service' : voice.error ?? ''}
          </span>
          {busy ? (
            <button className="btn sm" onClick={onCancel} aria-label="Stop generating"><Icon name="stop" size={14} />Stop</button>
          ) : (
            <button className="btn primary icon sm" onClick={submit} disabled={!text.trim() || disabled} aria-label="Send"><Icon name="send" size={16} /></button>
          )}
        </div>
      </div>
      <PrivacyLine />
    </div>
  );
}


/** Takes up to four evenly spaced still frames from a video, as JPEG files. */
async function videoFrames(file: File, count = 4): Promise<File[]> {
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.src = url;
    await new Promise<void>((ok, fail) => { v.onloadedmetadata = () => ok(); v.onerror = () => fail(new Error('This video format can’t be read in the browser.')); });
    const duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 1;
    const scale = Math.min(1, 1280 / Math.max(v.videoWidth || 1280, v.videoHeight || 720));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round((v.videoWidth || 1280) * scale);
    canvas.height = Math.round((v.videoHeight || 720) * scale);
    const out: File[] = [];
    for (let i = 0; i < count; i++) {
      v.currentTime = Math.min(duration - 0.05, (duration * (i + 0.5)) / count);
      await new Promise<void>((ok) => { v.onseeked = () => ok(); });
      canvas.getContext('2d')!.drawImage(v, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.82));
      if (blob) out.push(new File([blob], `${file.name.replace(/\.[^.]+$/, '')}-frame-${i + 1}.jpg`, { type: 'image/jpeg' }));
    }
    if (!out.length) throw new Error('Couldn’t take frames from this video.');
    return out;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Phones and tablets: no keyboard hints in the message box (they wrap and don't apply). */
function coarsePointer() {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

/** Says plainly where a message goes: kept on this device, or sent to an online AI service. */
function PrivacyLine() {
  const { me } = useSession();
  const providers = me!.server.providers;
  const active = providers.find((p) => p.id === me!.settings.ai.provider && p.configured) ?? providers.find((p) => p.configured);
  if (!active) return null;
  const local = active.capabilities.local;
  return (
    <p className={`privacy-line tiny ${local ? 'local' : ''}`}>
      <Icon name={local ? 'lock' : 'globe'} size={12} />
      {local
        ? <> Stays on this device: answered by {active.label}.</>
        : <> Sent to {active.label} (online) to be answered, with the memories and file text it needs. <Link to="/settings#ai">Change</Link></>}
    </p>
  );
}

/**
 * Keeps this chat on the user's own devices: only local models answer it, and nothing from it is
 * sent online. Once it has used content kept on the devices, it stays private.
 */
function PrivateToggle({ id }: { id: string }) {
  const toast = useToast();
  const { data, setData } = useData<any>(`/conversations/${id}`);
  const lo = Number(data?.conversation?.local_only ?? 0);
  if (!data) return null;
  const toggle = async () => {
    try {
      const r = await patch<any>(`/conversations/${id}/local-only`, { local_only: !lo });
      setData((d: any) => d && ({ ...d, conversation: { ...d.conversation, local_only: r.local_only ? (r.locked ? 2 : 1) : 0 } }));
      toast(r.local_only ? 'Private: only AI on your devices will answer this chat' : 'Online AI may answer this chat again');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <button className={`btn ghost sm ${lo ? 'on' : ''}`} aria-pressed={!!lo} onClick={toggle} disabled={lo === 2}
      title={lo === 2 ? 'This chat used content you keep on your devices, so it stays private' : lo ? 'Private: only AI on your devices' : 'Make this chat private'}>
      <Icon name="lock" size={15} /><span className="desktop-only">{lo ? 'Private' : 'Make private'}</span>
    </button>
  );
}
