const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { toFile } = require('openai');

// Ensure we load the .env next to this file regardless of cwd
dotenv.config({ path: path.join(__dirname, '.env') });

const app = express();
const upload = multer({ dest: path.join(__dirname, 'uploads') });
const dataDir = path.join(__dirname, 'data');
try { if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir); } catch {}

const port = process.env.PORT || 4000;
const openaiApiKey = process.env.OPENAI_API_KEY;
if (!openaiApiKey) {
  // eslint-disable-next-line no-console
  console.warn('Warning: OPENAI_API_KEY is not set. Set it in a .env file.');
}

let openai = null;
if (openaiApiKey) {
  openai = new OpenAI({ apiKey: openaiApiKey });
}

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use('/v1/', limiter);

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// --- Simple persistence for sessions and support tickets (JSON file backed) ---
const SESSIONS_PATH = path.join(dataDir, 'sessions.json');
const SUPPORT_PATH = path.join(dataDir, 'support.json');
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; } }
function writeJSON(p, obj) { try { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); } catch {} }

// List sessions for a user (and optional mode)
app.get('/api/sessions', (req, res) => {
  const user = (req.query.user || '').toString().trim();
  const mode = (req.query.mode || '').toString().trim();
  const store = readJSON(SESSIONS_PATH);
  if (!user) return res.json({ sessions: [] });
  const all = store[user] || [];
  const list = mode ? all.filter(s => s.mode === mode) : all;
  res.json({ sessions: list });
});

// Save or update a session
// body: { user, session: { id, mode, title, messages, updatedAt } }
app.post('/api/sessions/save', (req, res) => {
  const { user, session } = req.body || {};
  if (!user || !session || !session.id) return res.status(400).json({ error: 'missing_user_or_session' });
  const store = readJSON(SESSIONS_PATH);
  const list = store[user] || [];
  const idx = list.findIndex(s => s.id === session.id);
  if (idx >= 0) list[idx] = session; else list.unshift(session);
  store[user] = list;
  writeJSON(SESSIONS_PATH, store);
  res.json({ ok: true });
});

// Support tickets (contact us)
app.post('/api/support', (req, res) => {
  const { user, email, subject, message } = req.body || {};
  if (!email || !message) return res.status(400).json({ error: 'missing_email_or_message' });
  const store = readJSON(SUPPORT_PATH);
  const arr = store.tickets || [];
  arr.push({ id: Date.now().toString(36), user, email, subject, message, createdAt: new Date().toISOString() });
  store.tickets = arr;
  writeJSON(SUPPORT_PATH, store);
  res.json({ ok: true });
});

