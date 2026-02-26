import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'
import {
  addDoc,
  collection,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
} from 'firebase/firestore'
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth'
import type { User } from 'firebase/auth'
import { auth, db } from './firebase'

type Role = 'user' | 'assistant'

type ChatMessage = {
  id: string
  role: Role
  content: string
  createdAt?: unknown
}

const systemPrompt = `You are JARVIS, a sharp, concise personal AI assistant. Be practical, action-oriented, and clear. Ask clarifying questions only when required.`

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login')
  const [authError, setAuthError] = useState('')

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [prompt, setPrompt] = useState('')
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState('Ready')

  const [apiKeyInput, setApiKeyInput] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)

  const listRef = useRef<HTMLDivElement>(null)

  const apiKey = useMemo(() => {
    return localStorage.getItem('jarvis_api_key') || import.meta.env.VITE_OPENAI_API_KEY || ''
  }, [showApiKey])

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser)
      setLoading(false)
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    if (!user) return

    const ref = collection(db, 'users', user.uid, 'assistantMessages')
    const q = query(ref, orderBy('createdAt', 'asc'))
    const unsub = onSnapshot(q, (snapshot) => {
      const rows: ChatMessage[] = snapshot.docs.map((d) => {
        const data = d.data() as Omit<ChatMessage, 'id'>
        return { id: d.id, ...data }
      })
      setMessages(rows)
    })

    return () => unsub()
  }, [user])

  useEffect(() => {
    if (!listRef.current) return
    listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages, sending])

  const handleAuth = async (e: FormEvent) => {
    e.preventDefault()
    setAuthError('')
    try {
      if (authMode === 'login') {
        await signInWithEmailAndPassword(auth, email, password)
      } else {
        await createUserWithEmailAndPassword(auth, email, password)
      }
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Authentication failed')
    }
  }

  const saveMessage = async (role: Role, content: string) => {
    if (!user) return
    const ref = collection(db, 'users', user.uid, 'assistantMessages')
    await addDoc(ref, { role, content, createdAt: serverTimestamp() })
  }

  const callModel = async (allMessages: ChatMessage[]) => {
    const key = localStorage.getItem('jarvis_api_key') || import.meta.env.VITE_OPENAI_API_KEY
    if (!key) {
      throw new Error('Missing API key. Add it in Settings panel.')
    }

    const model = import.meta.env.VITE_OPENAI_MODEL || 'gpt-4o-mini'

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...allMessages.map((m) => ({ role: m.role, content: m.content })),
        ],
        temperature: 0.4,
      }),
    })

    if (!response.ok) {
      const txt = await response.text()
      throw new Error(`Model error: ${txt}`)
    }

    const json = await response.json()
    return json.choices?.[0]?.message?.content?.trim() || 'No response.'
  }

  const sendMessage = async (e: FormEvent) => {
    e.preventDefault()
    if (!prompt.trim() || sending) return

    const userText = prompt.trim()
    setPrompt('')
    setSending(true)
    setStatus('Thinking...')

    try {
      await saveMessage('user', userText)

      const allMessages = [...messages, { id: 'temp', role: 'user' as const, content: userText }]
      const reply = await callModel(allMessages)
      await saveMessage('assistant', reply)
      setStatus('Ready')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      await saveMessage('assistant', `⚠️ ${msg}`)
      setStatus('Error')
    } finally {
      setSending(false)
    }
  }

  const saveApiKey = () => {
    if (!apiKeyInput.trim()) return
    localStorage.setItem('jarvis_api_key', apiKeyInput.trim())
    setApiKeyInput('')
    setShowApiKey((v) => !v)
    setShowApiKey((v) => !v)
  }

  const startVoiceInput = () => {
    const SpeechRecognitionCtor =
      (window as Window & { webkitSpeechRecognition?: new () => any }).webkitSpeechRecognition ||
      (window as Window & { SpeechRecognition?: new () => any }).SpeechRecognition

    if (!SpeechRecognitionCtor) {
      setStatus('Voice input not supported in this browser')
      return
    }

    const recognition = new SpeechRecognitionCtor()
    recognition.lang = 'en-US'
    recognition.interimResults = false
    recognition.maxAlternatives = 1
    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript
      setPrompt((prev) => (prev ? `${prev} ${transcript}` : transcript))
      setStatus('Voice captured')
    }
    recognition.onerror = () => setStatus('Voice input error')
    recognition.start()
  }

  const speakLast = () => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
    if (!lastAssistant) return

    const u = new SpeechSynthesisUtterance(lastAssistant.content)
    u.rate = 1
    u.pitch = 1
    speechSynthesis.cancel()
    speechSynthesis.speak(u)
  }

  if (loading) return <main className="app">Loading...</main>

  if (!user) {
    return (
      <main className="app auth-wrap">
        <div className="card auth-card">
          <h1>JARVIS ASI Assistant</h1>
          <p className="sub">Private AI assistant with Firebase login + cloud chat history.</p>
          <form onSubmit={handleAuth} className="stack">
            <label>
              Email
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label>
              Password
              <input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <button type="submit">{authMode === 'login' ? 'Login' : 'Create account'}</button>
            <button type="button" className="ghost" onClick={() => setAuthMode((m) => (m === 'login' ? 'signup' : 'login'))}>
              {authMode === 'login' ? 'Need account? Sign up' : 'Already have account? Login'}
            </button>
            {authError && <p className="error">{authError}</p>}
          </form>
        </div>
      </main>
    )
  }

  return (
    <main className="app">
      <header className="topbar card">
        <div>
          <h1>JARVIS ASI Assistant</h1>
          <p className="sub">{status}</p>
        </div>
        <div className="row">
          <button className="ghost" onClick={startVoiceInput}>🎙️ Voice Input</button>
          <button className="ghost" onClick={speakLast}>🔊 Speak Last</button>
          <button className="ghost" onClick={() => setShowApiKey((v) => !v)}>⚙️ API Key</button>
          <button className="danger" onClick={() => signOut(auth)}>Logout</button>
        </div>
      </header>

      {showApiKey && (
        <section className="card key-panel">
          <p className="sub">OpenAI API key (stored only in this browser).</p>
          <div className="row">
            <input
              type="password"
              placeholder="sk-..."
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
            />
            <button onClick={saveApiKey}>Save Key</button>
          </div>
          <p className="sub">Status: {apiKey ? 'Configured' : 'Missing'}</p>
        </section>
      )}

      <section className="chat card" ref={listRef}>
        {messages.length === 0 ? (
          <div className="empty">Start by saying: “Jarvis, help me plan my day.”</div>
        ) : (
          messages.map((m) => (
            <article key={m.id} className={`bubble ${m.role}`}>
              <div className="role">{m.role === 'assistant' ? 'JARVIS' : 'You'}</div>
              <p>{m.content}</p>
            </article>
          ))
        )}
      </section>

      <form className="composer card" onSubmit={sendMessage}>
        <input
          placeholder="Ask JARVIS anything..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button type="submit" disabled={sending}>{sending ? 'Thinking...' : 'Send'}</button>
      </form>
    </main>
  )
}

export default App
