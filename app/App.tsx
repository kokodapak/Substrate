import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import * as Speech from 'expo-speech';
import Voice from 'react-native-voice';

const API_BASE = 'http://localhost:4000'; // Change to your Mac's LAN IP when testing on real device

export default function App() {
  const [input, setInput] = useState('');
  const [reply, setReply] = useState('');
  const [loading, setLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);

  useEffect(() => {
    Voice.onSpeechStart = () => setIsListening(true);
    Voice.onSpeechEnd = () => setIsListening(false);
    Voice.onSpeechResults = (e) => {
      if (e.value && e.value[0]) {
        setInput(e.value[0]);
      }
    };
    Voice.onSpeechError = (e) => {
      console.log('Speech error:', e);
      setIsListening(false);
      Alert.alert('Speech Error', 'Could not recognize speech. Please try again.');
    };

    return () => {
      Voice.destroy().then(Voice.removeAllListeners);
    };
  }, []);

  const startListening = async () => {
    try {
      setInput('');
      await Voice.start('en-US');
    } catch (error) {
      console.log('Error starting voice recognition:', error);
      Alert.alert('Voice Error', 'Could not start voice recognition. Please check permissions.');
    }
  };

  const stopListening = async () => {
    try {
      await Voice.stop();
    } catch (error) {
      console.log('Error stopping voice recognition:', error);
    }
  };

  const ask = async () => {
    if (!input.trim()) return;
    setLoading(true);
    setReply('');
    try {
      const res = await fetch(`${API_BASE}/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          messages: [{ role: 'user', content: input }],
          system: 'You are a helpful English language learning coach. Keep responses conversational and encouraging.'
        })
      });
      const data = await res.json();
      const text = data?.content ?? 'Sorry, I did not catch that.';
      setReply(text);

      // Speak the response
      Speech.stop();
      Speech.speak(text, { language: 'en-US', rate: 0.9 });
    } catch (e) {
      const errorMsg = 'Network error. Is the server running?';
      setReply(errorMsg);
      Speech.speak(errorMsg, { language: 'en-US', rate: 0.9 });
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>AI Language Coach</Text>

      <TextInput
        style={styles.input}
        placeholder="Type or use voice to practice..."
        value={input}
        onChangeText={setInput}
        onSubmitEditing={ask}
        returnKeyType="send"
        multiline
      />

      <View style={styles.buttonRow}>
        <TouchableOpacity 
          style={[styles.voiceButton, isListening && styles.listeningButton]} 
          onPress={isListening ? stopListening : startListening}
        >
          <Text style={[styles.buttonText, isListening && styles.listeningText]}>
            {isListening ? '🎤 Listening...' : '🎤 Voice'}
          </Text>
        </TouchableOpacity>
        
        <TouchableOpacity style={styles.sendButton} onPress={ask}>
          <Text style={styles.buttonText}>Send</Text>
        </TouchableOpacity>
      </View>

      {loading ? <ActivityIndicator size="large" style={{ marginTop: 16 }} /> : null}

      <Text style={styles.label}>AI Reply:</Text>
      <Text style={styles.reply}>{reply || '—'}</Text>

      <Text style={styles.hint}>
        💡 Tip: For real device testing, update API_BASE to your computer's IP (e.g., http://192.168.1.23:4000)
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { 
    flex: 1, 
    paddingTop: 80, 
    paddingHorizontal: 20, 
    backgroundColor: '#f5f5f5' 
  },
  title: { 
    fontSize: 24, 
    fontWeight: '700', 
    marginBottom: 20, 
    textAlign: 'center',
    color: '#333'
  },
  input: { 
    borderWidth: 1, 
    borderColor: '#ddd', 
    borderRadius: 12, 
    padding: 16, 
    marginBottom: 16,
    backgroundColor: '#fff',
    fontSize: 16,
    minHeight: 60
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16
  },
  voiceButton: {
    flex: 1,
    backgroundColor: '#007AFF',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center'
  },
  listeningButton: {
    backgroundColor: '#FF3B30'
  },
  sendButton: {
    flex: 1,
    backgroundColor: '#34C759',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center'
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600'
  },
  listeningText: {
    color: '#fff'
  },
  label: { 
    marginTop: 24, 
    fontSize: 14, 
    color: '#666',
    fontWeight: '600'
  },
  reply: { 
    marginTop: 8, 
    fontSize: 18, 
    lineHeight: 26,
    color: '#333',
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: 12,
    minHeight: 60
  },
  hint: { 
    marginTop: 24, 
    fontSize: 12, 
    color: '#888',
    textAlign: 'center',
    fontStyle: 'italic'
  }
});
