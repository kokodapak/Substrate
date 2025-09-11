const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

dotenv.config();

const app = express();
const upload = multer({ dest: path.join(__dirname, 'uploads') });

const port = process.env.PORT || 4000;
const openaiApiKey = process.env.OPENAI_API_KEY;
if (!openaiApiKey) {
  // eslint-disable-next-line no-console
  console.warn('Warning: OPENAI_API_KEY is not set. Set it in a .env file.');
}

const openai = new OpenAI({ apiKey: openaiApiKey });

app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));

const limiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
app.use('/v1/', limiter);

app.get('/health', (req, res) => {
  res.json({ ok: true });
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

    const model = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';

    const transcription = await openai.audio.transcriptions.create({
      file: fileStream,
      model,
      // Hints: language or prompt can be added via body later if needed
    });

    // Cleanup temp file asynchronously
    fs.unlink(filePath, () => {});

    res.json({ text: transcription.text });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Transcription error:', error);
    res.status(500).json({ error: 'Transcription failed' });
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
    res.status(500).json({ error: 'Chat failed' });
  }
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Server listening on http://localhost:${port}`);
});

