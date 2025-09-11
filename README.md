# AI Language Learning Tool

A mobile-first voice language learning app built with Expo and OpenAI API.

## Features

- 🎤 Voice input using speech recognition
- 🔊 Text-to-speech responses
- 💬 ChatGPT-like interface optimized for language learning
- 📱 Mobile-first design

## Setup

### 1. Install Dependencies

```bash
# Install server dependencies
cd server
npm install

# Install app dependencies  
cd ../app
npm install
```

### 2. Configure OpenAI API Key

Create `server/.env` file:

```bash
cd server
cp .env.example .env
```

Edit `server/.env` and add your OpenAI API key:

```
OPENAI_API_KEY=your_openai_api_key_here
PORT=4000
OPENAI_CHAT_MODEL=gpt-4o-mini
OPENAI_TRANSCRIBE_MODEL=whisper-1
```

### 3. Start the Backend Server

```bash
cd server
npm run dev
```

The server will start on `http://localhost:4000`

### 4. Start the Expo App

```bash
cd app
npx expo start
```

### 5. Testing on Real Device

When testing on a physical device, update the `API_BASE` constant in `app/App.tsx`:

```typescript
const API_BASE = 'http://YOUR_COMPUTER_IP:4000'; // e.g., 'http://192.168.1.23:4000'
```

To find your computer's IP:
- **macOS/Linux**: `ifconfig | grep inet`
- **Windows**: `ipconfig`

## API Endpoints

- `GET /health` - Health check
- `POST /v1/chat` - Chat completion with OpenAI
- `POST /v1/transcribe` - Audio transcription (Whisper)

## Security Notes

- ⚠️ **Never commit `.env` files** - they contain sensitive API keys
- The `.env` file is gitignored to prevent accidental commits
- For production, use proper environment variable management

## Development

The app uses:
- **Backend**: Node.js + Express + OpenAI API
- **Frontend**: Expo + React Native + TypeScript
- **Voice**: react-native-voice + expo-speech