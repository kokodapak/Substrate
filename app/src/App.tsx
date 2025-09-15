import React, { useEffect, useMemo, useRef, useState } from 'react';

type ModeKey = 'conversation' | 'ielts' | 'pronunciation';
type Session = { id: string; mode: ModeKey; title: string; messages: Msg[]; updatedAt: string };
type User = { email: string; name?: string; role?: 'student' | 'coach' | 'admin' };

type Role = 'user' | 'assistant';
type Msg = { id: string; role: Role; content: string; assist?: string | null };

const API_BASE = '';
const uid = () => Math.random().toString(36).slice(2, 9);

export default function App() {
  const [messages, setMessages] = useState<Msg[]>([{
    id: uid(), role: 'assistant', content: "Hi! I’m Cô Lan, your speaking coach. What’s your name? And why are you practicing English today?",
  }]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [user, setUser] = useState<User>(() => {
    const s = localStorage.getItem('flor.user');
    return s ? JSON.parse(s) : { email: 'guest@example.com' };
  });
  const [mode, setMode] = useState<ModeKey>(() => (localStorage.getItem('flor.mode') as ModeKey) || 'conversation');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string>('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [voice, setVoice] = useState<string>(() => localStorage.getItem('flor.voice') || 'verse');
  const [systemPrompt, setSystemPrompt] = useState<string>(() => localStorage.getItem('flor.prompt') || '');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // Load sessions for user+mode
  useEffect(() => {
    const load = async () => {
      try {
        const q = new URLSearchParams({ user: user.email, mode }).toString();
        const r = await fetch(`/api/sessions?${q}`);
        const j = await r.json();
        const list: Session[] = j.sessions || [];
        setSessions(list);
        if (list.length) {
          setActiveSessionId(list[0].id);
          setMessages(list[0].messages || []);
        } else {
          const s: Session = { id: uid(), mode, title: 'New chat', messages: messages, updatedAt: new Date().toISOString() };
          setSessions([s]);
          setActiveSessionId(s.id);
          await saveSession(s);
        }
      } catch {}
    };
    load();
    localStorage.setItem('flor.mode', mode);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.email, mode]);

  const saveSession = async (s: Session) => {
    try {
      s.updatedAt = new Date().toISOString();
      await fetch('/api/sessions/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: user.email, session: s })
      });
    } catch {}
  };

  const syncActiveSession = async (next: Msg[]) => {
    setSessions(prev => prev.map(ss => ss.id === activeSessionId ? { ...ss, messages: next, updatedAt: new Date().toISOString() } : ss));
    const s = sessions.find(ss => ss.id === activeSessionId);
    if (s) await saveSession({ ...s, messages: next });
  };

  const sendText = async () => {
    const text = input.trim();
    if (!text) return;
    const user: Msg = { id: uid(), role: 'user', content: text };
    setMessages(m => {
      const next = [...m, user];
      syncActiveSession(next);
      return next;
    });
    setInput('');
    setSending(true);
    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, messages: messages.slice(-20).map(m => ({ role: m.role, content: m.content })) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Chat failed');
      const ai = data?.reply ?? 'Sorry, I didn’t catch that.';
      const assist = data?.assist ?? null;
      const bot: Msg = { id: uid(), role: 'assistant', content: ai, assist };
      setMessages(m => { const next = [...m, bot]; syncActiveSession(next); return next; });
      // TTS via server
      playVoice(ai).catch(() => {});
    } catch (e: any) {
      alert(e?.message || 'Network error');
    } finally {
      setSending(false);
    }
  };

  // Legacy record removed per request – relying on live voice and text input

  const playVoice = async (text: string) => {
    const url = `${API_BASE}/api/voice?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(voice)}`;
    const a = new Audio(url);
    a.play().catch(() => {});
  };

  // --- Realtime live voice (WebRTC with OpenAI) ---
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const liveAudioRef = useRef<HTMLAudioElement | null>(null);
  const eventsChanRef = useRef<RTCDataChannel | null>(null);
  const [liveOn, setLiveOn] = useState(false);
  const [liveUserPartial, setLiveUserPartial] = useState('');
  const [liveAssistantPartial, setLiveAssistantPartial] = useState('');
  const startLive = async () => {
    try {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      pcRef.current = pc;
      pc.addTransceiver('audio', { direction: 'sendrecv' });
      pc.ontrack = (e) => {
        const [stream] = e.streams;
        if (stream) {
          if (!liveAudioRef.current) {
            liveAudioRef.current = new Audio();
            liveAudioRef.current.autoplay = true;
          }
          liveAudioRef.current.srcObject = stream as any;
        }
      };
      pc.ondatachannel = (ev) => {
        const ch = ev.channel;
        eventsChanRef.current = ch;
        let userAcc = '';
        let assistantAcc = '';
        ch.onmessage = (msg) => {
          try {
            const evt = JSON.parse((msg.data as string) || '{}');
            const t = evt.type as string | undefined;
            // Heuristics for Realtime event types
            if (t?.includes('input') && t?.includes('transcript') && t?.includes('delta')) {
              userAcc += evt.delta || evt.text || '';
              setLiveUserPartial(userAcc);
            } else if (t?.includes('input') && t?.includes('transcript') && (t?.includes('completed') || t?.includes('done'))) {
              const text = (userAcc || evt.text || '').trim();
              if (text) setMessages(m => [...m, { id: uid(), role: 'user', content: text }]);
              userAcc = '';
              setLiveUserPartial('');
            } else if (t === 'response.output_text.delta') {
              assistantAcc += evt.delta || '';
              setLiveAssistantPartial(assistantAcc);
            } else if (t === 'response.completed') {
              const text = (assistantAcc || '').trim();
              if (text) setMessages(m => [...m, { id: uid(), role: 'assistant', content: text }]);
              assistantAcc = '';
              setLiveAssistantPartial('');
            }
          } catch {
            // ignore
          }
        };
      };
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      mic.getTracks().forEach((t) => pc.addTrack(t, mic));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const resp2 = await fetch('/api/realtime/sdp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp: offer.sdp || '', voice, mode, instructions: systemPrompt || undefined }),
      });
      const answer = await resp2.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      setLiveOn(true);
    } catch (e: any) {
      alert(e?.message || 'Failed to start live voice');
    }
  };
  const stopLive = () => {
    try { pcRef.current?.close(); } catch {}
    pcRef.current = null;
    try { eventsChanRef.current?.close(); } catch {}
    eventsChanRef.current = null;
    setLiveOn(false);
    setLiveAssistantPartial('');
    setLiveUserPartial('');
  };

  return (
    <div style={{ display: 'flex', height: '100vh', background: '#0d0f12', color: '#e6e7e9' }}>
      <div style={{ flex: 1, maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column' }}>
        <header style={{ padding: 12, borderBottom: '1px solid #262a30', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 700 }}>FlorAI (Web)</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={liveOn ? stopLive : startLive} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #262a30', background: liveOn ? '#10a37f' : '#161a20', color: '#e6e7e9' }}>
              {liveOn ? '● Live' : '🗣️ Go Live'}
            </button>
            <button onClick={() => setSettingsOpen(v => !v)} style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid #262a30', background: '#161a20', color: '#e6e7e9' }}>
              ⚙️ Settings
            </button>
          </div>
        </header>
        <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          {messages.map(m => (
            <div key={m.id} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', margin: '6px 0' }}>
              <div style={{ maxWidth: '80%', padding: '10px 14px', borderRadius: 14, background: m.role === 'user' ? '#10a37f' : '#161a20', color: m.role === 'user' ? '#fff' : '#e6e7e9', border: m.role === 'assistant' ? '1px solid #262a30' : undefined }}>
                <div>{m.content}</div>
                {m.assist && m.role === 'assistant' ? (
                  <div style={{ marginTop: 6, fontSize: 13, color: '#9aa0a6' }}>({m.assist})</div>
                ) : null}
              </div>
            </div>
          ))}
          {!!liveUserPartial && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '6px 0', opacity: 0.8 }}>
              <div style={{ maxWidth: '80%', padding: '10px 14px', borderRadius: 14, background: '#10a37f', color: '#fff' }}>{liveUserPartial}</div>
            </div>
          )}
          {!!liveAssistantPartial && (
            <div style={{ display: 'flex', justifyContent: 'flex-start', margin: '6px 0', opacity: 0.8 }}>
              <div style={{ maxWidth: '80%', padding: '10px 14px', borderRadius: 14, background: '#161a20', color: '#e6e7e9', border: '1px solid #262a30' }}>{liveAssistantPartial}</div>
            </div>
          )}
        </div>
        <footer style={{ padding: 12, borderTop: '1px solid #262a30', position: 'relative' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <textarea value={input} onChange={e => setInput(e.target.value)} placeholder="Message Cô Lan" rows={2} style={{ flex: 1, background: '#161a20', color: '#e6e7e9', border: '1px solid #262a30', borderRadius: 10, padding: 10 }} />
            <button disabled={sending || !input.trim()} onClick={sendText} style={{ padding: '10px 14px', borderRadius: 10, border: '1px solid #262a30', background: '#10a37f', color: '#fff' }}>Send</button>
          </div>
          {settingsOpen && (
            <div style={{ position: 'absolute', right: 12, bottom: 56, width: 360, background: '#161a20', border: '1px solid #262a30', borderRadius: 10, padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>Settings</div>
              <label style={{ display: 'block', marginBottom: 8 }}>Voice
                <select value={voice} onChange={(e) => { setVoice(e.target.value); localStorage.setItem('flor.voice', e.target.value); }} style={{ width: '100%', marginTop: 4, background: '#0d0f12', color: '#e6e7e9', border: '1px solid #262a30', borderRadius: 6, padding: 6 }}>
                  <option value="verse">verse (natural)</option>
                  <option value="alloy">alloy</option>
                  <option value="orion">orion</option>
                </select>
              </label>
              <label style={{ display: 'block', marginBottom: 8 }}>System Prompt (optional)
                <textarea value={systemPrompt} onChange={(e) => { setSystemPrompt(e.target.value); localStorage.setItem('flor.prompt', e.target.value); }} placeholder="Additional instructions for Cô Lan..." rows={4} style={{ width: '100%', marginTop: 4, background: '#0d0f12', color: '#e6e7e9', border: '1px solid #262a30', borderRadius: 6, padding: 6 }} />
              </label>
              <div style={{ textAlign: 'right' }}>
                <button onClick={() => setSettingsOpen(false)} style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #262a30', background: '#0d0f12', color: '#e6e7e9' }}>Close</button>
              </div>
            </div>
          )}
        </footer>
      </div>
    </div>
  );
}
