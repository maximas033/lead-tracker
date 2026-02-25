import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import './App.css'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
} from 'firebase/firestore'
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth'
import type { User } from 'firebase/auth'
import { auth, db } from './firebase'

type Lead = {
  id: string
  date: string
  customer: string
  leadSource: string
  jobType: string
  leadCost: string
  jobWon: 'Yes' | 'No'
  comments: string
  replyTime: string
}

type LeadInput = Omit<Lead, 'id'>

const emptyLead: LeadInput = {
  date: '',
  customer: '',
  leadSource: '',
  jobType: '',
  leadCost: '',
  jobWon: 'No',
  comments: '',
  replyTime: '',
}

const starterLeads: LeadInput[] = [
  {
    date: '2026-02-01',
    customer: 'Jordan Hancock',
    leadSource: 'Website Form Submission',
    jobType: 'Consultation',
    leadCost: '$0',
    jobWon: 'Yes',
    comments: 'Hold wants to cancel',
    replyTime: '',
  },
  {
    date: '2026-02-01',
    customer: 'Curtis L.',
    leadSource: 'Yelp',
    jobType: 'Service',
    leadCost: '$0',
    jobWon: 'No',
    comments: 'Customer said, "Sorry, I no longer need this service"',
    replyTime: '(Weekend): 214',
  },
  {
    date: '2026-02-01',
    customer: 'Jun Trinos',
    leadSource: 'Yelp',
    jobType: 'Service',
    leadCost: '$0',
    jobWon: 'No',
    comments: 'Building energy audit - Broken waterheater',
    replyTime: '(Weekend): 1',
  },
]

const parseCost = (leadCost: string) => {
  const value = Number(leadCost.replace(/[^\d.-]/g, ''))
  return Number.isFinite(value) ? value : 0
}