// Text-to-speech using OpenAI TTS, returns MP3
app.all('/api/voice', async (req, res) => {
  try {
    if (!openaiApiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
    const text = (req.method === 'GET') ? (req.query.text || '') : (req.body?.text || '');
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'missing_text' });

    // Default voice and model
    const model = 'gpt-4o-mini-tts';
    const voice = req.query.voice || req.body?.voice || 'alloy';

    const tts = await openai.audio.speech.create({
      model,
      voice,
      input: text,
      format: 'mp3',
    });
    const audioBuffer = Buffer.from(await tts.arrayBuffer());
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(audioBuffer);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Voice TTS error:', err);
    res.status(500).json({ error: 'tts_failed' });
  }
});
// Create an ephemeral token for OpenAI Realtime API (low-latency voice)
app.post('/api/realtime/session', async (req, res) => {
  try {
    if (!openaiApiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
    const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
    const { voice = 'verse', instructions, mode } = req.body || {};
    const MODE_PROMPTS = {
      conversation: `Mode: Conversation Coaching\n\nGoal: Build confidence with natural, supportive conversations that adapt to the learner's level.\nBehavior:\n- Start warm and friendly. Establish comfort quickly.\n- Mix professional/casual topics. Ask focused, open questions.\n- Gently model correct grammar and phrasing (soft recasts).\n- Adjust difficulty in real time: simpler if they struggle; more abstract if they excel.\n- Provide quick 1–2 bullet feedback after turns (grammar/vocab/pronunciation).\n- Keep the learner speaking more than you.\nTone: Professional, supportive, optimistic. De‑escalate frustration.`,
      ielts: `Mode: IELTS Study\n\nGoal: Teach curriculum aligned to the learner's proven speaking capabilities.\nBehavior:\n- In conversation, unobtrusively gauge level from accent, mispronunciations, misused words, and L1 reliance.\n- Select tasks relevant to their level (IELTS Speaking P1/P2/P3 or micro‑drills).\n- Model band‑appropriate answers; then prompt the learner to try.\n- After turns, provide IELTS criteria notes (Fluency & Coherence, Lexical Resource, Grammatical Range & Accuracy, Pronunciation).\n- Keep micro‑feedback concise (1–3 bullets).\nTone: Friendly, lightly formal classroom; supportive, optimistic.`,
      pronunciation: `Mode: Pronunciation Focus\n\nGoal: Improve pronunciation with targeted drills informed by the learner's L1.\nBehavior:\n- Ask for (or recall) native language; use it to focus likely challenges.\n- Challenge with targeted tests: /v/ vs /w/, final consonants, /θ/ /ð/, word stress.\n- Grade responses; give clear mouth‑position tips and micro‑drills.\n- Keep turns short; celebrate progress.\n- Provide 1–2 practical tips after each turn.\nTone: Encouraging, professional, optimistic; de‑escalate frustration.`,
    };
    const defaultInstructions = `You are “Cô Lan,” a friendly, expert English speaking coach from a boutique IELTS school in Đà Nẵng. You specialize in Vietnamese learners and adapt to any L1. Keep turns concise, coach gently, allow natural barge-in, and speak clearly. Focus on IELTS Speaking skills, provide brief micro-feedback (grammar, vocabulary, pronunciation), and keep the main reply in English. If helpful, add a short L1 hint.`;
    const modeBlock = mode && MODE_PROMPTS[mode] ? `\n\n${MODE_PROMPTS[mode]}` : '';
    const finalInstructions = `${defaultInstructions}${modeBlock}${instructions ? `\n\nAdditional instructions:\n${instructions}` : ''}`;
    const body = {
      model,
      voice,
      modalities: ['text', 'audio'],
      instructions: finalInstructions,
      turn_detection: { type: 'server_vad', silence_duration_ms: 700 },
    };
    const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'realtime=v1',
      },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status || 500).json({ error: data?.error?.message || 'failed_to_create_session' });
    res.json(data);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Realtime session error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

// WebRTC SDP exchange proxy (avoids browser CORS to OpenAI)
// body: { sdp: string, voice?: string, mode?: string, instructions?: string }
app.post('/api/realtime/sdp', async (req, res) => {
  try {
    if (!openaiApiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
    const { sdp, voice = 'verse', mode, instructions } = req.body || {};
    if (!sdp || typeof sdp !== 'string') return res.status(400).json({ error: 'missing_sdp' });

    // Build instructions identical to /api/realtime/session
    const defaultInstructions = `You are “Cô Lan,” a friendly, expert English speaking coach from a boutique IELTS school in Đà Nẵng. You specialize in Vietnamese learners and adapt to any L1. Keep turns concise, coach gently, allow natural barge-in, and speak clearly. Focus on IELTS Speaking skills, provide brief micro-feedback (grammar, vocabulary, pronunciation), and keep the main reply in English. If helpful, add a short L1 hint.`;
    const MODE_PROMPTS = {
      conversation: 'Mode: Friendly conversation coach. Keep turns short, natural, and supportive. Subtly coach grammar/pronunciation with 1–2 bullet feedback after each turn. Encourage the learner to speak more than you.',
      ielts: 'Mode: IELTS classroom. Align with IELTS criteria. Be a bit more formal. After responses, give concise criteria-based feedback (Fluency, Lexical Resource, Grammar, Pronunciation).',
      pronunciation: 'Mode: Pronunciation focus. Emphasize /v/ vs /w/, final consonants, /θ/ /ð/, word stress. Provide quick drills and mouth-position tips. Keep turns short and practical.',
    };
    const modeBlock = mode && MODE_PROMPTS[mode] ? `\n\n${MODE_PROMPTS[mode]}` : '';
    const finalInstructions = `${defaultInstructions}${modeBlock}${instructions ? `\n\nAdditional instructions:\n${instructions}` : ''}`;

    const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';

    // 1) Mint ephemeral token for this exchange
    const sessResp = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'realtime=v1',
      },
      body: JSON.stringify({
        model,
        voice,
        modalities: ['text', 'audio'],
        instructions: finalInstructions,
        turn_detection: { type: 'server_vad', silence_duration_ms: 700 },
      }),
    });
    const sessData = await sessResp.json();
    if (!sessResp.ok) return res.status(sessResp.status || 500).json({ error: sessData?.error?.message || 'failed_to_create_session' });
    const ephemeral = sessData?.client_secret?.value;
    if (!ephemeral) return res.status(500).json({ error: 'missing_ephemeral' });

    // 2) Exchange SDP with OpenAI Realtime
    const sdpResp = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ephemeral}`,
        'Content-Type': 'application/sdp',
        'OpenAI-Beta': 'realtime=v1',
      },
      body: sdp,
    });
    const answerSDP = await sdpResp.text();
    if (!sdpResp.ok) return res.status(sdpResp.status || 500).send(answerSDP);
    res.type('text/plain').send(answerSDP);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Realtime SDP error:', err);
    res.status(500).json({ error: 'realtime_sdp_failed' });
  }
});

// Transcribe recorded audio using OpenAI
app.post('/v1/transcribe', upload.single('audio'), async (req, res) => {
  if (!openaiApiKey) {
    return res.status(500).json({ error: 'Server not configured with OPENAI_API_KEY' });
  }
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Missing audio file (field name: audio)' });
    }
    const filePath = req.file.path;
    const fileStream = fs.createReadStream(filePath);
    const file = await toFile(fileStream, req.file?.originalname || 'audio.m4a');

    const model = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';

    const transcription = await openai.audio.transcriptions.create({
      file,
      model,
      // Hints: language or prompt can be added via body later if needed
    });

    // Cleanup temp file asynchronously
    fs.unlink(filePath, () => {});

    res.json({ text: transcription.text });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Transcription error:', error);
    const status = error?.status || 500;
    const code = error?.code;
    const message = error?.error?.message || 'Transcription failed';
    res.status(status).json({ error: message, code });
  }
});

// Alias: Transcribe endpoint for the mobile MVP client
app.post('/api/stt', upload.single('audio'), async (req, res) => {
  if (!openaiApiKey) {
    return res.status(500).json({ error: 'Server not configured with OPENAI_API_KEY' });
  }
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Missing audio file (field name: audio)' });
    }
    const filePath = req.file.path;
    const fileStream = fs.createReadStream(filePath);
    const file = await toFile(fileStream, req.file?.originalname || 'audio.m4a');

    const model = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';

    const transcription = await openai.audio.transcriptions.create({
      file,
      model,
    });

    fs.unlink(filePath, () => {});

    res.json({ text: transcription.text || '' });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Transcription (/api/stt) error:', error);
    const status = error?.status || 500;
    const code = error?.code;
    const message = error?.error?.message || 'Transcription failed';
    res.status(status).json({ error: message, code });
  }
});

// Simple chat completion endpoint
app.post('/v1/chat', async (req, res) => {
  if (!openaiApiKey) {
    return res.status(500).json({ error: 'Server not configured with OPENAI_API_KEY' });
  }
  try {
    const { messages, system } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Missing messages array' });
    }

    const model = process.env.OPENAI_CHAT_MODEL || 'gpt-4o-mini';

    const response = await openai.chat.completions.create({
      model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages,
      ],
      temperature: 0.7,
    });

    const content = response.choices?.[0]?.message?.content ?? '';
    res.json({ content });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Chat error:', error);
    const status = error?.status || 500;
    const code = error?.code;
    const message = error?.error?.message || 'Chat failed';
    res.status(status).json({ error: message, code });
  }
});

// Alias: Chat endpoint for the mobile MVP client (direct REST call)
app.post('/api/chat', async (req, res) => {
  try {
    const { text, system, messages } = req.body || {};
    if (!text && !(Array.isArray(messages) && messages.length)) {
      return res.status(400).json({ error: 'missing_text' });
    }

    const defaultSystem = `
You are “Cô Lan,” an expert English speaking coach specialized in Vietnamese learners (but adapt to any L1). Your job:
1) Hold natural conversations to practice English.
2) Detect user's native language (L1) from their messages.
3) Teach primarily in English, but occasionally use the learner's L1 with concise explanations when helpful.
4) After most turns, provide 1–3 short feedback bullets (grammar, vocabulary, pronunciation).
5) Keep replies concise and end with a question to invite the learner to speak.

