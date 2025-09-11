import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  FlatList,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Speech from 'expo-speech';
import { Audio } from 'expo-av';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

const API_BASE = 'http://192.168.4.223:8787'; // on real phone, use my Mac's LAN IP

type Role = 'user' | 'assistant';
type Msg = { id: string; role: Role; content: string; assist?: string | null; ttsLang?: string | null };
type Session = { id: string; title: string; createdAt: number; messages: Msg[] };
type WorkspaceKey = 'lets' | 'ielts' | 'pron';
type WorkspaceDef = { key: WorkspaceKey; name: string; prompt: string; greet: string };
type Account = {
  signedIn: boolean;
  email?: string;
  plan: 'flor' | 'flor_plus';
  payment?: { brand?: string; last4?: string } | null;
};

function uid() {
  return Math.random().toString(36).slice(2, 9);
}

type Theme = 'light' | 'dark';

export default function App() {
  const [theme, setTheme] = useState<Theme>('dark'); // default: dark
  const [messages, setMessages] = useState<Msg[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [hearing, setHearing] = useState(false);
  const busy = sending || hearing;

  const listRef = useRef<FlatList<Msg>>(null);

  // Workspaces
  const WORKSPACES: WorkspaceDef[] = [
    {
      key: 'lets',
      name: "Let's Chat",
      greet: "Hey! I'm glad you're back. What are you up to?",
      prompt:
        "You are Cô Lan in friendly conversation mode. Keep turns short, natural, and supportive. Share light questions and small talk while subtly coaching grammar/pronunciation with micro-feedback after each turn (1–3 bullets). Encourage the learner to speak more than you.",
    },
    {
      key: 'ielts',
      name: 'IELTS Study',
      greet: 'Welcome back. Let’s continue your IELTS Speaking practice. Ready for a short warm-up? ',
      prompt:
        'You are Cô Lan in IELTS classroom mode. Be more formal, align with IELTS criteria (Fluency & Coherence, Lexical Resource, Grammatical Range & Accuracy, Pronunciation). Track learner level and progress in brief notes as context. After each section, give concise, criteria-based feedback with ranges (no official band).',
    },
    {
      key: 'pron',
      name: 'Pronunciation',
      greet: 'Let’s focus on your pronunciation today. Say a short sentence and I’ll help you polish it.',
      prompt:
        'You are Cô Lan focusing on pronunciation (VN-typical issues: /v/ vs /w/, final consonants, /θ/ /ð/, word stress). Identify mispronunciations and give quick drills and mouth-position tips. Keep turns short and practical. Sound target: clear North American English.',
    },
  ];
  const [activeWS, setActiveWS] = useState<WorkspaceKey>('lets');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [rtSpeaking, setRtSpeaking] = useState(false);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [remoteStream] = useState<any>(() => {
    try {
      // Dynamically require to avoid crashing in Expo Go
      const { MediaStream } = require('react-native-webrtc');
      return new MediaStream();
    } catch {
      return null;
    }
  });
  const [showSettings, setShowSettings] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [realtimeActive, setRealtimeActive] = useState(false);
  const [realtimeSupported] = useState<boolean>(Constants?.appOwnership !== 'expo');
  const pcRef = useRef<any>(null);
  const localStreamRef = useRef<any>(null);
  const [sessionsByWS, setSessionsByWS] = useState<Record<WorkspaceKey, { sessions: Session[]; currentId?: string }>>({
    lets: { sessions: [] },
    ielts: { sessions: [] },
    pron: { sessions: [] },
  });
  const [account, setAccount] = useState<Account>({ signedIn: false, plan: 'flor', payment: null });
  // local form state for account
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [payBrand, setPayBrand] = useState('Visa');
  const [payLast4, setPayLast4] = useState('');

  // Load persisted theme/workspace/sessions/account on start
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem('florai.store.v1');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed?.theme === 'light' || parsed?.theme === 'dark') setTheme(parsed.theme);
          if (parsed?.activeWS) setActiveWS(parsed.activeWS as WorkspaceKey);
          if (parsed?.sessionsByWS) setSessionsByWS(parsed.sessionsByWS);
          if (parsed?.account) setAccount(parsed.account as Account);
        }
      } catch {}
      setHydrated(true);
    })();
  }, []);

  // Ensure a session exists for the active workspace and bind its messages
  useEffect(() => {
    if (!hydrated) return;
    setSessionsByWS((prev) => {
      const wsState = prev[activeWS];
      if (wsState.sessions.length === 0) {
        const def = WORKSPACES.find((w) => w.key === activeWS)!;
        const session: Session = {
          id: uid(),
          title: 'New chat',
          createdAt: Date.now(),
          messages: [{ id: uid(), role: 'assistant', content: def.greet }],
        };
        const updated = { ...prev, [activeWS]: { sessions: [session], currentId: session.id } };
        setMessages(session.messages);
        return updated;
      }
      if (!wsState.currentId) {
        const first = wsState.sessions[0];
        const updated = { ...prev, [activeWS]: { ...wsState, currentId: first.id } };
        setMessages(first.messages);
        return updated;
      }
      const cur = wsState.sessions.find((s) => s.id === wsState.currentId)!;
      setMessages(cur.messages);
      return prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWS, hydrated]);

  // Persist changes
  useEffect(() => {
    if (!hydrated) return;
    const payload = JSON.stringify({ theme, activeWS, sessionsByWS, account });
    AsyncStorage.setItem('florai.store.v1', payload).catch(() => {});
  }, [theme, activeWS, sessionsByWS, account, hydrated]);

  const scrollToEnd = () => {
    listRef.current?.scrollToEnd({ animated: true });
  };

  useEffect(() => {
    // Auto scroll when messages change
    const t = setTimeout(scrollToEnd, 50);
    return () => clearTimeout(t);
  }, [messages.length]);

  const syncCurrentSession = (nextMsgs: Msg[]) => {
    setSessionsByWS((prev) => {
      const wsState = prev[activeWS];
      if (!wsState.currentId) return prev;
      const sessions = wsState.sessions.map((s) => (s.id === wsState.currentId ? { ...s, messages: nextMsgs } : s));
      return { ...prev, [activeWS]: { ...wsState, sessions } };
    });
  };

  const sendText = async (text: string) => {
    if (!text.trim()) return;
    const userMsg: Msg = { id: uid(), role: 'user', content: text.trim() };
    setMessages((m) => {
      const next = [...m, userMsg];
      syncCurrentSession(next);
      return next;
    });
    setInput('');
    setSending(true);
    try {
      const wsDef = WORKSPACES.find((w) => w.key === activeWS)!;
      const context = [...messages, userMsg].slice(-20).map((m) => ({ role: m.role, content: m.content }));
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: userMsg.content, system: wsDef.prompt, messages: context }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Chat failed');
      const ai = data?.reply ?? 'Sorry, I didn’t catch that.';
      const ttsLang = data?.tts_language || 'en-US';
      const assist = data?.assist || null;
      const streamId = uid();
      // Add placeholder assistant message that will stream in
      setMessages((m) => [...m, { id: streamId, role: 'assistant', content: '', assist: null, ttsLang }]);
      setSending(false);
      const tokens = ai.split(/(\s+)/);
      let i = 0;
      const timer = setInterval(() => {
        i++;
        setMessages((m) => m.map((msg) => (msg.id === streamId ? { ...msg, content: tokens.slice(0, i).join('') } : msg)));
        if (i >= tokens.length) {
          clearInterval(timer);
          setMessages((m) => {
            const next = m.map((msg) => (msg.id === streamId ? { ...msg, assist } : msg));
            syncCurrentSession(next);
            return next;
          });
          try {
            Speech.stop();
            setRtSpeaking(true);
            Speech.speak(ai, {
              language: ttsLang,
              rate: 1.0,
              onDone: () => setRtSpeaking(false),
              onStopped: () => setRtSpeaking(false),
            });
          } catch {}
        }
      }, 25);
      const title: string | null = data?.title || null;
      if (title) {
        setSessionsByWS((prev) => {
          const wsState = prev[activeWS];
          if (!wsState.currentId) return prev;
          const sessions = wsState.sessions.map((s) =>
            s.id === wsState.currentId && (s.title === 'New chat' || !s.title)
              ? { ...s, title }
              : s
          );
          return { ...prev, [activeWS]: { ...wsState, sessions } };
        });
      }
    } catch (e: any) {
      Alert.alert('Assistant error', e?.message || 'Network error');
    } finally {
      setSending(false);
    }
  };

  const startRec = async () => {
    try {
      await Audio.requestPermissionsAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const rec = new Audio.Recording();
      await rec.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY); // m4a on iOS
      await rec.startAsync();
      setRecording(rec);
    } catch (e) {
      Alert.alert('Mic error', 'Could not start recording.');
    }
  };

  const stopRec = async () => {
    try {
      if (!recording) return;
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      setRecording(null);
      if (!uri) return;

      setHearing(true);
      const form = new FormData();
      // @ts-ignore React Native FormData file
      form.append('audio', { uri, name: 'clip.m4a', type: 'audio/m4a' });
      const sttRes = await fetch(`${API_BASE}/api/stt`, { method: 'POST', body: form });
      const sttData = await sttRes.json();
      if (!sttRes.ok) throw new Error(sttData?.error || 'Transcription failed');
      const text = sttData?.text || '';
      if (text) await sendText(text);
    } catch (e: any) {
      Alert.alert('Transcription error', e?.message || 'Network error');
    } finally {
      setHearing(false);
    }
  };

  const renderItem = ({ item }: { item: Msg }) => {
    const isUser = item.role === 'user';
    return (
      <View style={[styles.row, isUser ? styles.rowEnd : styles.rowStart]}>
        {!isUser && (
          <View style={{ width: 28, alignItems: 'center', marginTop: 2 }}>
            <Text style={{ fontSize: 18 }}>🎓</Text>
          </View>
        )}
        <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
          <Text style={[styles.msgText, isUser ? styles.msgTextUser : styles.msgTextAssistant]}>{item.content}</Text>
          {!!item.assist && !isUser && (
            <Text style={[styles.assistText]}>({item.assist})</Text>
          )}
        </View>
        {isUser && (
          <View style={{ width: 28, alignItems: 'center', marginTop: 2 }}>
            <Text style={{ fontSize: 18 }}>🙂</Text>
          </View>
        )}
      </View>
    );
  };

  const canSend = input.trim().length > 0 && !busy;

  const palette = useMemo(() => {
    if (theme === 'dark') {
      return {
        bg: '#0d0f12',
        text: '#e6e7e9',
        border: '#262a30',
        assistantBubble: '#161a20',
        userBubble: '#10a37f',
        inputBg: '#161a20',
        placeholder: '#9AA0A6',
        sendBtnBg: '#10a37f',
        sendText: '#fff',
        composerShadow: 'rgba(0,0,0,0.25)'
      } as const;
    }
    return {
      bg: '#f7f7f8',
      text: '#111',
      border: '#e6e7e9',
      assistantBubble: '#ffffff',
      userBubble: '#10a37f',
      inputBg: '#ffffff',
      placeholder: '#9AA0A6',
      sendBtnBg: '#111',
      sendText: '#fff',
      composerShadow: 'rgba(0,0,0,0.06)'
    } as const;
  }, [theme]);

  const styles = useMemo(() => StyleSheet.create({
    safe: { flex: 1, backgroundColor: palette.bg },
    container: { flex: 1, backgroundColor: palette.bg },
    list: { padding: 12, paddingBottom: 20 },
    row: { marginVertical: 4, flexDirection: 'row' },
    rowStart: { justifyContent: 'flex-start' },
    rowEnd: { justifyContent: 'flex-end' },
    bubble: { maxWidth: '82%', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10 },
    bubbleAssistant: { backgroundColor: palette.assistantBubble, borderWidth: 1, borderColor: palette.border },
    bubbleUser: { backgroundColor: palette.userBubble },
    msgText: { fontSize: 16, lineHeight: 22 },
    msgTextAssistant: { color: palette.text },
    msgTextUser: { color: '#fff' },

    composerBar: { paddingHorizontal: 12, paddingBottom: 10 },
    inputWrap: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      backgroundColor: palette.inputBg,
      borderRadius: 22,
      borderWidth: 1,
      borderColor: palette.border,
      paddingLeft: 8,
      paddingRight: 6,
      paddingVertical: 6,
      shadowColor: '#000',
      shadowOpacity: theme === 'dark' ? 0.25 : 0.06,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 3 },
      elevation: 1,
    },
    input: { flex: 1, minHeight: 22, maxHeight: 120, fontSize: 16, paddingVertical: 6, color: palette.text },
    iconBtn: { paddingHorizontal: 10, paddingVertical: 8 },
    iconText: { fontSize: 18, color: palette.text },
    sendBtn: { backgroundColor: palette.sendBtnBg, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8, marginLeft: 6 },
    sendText: { color: palette.sendText, fontSize: 15 },
    loadingOverlay: { position: 'absolute', bottom: 75, alignSelf: 'center' },
    assistText: { marginTop: 6, fontSize: 13, color: theme === 'dark' ? '#9aa0a6' : '#555' },
  }), [palette, theme]);

  const newChat = () => {
    const def = WORKSPACES.find((w) => w.key === activeWS)!;
    const session: Session = {
      id: uid(),
      title: 'New chat',
      createdAt: Date.now(),
      messages: [{ id: uid(), role: 'assistant', content: def.greet }],
    };
    setSessionsByWS((prev) => {
      const wsState = prev[activeWS];
      const sessions = [session, ...wsState.sessions];
      return { ...prev, [activeWS]: { sessions, currentId: session.id } };
    });
    setMessages(session.messages);
    setInput('');
    setMenuOpen(false);
  };

  const clearChat = () => {
    const def = WORKSPACES.find((w) => w.key === activeWS)!;
    const seed = [{ id: uid(), role: 'assistant', content: def.greet }];
    setMessages(seed);
    syncCurrentSession(seed);
    setMenuOpen(false);
  };

  const switchWorkspace = (key: WorkspaceKey) => {
    setActiveWS(key);
    setDrawerOpen(false);
    setMenuOpen(false);
  };

  const selectSession = (sessionId: string) => {
    setSessionsByWS((prev) => {
      const wsState = prev[activeWS];
      const cur = wsState.sessions.find((s) => s.id === sessionId);
      if (cur) setMessages(cur.messages);
      return { ...prev, [activeWS]: { ...wsState, currentId: sessionId } };
    });
    setDrawerOpen(false);
  };

  // --- Low-latency voice (OpenAI Realtime via WebRTC) ---
  const startRealtime = async () => {
    try {
      if (!realtimeSupported) {
        Alert.alert('Dev build required', 'Low-latency voice needs a development build (Expo Dev Client).');
        return;
      }
      // Dynamically require to avoid crashes in Expo Go
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RTCPeerConnection, mediaDevices } = require('react-native-webrtc');

      const session = await fetch(`${API_BASE}/api/realtime/session`, { method: 'POST' }).then((r) => r.json());
      const ephemeral = session?.client_secret?.value;
      const model = session?.model || 'gpt-4o-realtime-preview-2024-12-17';
      if (!ephemeral) throw new Error('Failed to create ephemeral session');

      const pc = new RTCPeerConnection({ iceServers: [] });
      pcRef.current = pc;
      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'failed' || s === 'disconnected' || s === 'closed') stopRealtime();
      };
      pc.ontrack = (e: any) => {
        // Remote audio will play automatically in RN WebRTC
        try {
          if (remoteStream && e) {
            const track = e.streams?.[0]?.getAudioTracks?.()[0] || e.track;
            if (track && remoteStream.addTrack) remoteStream.addTrack(track);
          }
        } catch {}
        // When assistant audio arrives, mark as speaking and mute local mic
        setRtSpeaking(true);
        try {
          const ls = localStreamRef.current;
          if (ls) ls.getTracks().forEach((t: any) => (t.enabled = false));
        } catch {}
        setUserSpeaking(false);
      };

      const stream = await mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = stream;
      stream.getTracks().forEach((t: any) => { t.enabled = false; pc.addTrack(t, stream); });

      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);

      const sdpRes = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ephemeral}`, 'Content-Type': 'application/sdp' },
        body: offer.sdp,
      });
      const answerSDP = await sdpRes.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSDP });
      setRealtimeActive(true);
      Alert.alert('Voice connected', 'Low-latency voice session is active.');
    } catch (e: any) {
      Alert.alert('Realtime error', e?.message || 'Could not start low-latency voice');
      stopRealtime();
    }
  };

  const stopRealtime = () => {
    try {
      const pc = pcRef.current;
      if (pc) pc.close();
    } catch {}
    pcRef.current = null;
    try {
      const ls = localStreamRef.current;
      if (ls) ls.getTracks().forEach((t: any) => t.stop());
    } catch {}
    localStreamRef.current = null;
    setRealtimeActive(false);
    setRtSpeaking(false);
    setUserSpeaking(false);
  };

  const toggleRealtimeSpeak = async () => {
    if (!realtimeSupported) {
      Alert.alert('Dev build required', 'Low-latency voice needs a development build (Expo Dev Client).');
      return;
    }
    if (!realtimeActive) {
      await startRealtime();
      setTimeout(() => {
        try {
          const ls = localStreamRef.current;
          if (ls) {
            ls.getTracks().forEach((t: any) => (t.enabled = true));
            setUserSpeaking(true);
          }
        } catch {}
      }, 400);
      return;
    }
    try {
      const ls = localStreamRef.current;
      if (!ls) return;
      const next = !userSpeaking;
      ls.getTracks().forEach((t: any) => (t.enabled = next));
      setUserSpeaking(next);
    } catch {}
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style={theme === 'dark' ? 'light' : 'dark'} />
      <View style={styles.container}>
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10 }}>
          <TouchableOpacity onPress={() => setDrawerOpen(true)} style={{ padding: 6, marginRight: 8 }}>
            <Text style={{ fontSize: 20, color: palette.text }}>☰</Text>
          </TouchableOpacity>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600' }}>{WORKSPACES.find(w => w.key === activeWS)?.name}</Text>
          </View>
          <TouchableOpacity onPress={() => setMenuOpen((v) => !v)} style={{ padding: 6, marginLeft: 8 }}>
            <Text style={{ fontSize: 20, color: palette.text }}>⋯</Text>
          </TouchableOpacity>
        </View>

        {/* Dropdown menu */}
        {menuOpen && (
          <View style={{ position: 'absolute', right: 12, top: 52, backgroundColor: palette.inputBg, borderWidth: 1, borderColor: palette.border, borderRadius: 8, overflow: 'hidden', zIndex: 1000, elevation: 20 }}>
            <TouchableOpacity onPress={newChat} style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
              <Text style={{ color: palette.text }}>New chat</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setTheme(theme === 'dark' ? 'light' : 'dark')} style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
              <Text style={{ color: palette.text }}>Toggle theme</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={clearChat} style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
              <Text style={{ color: palette.text }}>Clear chat</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => {
                if (!realtimeSupported) {
                  Alert.alert('Dev build required', 'Low-latency voice needs a development build (Expo Dev Client).');
                  return;
                }
                if (realtimeActive) stopRealtime(); else startRealtime();
                setMenuOpen(false);
              }}
              style={{ paddingHorizontal: 14, paddingVertical: 12 }}
            >
              <Text style={{ color: palette.text }}>{realtimeActive ? 'Stop voice (low latency)' : 'Start voice (low latency)'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setShowSettings(true); setMenuOpen(false); }} style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
              <Text style={{ color: palette.text }}>Settings</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { setShowAccount(true); setMenuOpen(false); }} style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
              <Text style={{ color: palette.text }}>Account</Text>
            </TouchableOpacity>
          </View>
        )}
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={renderItem}
          contentContainerStyle={styles.list}
          onContentSizeChange={scrollToEnd}
          ListFooterComponent={sending ? (
            <View style={[styles.row, styles.rowStart]}>
              <View style={[styles.bubble, styles.bubbleAssistant]}>
                <Text style={[styles.msgTextAssistant]}>…</Text>
              </View>
            </View>
          ) : null}
        />

        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}>
          <View style={styles.composerBar}>
            <View style={styles.inputWrap}>
              <TouchableOpacity onPress={() => setTheme(theme === 'dark' ? 'light' : 'dark')} style={styles.iconBtn} accessibilityLabel="Toggle theme">
                <Text style={styles.iconText}>{theme === 'dark' ? '☀️' : '🌙'}</Text>
              </TouchableOpacity>
              <TextInput
                style={styles.input}
                value={input}
                onChangeText={setInput}
                placeholder="Message Cô Lan"
                placeholderTextColor={palette.placeholder}
                multiline
                editable={!busy}
              />
              {!canSend ? (
                realtimeActive ? (
                  <TouchableOpacity onPress={toggleRealtimeSpeak} style={styles.iconBtn}>
                    <Text style={styles.iconText}>{rtSpeaking ? '■' : '🎙️'}</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity onPress={recording ? stopRec : startRec} disabled={busy} style={styles.iconBtn}>
                    <Text style={styles.iconText}>{recording ? '■' : '🎤'}</Text>
                  </TouchableOpacity>
                )
              ) : (
                <TouchableOpacity onPress={() => sendText(input)} disabled={!canSend} style={[styles.sendBtn, !canSend && { opacity: 0.5 }] }>
                  <Text style={styles.sendText}>➤</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </KeyboardAvoidingView>
        {(sending || hearing) && (
          <View style={styles.loadingOverlay} pointerEvents="none">
            <ActivityIndicator />
          </View>
        )}
      </View>
      {/* Drawer overlay */}
      {drawerOpen && (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)', flexDirection: 'row' }}>
          <TouchableOpacity style={{ flex: 1 }} onPress={() => setDrawerOpen(false)} />
          <View style={{ width: 300, backgroundColor: palette.inputBg, borderLeftWidth: 1, borderLeftColor: palette.border, paddingTop: 12 }}>
            <Text style={{ color: palette.text, fontSize: 18, fontWeight: '700', paddingHorizontal: 12, paddingBottom: 8 }}>FlorAI</Text>
            <View style={{ paddingHorizontal: 8, paddingBottom: 12 }}>
              {WORKSPACES.map((w) => (
                <TouchableOpacity key={w.key} onPress={() => switchWorkspace(w.key)} style={{ paddingVertical: 10, paddingHorizontal: 8, borderRadius: 8, backgroundColor: activeWS === w.key ? palette.assistantBubble : 'transparent', marginVertical: 4 }}>
                  <Text style={{ color: palette.text }}>{w.name}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={{ height: 1, backgroundColor: palette.border, marginVertical: 6 }} />
            <View style={{ paddingHorizontal: 12, paddingVertical: 8, flex: 1 }}>
              <Text style={{ color: palette.text, fontSize: 12, opacity: 0.8, marginBottom: 4 }}>Chats</Text>
              {sessionsByWS[activeWS].sessions.map((s) => (
                <TouchableOpacity key={s.id} onPress={() => selectSession(s.id)} style={{ paddingVertical: 10, borderRadius: 6, paddingHorizontal: 8, backgroundColor: sessionsByWS[activeWS].currentId === s.id ? palette.assistantBubble : 'transparent', marginVertical: 2 }}>
                  <Text numberOfLines={1} style={{ color: palette.text }}>{s.title || (s.messages[0]?.content?.slice(0, 28) || 'New chat')}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity onPress={newChat} style={{ paddingVertical: 12 }}>
                <Text style={{ color: palette.text }}>+ New chat</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}
      {/* Settings overlay */}
      {showSettings && (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' }}>
          <View style={{ width: '92%', maxWidth: 520, backgroundColor: palette.inputBg, borderWidth: 1, borderColor: palette.border, borderRadius: 12, padding: 16 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <Text style={{ color: palette.text, fontSize: 18, fontWeight: '700' }}>Settings</Text>
              <TouchableOpacity onPress={() => setShowSettings(false)} style={{ padding: 6 }}>
                <Text style={{ color: palette.text, fontSize: 18 }}>✕</Text>
              </TouchableOpacity>
            </View>
            <View style={{ height: 1, backgroundColor: palette.border, marginVertical: 8 }} />
            <Text style={{ color: palette.text, marginBottom: 8 }}>Theme</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
              <TouchableOpacity onPress={() => setTheme('dark')} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: palette.border, backgroundColor: theme === 'dark' ? palette.assistantBubble : 'transparent' }}>
                <Text style={{ color: palette.text }}>Dark</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setTheme('light')} style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, borderColor: palette.border, backgroundColor: theme === 'light' ? palette.assistantBubble : 'transparent' }}>
                <Text style={{ color: palette.text }}>Light</Text>
              </TouchableOpacity>
            </View>
            <View style={{ height: 1, backgroundColor: palette.border, marginVertical: 8 }} />
            <Text style={{ color: palette.text, fontWeight: '600', marginBottom: 6 }}>Chat History</Text>
            <Text style={{ color: palette.text, opacity: 0.8, marginBottom: 8 }}>Review and delete your history.</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              {(['lets','ielts','pron'] as WorkspaceKey[]).map((k) => (
                <View key={k} style={{ borderWidth: 1, borderColor: palette.border, borderRadius: 8, padding: 10, minWidth: 120 }}>
                  <Text style={{ color: palette.text, fontWeight: '600', marginBottom: 4 }}>{k === 'lets' ? "Let's Chat" : k === 'ielts' ? 'IELTS Study' : 'Pronunciation'}</Text>
                  <Text style={{ color: palette.text, opacity: 0.8, marginBottom: 8 }}>Chats: {sessionsByWS[k].sessions.length}</Text>
                  <TouchableOpacity onPress={() => {
                    Alert.alert('Delete history', 'Delete all chats for this workspace?', [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Delete', style: 'destructive', onPress: () => {
                        setSessionsByWS((prev) => ({ ...prev, [k]: { sessions: [], currentId: undefined } }));
                        if (activeWS === k) setMessages([]);
                      }},
                    ]);
                  }} style={{ paddingVertical: 8 }}>
                    <Text style={{ color: '#d9534f' }}>Delete {k} chats</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
            <TouchableOpacity onPress={() => {
              Alert.alert('Delete all history', 'Delete ALL chats in all workspaces?', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Delete', style: 'destructive', onPress: () => {
                  setSessionsByWS({ lets: { sessions: [] }, ielts: { sessions: [] }, pron: { sessions: [] } });
                  setMessages([]);
                }},
              ]);
            }} style={{ paddingVertical: 10 }}>
              <Text style={{ color: '#d9534f', fontWeight: '600' }}>Delete all chat history</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Account overlay */}
      {showAccount && (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' }}>
          <View style={{ width: '92%', maxWidth: 560, backgroundColor: palette.inputBg, borderWidth: 1, borderColor: palette.border, borderRadius: 12, padding: 16 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <Text style={{ color: palette.text, fontSize: 18, fontWeight: '700' }}>Account</Text>
              <TouchableOpacity onPress={() => setShowAccount(false)} style={{ padding: 6 }}>
                <Text style={{ color: palette.text, fontSize: 18 }}>✕</Text>
              </TouchableOpacity>
            </View>
            <View style={{ height: 1, backgroundColor: palette.border, marginVertical: 8 }} />

            {!account.signedIn ? (
              <>
                <Text style={{ color: palette.text, fontWeight: '600', marginBottom: 8 }}>Sign in or Sign up</Text>
                <View style={{ borderWidth: 1, borderColor: palette.border, borderRadius: 10, padding: 12, marginBottom: 12 }}>
                  <Text style={{ color: palette.text, marginBottom: 6 }}>Email</Text>
                  <TextInput value={authEmail} onChangeText={setAuthEmail} autoCapitalize='none' keyboardType='email-address' style={{ color: palette.text, borderWidth: 1, borderColor: palette.border, borderRadius: 8, padding: 8, marginBottom: 10 }} />
                  <Text style={{ color: palette.text, marginBottom: 6 }}>Password</Text>
                  <TextInput value={authPassword} onChangeText={setAuthPassword} secureTextEntry style={{ color: palette.text, borderWidth: 1, borderColor: palette.border, borderRadius: 8, padding: 8, marginBottom: 10 }} />
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TouchableOpacity onPress={() => {
                      if (!authEmail || !authPassword) { Alert.alert('Enter email and password'); return; }
                      setAccount({ signedIn: true, email: authEmail.trim(), plan: 'flor', payment: null });
                      setAuthPassword('');
                      Alert.alert('Signed up', 'Welcome to Flor!');
                    }} style={{ paddingVertical: 10, paddingHorizontal: 12, backgroundColor: palette.sendBtnBg, borderRadius: 8 }}>
                      <Text style={{ color: palette.sendText }}>Sign up</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => {
                      if (!authEmail || !authPassword) { Alert.alert('Enter email and password'); return; }
                      setAccount((prev) => ({ ...prev, signedIn: true, email: authEmail.trim() }));
                      setAuthPassword('');
                      Alert.alert('Signed in', 'Welcome back!');
                    }} style={{ paddingVertical: 10, paddingHorizontal: 12, borderWidth: 1, borderColor: palette.border, borderRadius: 8 }}>
                      <Text style={{ color: palette.text }}>Sign in</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </>
            ) : (
              <>
                <Text style={{ color: palette.text, marginBottom: 6 }}>Signed in as</Text>
                <Text style={{ color: palette.text, fontWeight: '600', marginBottom: 12 }}>{account.email}</Text>
                <TouchableOpacity onPress={() => { setAccount({ signedIn: false, plan: 'flor', payment: null }); }} style={{ alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 10, borderWidth: 1, borderColor: palette.border, borderRadius: 8, marginBottom: 16 }}>
                  <Text style={{ color: palette.text }}>Sign out</Text>
                </TouchableOpacity>

                <View style={{ height: 1, backgroundColor: palette.border, marginVertical: 8 }} />
                <Text style={{ color: palette.text, fontWeight: '700', marginBottom: 8 }}>Plan & Billing</Text>
                <View style={{ flexDirection: 'row', gap: 10, flexWrap: 'wrap' }}>
                  <View style={{ flexGrow: 1, minWidth: 200, borderWidth: 1, borderColor: palette.border, borderRadius: 10, padding: 12 }}>
                    <Text style={{ color: palette.text, fontWeight: '700' }}>Flor</Text>
                    <Text style={{ color: palette.text, opacity: 0.8, marginVertical: 6 }}>Base plan with standard usage limits.</Text>
                    <TouchableOpacity onPress={() => setAccount((a) => ({ ...a, plan: 'flor' }))} style={{ alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 10, backgroundColor: account.plan === 'flor' ? palette.sendBtnBg : 'transparent', borderWidth: 1, borderColor: palette.border, borderRadius: 8 }}>
                      <Text style={{ color: account.plan === 'flor' ? palette.sendText : palette.text }}>{account.plan === 'flor' ? 'Current plan' : 'Choose Flor'}</Text>
                    </TouchableOpacity>
                  </View>
                  <View style={{ flexGrow: 1, minWidth: 200, borderWidth: 1, borderColor: palette.border, borderRadius: 10, padding: 12 }}>
                    <Text style={{ color: palette.text, fontWeight: '700' }}>Flor +</Text>
                    <Text style={{ color: palette.text, opacity: 0.8, marginVertical: 6 }}>Upgraded plan with higher usage limits.</Text>
                    <TouchableOpacity onPress={() => setAccount((a) => ({ ...a, plan: 'flor_plus' }))} style={{ alignSelf: 'flex-start', paddingVertical: 8, paddingHorizontal: 10, backgroundColor: account.plan === 'flor_plus' ? palette.sendBtnBg : 'transparent', borderWidth: 1, borderColor: palette.border, borderRadius: 8 }}>
                      <Text style={{ color: account.plan === 'flor_plus' ? palette.sendText : palette.text }}>{account.plan === 'flor_plus' ? 'Current plan' : 'Upgrade to Flor +'}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
                <View style={{ marginTop: 12 }}>
                  <Text style={{ color: palette.text, fontWeight: '600', marginBottom: 6 }}>Payment method</Text>
                  <Text style={{ color: palette.text, opacity: 0.8, marginBottom: 8 }}>For demo only — no real billing.</Text>
                  <TextInput placeholder='Brand (e.g., Visa)' placeholderTextColor={palette.placeholder} value={payBrand} onChangeText={setPayBrand} style={{ color: palette.text, borderWidth: 1, borderColor: palette.border, borderRadius: 8, padding: 8, marginBottom: 8 }} />
                  <TextInput placeholder='Last 4 digits' placeholderTextColor={palette.placeholder} value={payLast4} onChangeText={setPayLast4} keyboardType='number-pad' style={{ color: palette.text, borderWidth: 1, borderColor: palette.border, borderRadius: 8, padding: 8, marginBottom: 8 }} />
                  <TouchableOpacity onPress={() => { setAccount((a) => ({ ...a, payment: { brand: payBrand, last4: payLast4 } })); Alert.alert('Payment updated'); }} style={{ alignSelf: 'flex-start', paddingVertical: 10, paddingHorizontal: 12, backgroundColor: palette.sendBtnBg, borderRadius: 8 }}>
                    <Text style={{ color: palette.sendText }}>Update payment</Text>
                  </TouchableOpacity>
                </View>

                <View style={{ marginTop: 12 }}>
                  <TouchableOpacity onPress={() => Linking.openURL('https://example.com/flor/pricing').catch(() => {})} style={{ alignSelf: 'flex-start', paddingVertical: 10, paddingHorizontal: 12, borderWidth: 1, borderColor: palette.border, borderRadius: 8 }}>
                    <Text style={{ color: palette.text }}>Go to pricing & subscriptions</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

// dynamic styles defined within component above
