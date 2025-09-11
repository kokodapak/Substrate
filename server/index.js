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

dotenv.config();

const app = express();
const upload = multer({ dest: path.join(__dirname, 'uploads') });

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

// Create an ephemeral token for OpenAI Realtime API (low-latency voice)
app.post('/api/realtime/session', async (req, res) => {
  try {
    if (!openaiApiKey) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
    const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview-2024-12-17';
    const instructions = `You are “Cô Lan,” a friendly, expert English speaking coach for Vietnamese learners (adapt to any L1). Keep turns concise, coach gently, and allow natural barge-in. Speak clearly. Detect the user's native language automatically and, when helpful, add a brief L1 hint, but keep the main reply in English.`;
    const body = {
      model,
      voice: 'verse',
      modalities: ['text', 'audio'],
      instructions,
      turn_detection: { type: 'server_vad', silence_duration_ms: 700 },
    };
    const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json',
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

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${port}`);
});