When responding, ALWAYS produce strict JSON (no code fences) with:
{
  "reply": string,                 // The main reply (mostly English)
  "assist": string|null,           // Optional brief L1 explanation or translation
  "detected_language": string,     // ISO 639-1 (e.g., "vi", "es", "ja"); best guess
  "tts_language": string,          // BCP-47 locale for TTS (e.g., "en-US", "vi-VN"); choose based on reply/assist
  "title": string|null             // Optional short title for the chat/topic
}
Rules:
- If the user is clearly a Vietnamese speaker, set detected_language="vi" and tts_language accordingly when using Vietnamese in assist.
- Keep assist short and only when it truly helps comprehension.
- reply should remain primarily in English to encourage practice.
`;

    const msgs = [];
    // Always include the JSON-mode instruction so response_format=json_object is valid
    msgs.push({ role: 'system', content: defaultSystem });
    if (system && typeof system === 'string') {
      // Add workspace/system-specific instructions as an additional system message
      msgs.push({ role: 'system', content: system });
    }
    if (Array.isArray(messages) && messages.length) {
      for (const m of messages) {
        if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') {
          msgs.push({ role: m.role, content: m.content });
        }
      }
    }
    if (text) msgs.push({ role: 'user', content: text });

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.7,
        response_format: { type: 'json_object' },
        messages: msgs,
      })
    });

    const data = await r.json();
    if (!r.ok) {
      // eslint-disable-next-line no-console
      console.error('OpenAI error:', data);
      return res.status(r.status || 500).json({ error: data?.error?.message || 'server_error' });
    }
    const content = data?.choices?.[0]?.message?.content;
    let parsed;
    try {
      parsed = typeof content === 'string' ? JSON.parse(content) : content;
    } catch (e) {
      parsed = { reply: String(content || ''), assist: null, detected_language: 'en', tts_language: 'en-US', title: null };
    }
    const reply = parsed?.reply ?? 'Sorry, I didn’t catch that.';
    const assist = parsed?.assist ?? null;
    const detected_language = parsed?.detected_language ?? 'en';
    const tts_language = parsed?.tts_language ?? 'en-US';
    const title = parsed?.title ?? null;
    res.json({ reply, assist, detected_language, tts_language, title });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  }
});

// Serve built web app (Vite) in production
try {
  const staticDir = path.join(__dirname, '..', 'app', 'dist');
  if (fs.existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/v1')) return next();
      res.sendFile(path.join(staticDir, 'index.html'));
    });
  }
} catch {}

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${port}`);
});