const parseReplyTime = (replyTime: string) => {
  const found = replyTime.match(/\d+/)
  return found ? Number(found[0]) : null
}

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login')
  const [leads, setLeads] = useState<Lead[]>([])
  const [form, setForm] = useState<LeadInput>(emptyLead)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser)
      setLoading(false)
    })

    return () => unsub()
  }, [])

  useEffect(() => {
    if (!user) return

    const leadsRef = collection(db, 'users', user.uid, 'leads')
    const q = query(leadsRef, orderBy('date', 'desc'))

    const unsub = onSnapshot(q, (snapshot) => {
      const rows: Lead[] = snapshot.docs.map((item) => {
        const data = item.data() as LeadInput
        return {
          id: item.id,
          ...data,
        }
      })
      setLeads(rows)
    })

    return () => unsub()
  }, [user])

  const stats = useMemo(() => {
    const totalLeads = leads.length
    const wonLeads = leads.filter((l) => l.jobWon === 'Yes').length
    const totalCost = leads.reduce((sum, l) => sum + parseCost(l.leadCost), 0)
    const winRate = totalLeads > 0 ? (wonLeads / totalLeads) * 100 : 0

    const replyTimes = leads
      .map((lead) => parseReplyTime(lead.replyTime))
      .filter((value): value is number => value !== null)

    const avgReplyTime =
      replyTimes.length > 0
        ? replyTimes.reduce((a, b) => a + b, 0) / replyTimes.length
        : 0

    const bySource = leads.reduce<Record<string, number>>((acc, lead) => {
      acc[lead.leadSource] = (acc[lead.leadSource] || 0) + 1
      return acc
    }, {})

    const byJobType = leads.reduce<Record<string, number>>((acc, lead) => {
      acc[lead.jobType] = (acc[lead.jobType] || 0) + 1
      return acc
    }, {})

    return {
      totalLeads,
      wonLeads,
      totalCost,
      winRate,
      avgReplyTime,
      bySource,
      byJobType,
    }
  }, [leads])

  const handleAuth = async (e: FormEvent) => {
    e.preventDefault()
    setMessage('')
    try {
      if (authMode === 'login') {
        await signInWithEmailAndPassword(auth, email, password)
      } else {
        await createUserWithEmailAndPassword(auth, email, password)
      }
    } catch (err) {
      const next = err instanceof Error ? err.message : 'Authentication failed.'
      setMessage(next)
    }
  }

  const saveLead = async (e: FormEvent) => {
    e.preventDefault()
    if (!user) return
    setMessage('')

    const leadsRef = collection(db, 'users', user.uid, 'leads')

    try {
      if (editingId) {
        await updateDoc(doc(leadsRef, editingId), {
          ...form,
          updatedAt: serverTimestamp(),
        })
      } else {
        await addDoc(leadsRef, {
          ...form,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      }

      setForm(emptyLead)
      setEditingId(null)
    } catch (err) {
      const next = err instanceof Error ? err.message : 'Unable to save lead.'
      setMessage(next)
    }
  }

  const onEdit = (lead: Lead) => {
    setEditingId(lead.id)
    setForm({
      date: lead.date,
      customer: lead.customer,
      leadSource: lead.leadSource,
      jobType: lead.jobType,
      leadCost: lead.leadCost,
      jobWon: lead.jobWon,
      comments: lead.comments,
      replyTime: lead.replyTime,
    })
  }

  const onDelete = async (id: string) => {
    if (!user) return
    if (!window.confirm('Delete this lead?')) return

    const leadsRef = collection(db, 'users', user.uid, 'leads')
    await deleteDoc(doc(leadsRef, id))
  }

  const seedData = async () => {
    if (!user) return
    const leadsRef = collection(db, 'users', user.uid, 'leads')

    for (const lead of starterLeads) {
      await addDoc(leadsRef, {
        ...lead,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
    }
  }

  if (loading) return <main className="container">Loading...</main>

  if (!user) {
    return (
      <main className="container auth">
        <h1>Lead Tracker Login</h1>
        <p>Free app + your own private data.</p>
        <form onSubmit={handleAuth} className="card form-grid">
          <label>
            Email
            <input
              required
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Password
            <input
              required
              minLength={6}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button type="submit">
            {authMode === 'login' ? 'Login' : 'Create Account'}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() =>
              setAuthMode((prev) => (prev === 'login' ? 'signup' : 'login'))
            }
          >
            {authMode === 'login'
              ? 'Need an account? Sign up'
              : 'Already have an account? Login'}
          </button>
          {message && <p className="error">{message}</p>}
        </form>
      </main>
    )
  }

  return (
    <main className="container">
      <header className="header">
        <h1>Lead Tracker Dashboard</h1>
        <div className="header-actions">
          <button className="ghost" onClick={seedData}>
            Load sample leads
          </button>
          <button className="ghost" onClick={() => signOut(auth)}>
            Logout
          </button>
        </div>
      </header>

      <section className="stats-grid">
        <article className="stat-card">
          <h2>Total Leads</h2>
          <strong>{stats.totalLeads}</strong>
        </article>
        <article className="stat-card">
          <h2>Won Jobs</h2>
          <strong>{stats.wonLeads}</strong>
        </article>
        <article className="stat-card">
          <h2>Win Rate</h2>
          <strong>{stats.winRate.toFixed(1)}%</strong>
        </article>
        <article className="stat-card">
          <h2>Total Lead Cost</h2>
          <strong>${stats.totalCost.toFixed(2)}</strong>
        </article>
        <article className="stat-card">
          <h2>Avg Reply Time</h2>
          <strong>{stats.avgReplyTime.toFixed(1)}</strong>
          <small>(numbers parsed from Reply Time text)</small>
        </article>
      </section>

      <section className="layout">
        <form onSubmit={saveLead} className="card form-grid">
          <h3>{editingId ? 'Edit Lead' : 'Add Lead'}</h3>
          <label>
            Date
            <input
              required
              type="date"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
            />
          </label>
          <label>
            Customer
            <input
              required
              value={form.customer}
              onChange={(e) => setForm({ ...form, customer: e.target.value })}
            />
          </label>
          <label>
            Lead Source
            <input
              required
              value={form.leadSource}
              onChange={(e) => setForm({ ...form, leadSource: e.target.value })}
            />
          </label>
          <label>
            Job Type
            <input
              required
              value={form.jobType}
              onChange={(e) => setForm({ ...form, jobType: e.target.value })}
            />
          </label>
          <label>
            Lead Cost
            <input
              placeholder="$0"
              value={form.leadCost}
              onChange={(e) => setForm({ ...form, leadCost: e.target.value })}
            />
          </label>
          <label>
            Job Won
            <select
              value={form.jobWon}
              onChange={(e) =>
                setForm({ ...form, jobWon: e.target.value as 'Yes' | 'No' })
              }
            >
              <option value="No">No</option>
              <option value="Yes">Yes</option>
            </select>
          </label>
          <label>
            Reply Time
            <input
              placeholder="(Weekend): 214"
              value={form.replyTime}
              onChange={(e) => setForm({ ...form, replyTime: e.target.value })}
            />
          </label>
          <label>
            Comments
            <textarea
              rows={3}
              value={form.comments}
              onChange={(e) => setForm({ ...form, comments: e.target.value })}
            />
          </label>
          <div className="row">
            <button type="submit">{editingId ? 'Update Lead' : 'Save Lead'}</button>
            {editingId && (
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setEditingId(null)
                  setForm(emptyLead)
                }}
              >
                Cancel Edit
              </button>
            )}
          </div>
          {message && <p className="error">{message}</p>}
        </form>

        <div className="card table-wrap">
          <h3>Leads</h3>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Customer</th>
                <th>Source</th>
                <th>Type</th>
                <th>Cost</th>
                <th>Won</th>
                <th>Reply Time</th>
                <th>Comments</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id}>
                  <td>{lead.date}</td>
                  <td>{lead.customer}</td>
                  <td>{lead.leadSource}</td>
                  <td>{lead.jobType}</td>
                  <td>{lead.leadCost}</td>
                  <td>{lead.jobWon}</td>
                  <td>{lead.replyTime}</td>
                  <td>{lead.comments}</td>
                  <td>
                    <div className="row">
                      <button className="ghost" onClick={() => onEdit(lead)}>
                        Edit
                      </button>
                      <button className="danger" onClick={() => onDelete(lead.id)}>
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="layout">
        <div className="card">
          <h3>Leads by Source</h3>
          <ul>
            {Object.entries(stats.bySource).map(([source, count]) => (
              <li key={source}>
                {source}: <strong>{count}</strong>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h3>Leads by Job Type</h3>
          <ul>
            {Object.entries(stats.byJobType).map(([type, count]) => (
              <li key={type}>
                {type}: <strong>{count}</strong>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  )
}

export default App
