import { useEffect, useMemo, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
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

type ReplyTimeCategory = '7:00-3:30' | '3:00-6:00' | 'After 6' | 'Weekend'
type YesNo = 'Yes' | 'No'
type Page = 'leads' | 'weekly-dashboard'

type Lead = {
  id: string
  date: string
  customer: string
  leadSource: string
  jobType: string
  leadCost: string
  jobWon: YesNo
  comments: string
  replyTimeCategory: ReplyTimeCategory
  replyTimeMinutes: string
  booked: YesNo
  sold: YesNo
  cancelled: YesNo
  soldAmount: string
  revenue: string
  // legacy field support
  replyTime?: string
}

type LeadInput = Omit<Lead, 'id'>

const defaultReplyCategory: ReplyTimeCategory = '7:00-3:30'

const emptyLead: LeadInput = {
  date: '',
  customer: '',
  leadSource: '',
  jobType: '',
  leadCost: '',
  jobWon: 'No',
  comments: '',
  replyTimeCategory: defaultReplyCategory,
  replyTimeMinutes: '',
  booked: 'No',
  sold: 'No',
  cancelled: 'No',
  soldAmount: '',
  revenue: '',
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
    replyTimeCategory: '7:00-3:30',
    replyTimeMinutes: '30',
    booked: 'Yes',
    sold: 'Yes',
    cancelled: 'No',
    soldAmount: '$350',
    revenue: '$1800',
  },
  {
    date: '2026-02-01',
    customer: 'Curtis L.',
    leadSource: 'Yelp',
    jobType: 'Service',
    leadCost: '$0',
    jobWon: 'No',
    comments: 'Customer said, "Sorry, I no longer need this service"',
    replyTimeCategory: 'Weekend',
    replyTimeMinutes: '214',
    booked: 'No',
    sold: 'No',
    cancelled: 'No',
    soldAmount: '$0',
    revenue: '$0',
  },
  {
    date: '2026-02-01',
    customer: 'Jun Trinos',
    leadSource: 'Yelp',
    jobType: 'Service',
    leadCost: '$0',
    jobWon: 'No',
    comments: 'Building energy audit - Broken waterheater',
    replyTimeCategory: 'Weekend',
    replyTimeMinutes: '1',
    booked: 'No',
    sold: 'No',
    cancelled: 'No',
    soldAmount: '$0',
    revenue: '$0',
  },
]

const parseMoney = (value: string) => {
  const num = Number(value.replace(/[^\d.-]/g, ''))
  return Number.isFinite(num) ? num : 0
}

const getReplyMinutes = (lead: Lead) => {
  const fromNew = Number(lead.replyTimeMinutes)
  if (Number.isFinite(fromNew) && fromNew >= 0) return fromNew

  if (lead.replyTime) {
    const found = lead.replyTime.match(/\d+/)
    if (found) return Number(found[0])
  }

  return null
}

const money = (value: number) =>
  value.toLocaleString(undefined, { style: 'currency', currency: 'USD' })

const percent = (value: number) => `${(value * 100).toFixed(2)}%`

const toMonthValue = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`

const weekLabel = (startDay: number, endDay: number) => `${startDay}-${endDay}`

const csvToRows = (text: string) => {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)

  if (lines.length < 2) return [] as Record<string, string>[]

  const parseLine = (line: string) => {
    const values: string[] = []
    let current = ''
    let inQuotes = false

    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"'
          i += 1
        } else {
          inQuotes = !inQuotes
        }
      } else if (ch === ',' && !inQuotes) {
        values.push(current.trim())
        current = ''
      } else {
        current += ch
      }
    }
    values.push(current.trim())
    return values
  }

  const headers = parseLine(lines[0]).map((h) => h.toLowerCase())

  return lines.slice(1).map((line) => {
    const cols = parseLine(line)
    return headers.reduce<Record<string, string>>((acc, h, idx) => {
      acc[h] = cols[idx] ?? ''
      return acc
    }, {})
  })
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
  const [importStatus, setImportStatus] = useState('')
  const [page, setPage] = useState<Page>('leads')
  const [selectedMonth, setSelectedMonth] = useState(toMonthValue(new Date()))
  const [selectedWeek, setSelectedWeek] = useState('1-7')

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
        const data = item.data() as Partial<LeadInput> & { replyTime?: string }

        const replyTimeCategory =
          data.replyTimeCategory ||
          (data.replyTime?.toLowerCase().includes('weekend')
            ? 'Weekend'
            : defaultReplyCategory)

        const replyTimeMinutes =
          data.replyTimeMinutes || data.replyTime?.match(/\d+/)?.[0] || ''

        const sold = data.sold || (data.jobWon === 'Yes' ? 'Yes' : 'No')
        const booked = data.booked || (sold === 'Yes' ? 'Yes' : 'No')

        return {
          id: item.id,
          date: data.date || '',
          customer: data.customer || '',
          leadSource: data.leadSource || '',
          jobType: data.jobType || '',
          leadCost: data.leadCost || '',
          jobWon: data.jobWon === 'Yes' ? 'Yes' : 'No',
          comments: data.comments || '',
          replyTimeCategory,
          replyTimeMinutes,
          booked: booked === 'Yes' ? 'Yes' : 'No',
          sold: sold === 'Yes' ? 'Yes' : 'No',
          cancelled: data.cancelled === 'Yes' ? 'Yes' : 'No',
          soldAmount: data.soldAmount || '',
          revenue: data.revenue || '',
          replyTime: data.replyTime,
        }
      })
      setLeads(rows)
    })

    return () => unsub()
  }, [user])

  const stats = useMemo(() => {
    const totalLeads = leads.length
    const wonLeads = leads.filter((l) => l.jobWon === 'Yes').length
    const totalCost = leads.reduce((sum, l) => sum + parseMoney(l.leadCost), 0)
    const winRate = totalLeads > 0 ? (wonLeads / totalLeads) * 100 : 0

    const replyTimes = leads
      .map((lead) => getReplyMinutes(lead))
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

    const avgReplyByCategory = leads.reduce<
      Record<ReplyTimeCategory, { sum: number; count: number }>
    >(
      (acc, lead) => {
        const mins = getReplyMinutes(lead)
        if (mins === null) return acc
        const category = lead.replyTimeCategory || defaultReplyCategory
        acc[category].sum += mins
        acc[category].count += 1
        return acc
      },
      {
        '7:00-3:30': { sum: 0, count: 0 },
        '3:00-6:00': { sum: 0, count: 0 },
        'After 6': { sum: 0, count: 0 },
        Weekend: { sum: 0, count: 0 },
      },
    )

    return {
      totalLeads,
      wonLeads,
      totalCost,
      winRate,
      avgReplyTime,
      bySource,
      byJobType,
      avgReplyByCategory,
    }
  }, [leads])

  const monthWeeks = useMemo(() => {
    const [yearStr, monthStr] = selectedMonth.split('-')
    const year = Number(yearStr)
    const month = Number(monthStr)
    if (!year || !month) return ['1-7', '8-14', '15-21', '22-28']

    const lastDay = new Date(year, month, 0).getDate()
    const weeks: string[] = []
    for (let start = 1; start <= lastDay; start += 7) {
      const end = Math.min(start + 6, lastDay)
      weeks.push(weekLabel(start, end))
    }
    return weeks
  }, [selectedMonth])

  useEffect(() => {
    if (!monthWeeks.includes(selectedWeek)) {
      setSelectedWeek(monthWeeks[0])
    }
  }, [monthWeeks, selectedWeek])

  const weekly = useMemo(() => {
    const [yearStr, monthStr] = selectedMonth.split('-')
    const [startStr, endStr] = selectedWeek.split('-')
    const year = Number(yearStr)
    const month = Number(monthStr)
    const startDay = Number(startStr)
    const endDay = Number(endStr)

    if (!year || !month || !startDay || !endDay) {
      return {
        rows: [] as Array<{
          source: string
          spend: number
          leads: number
          booked: number
          sold: number
          cancelled: number
          cpl: number
          soldAmount: number
          revenue: number
          fiveXReturn: number
        }>,
        totals: {
          spend: 0,
          leads: 0,
          booked: 0,
          sold: 0,
          cancelled: 0,
          soldAmount: 0,
          revenue: 0,
          avgReplyMins: 0,
        },
      }
    }

    const filtered = leads.filter((lead) => {
      const d = new Date(`${lead.date}T00:00:00`)
      if (Number.isNaN(d.getTime())) return false
      const y = d.getFullYear()
      const m = d.getMonth() + 1
      const day = d.getDate()
      return y === year && m === month && day >= startDay && day <= endDay
    })

    const grouped = filtered.reduce<
      Record<
        string,
        {
          spend: number
          leads: number
          booked: number
          sold: number
          cancelled: number
          soldAmount: number
          revenue: number
        }
      >
    >((acc, lead) => {
      const key = lead.leadSource || 'Unknown'
      if (!acc[key]) {
        acc[key] = {
          spend: 0,
          leads: 0,
          booked: 0,
          sold: 0,
          cancelled: 0,
          soldAmount: 0,
          revenue: 0,
        }
      }

      acc[key].spend += parseMoney(lead.leadCost)
      acc[key].leads += 1
      if (lead.booked === 'Yes') acc[key].booked += 1
      if (lead.sold === 'Yes') acc[key].sold += 1
      if (lead.cancelled === 'Yes') acc[key].cancelled += 1
      acc[key].soldAmount += parseMoney(lead.soldAmount)
      acc[key].revenue += parseMoney(lead.revenue)
      return acc
    }, {})

    const rows = Object.entries(grouped)
      .map(([source, data]) => ({
        source,
        ...data,
        cpl: data.leads > 0 ? data.spend / data.leads : 0,
        fiveXReturn: data.spend * 5,
      }))
      .sort((a, b) => b.spend - a.spend)

    const totals = rows.reduce(
      (acc, row) => {
        acc.spend += row.spend
        acc.leads += row.leads
        acc.booked += row.booked
        acc.sold += row.sold
        acc.cancelled += row.cancelled
        acc.soldAmount += row.soldAmount
        acc.revenue += row.revenue
        return acc
      },
      {
        spend: 0,
        leads: 0,
        booked: 0,
        sold: 0,
        cancelled: 0,
        soldAmount: 0,
        revenue: 0,
        avgReplyMins: 0,
      },
    )

    const weeklyReply = filtered
      .map((lead) => getReplyMinutes(lead))
      .filter((v): v is number => v !== null)

    totals.avgReplyMins =
      weeklyReply.length > 0
        ? weeklyReply.reduce((a, b) => a + b, 0) / weeklyReply.length
        : 0

    return { rows, totals }
  }, [leads, selectedMonth, selectedWeek])

  const weeklyRatios = useMemo(() => {
    const t = weekly.totals
    const cpl = t.leads > 0 ? t.spend / t.leads : 0
    const costPerBooked = t.booked > 0 ? t.spend / t.booked : 0
    const roasX = t.spend > 0 ? t.soldAmount / t.spend : 0
    const bookingRate = t.leads > 0 ? t.booked / t.leads : 0
    const closeRate = t.booked > 0 ? t.sold / t.booked : 0
    const cancellingRate = t.booked > 0 ? t.cancelled / t.booked : 0

    return { cpl, costPerBooked, roasX, bookingRate, closeRate, cancellingRate }
  }, [weekly.totals])

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
      const normalizedForm = {
        ...form,
        jobWon: form.sold,
      }

      if (editingId) {
        await updateDoc(doc(leadsRef, editingId), {
          ...normalizedForm,
          updatedAt: serverTimestamp(),
        })
      } else {
        await addDoc(leadsRef, {
          ...normalizedForm,
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
      replyTimeCategory: lead.replyTimeCategory || defaultReplyCategory,
      replyTimeMinutes: lead.replyTimeMinutes || '',
      booked: lead.booked,
      sold: lead.sold,
      cancelled: lead.cancelled,
      soldAmount: lead.soldAmount || '',
      revenue: lead.revenue || '',
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

  const normalizeImportedLead = (row: Record<string, string>): LeadInput => {
    const yesNo = (value: string): YesNo =>
      value?.toLowerCase() === 'yes' ? 'Yes' : 'No'

    return {
      date: row.date || '',
      customer: row.customer || row.name || '',
      leadSource: row['lead source'] || row.leadsource || row.source || '',
      jobType: row['job type'] || row.jobtype || '',
      leadCost: row['lead cost'] || row.leadcost || row.cost || '$0',
      jobWon: yesNo(row['job won'] || row.jobwon || row.sold || 'No'),
      comments: row.comments || '',
      replyTimeCategory:
        (row['reply time category'] as ReplyTimeCategory) ||
        (row.replytimecategory as ReplyTimeCategory) ||
        defaultReplyCategory,
      replyTimeMinutes: row['reply time minutes'] || row.replytimeminutes || '',
      booked: yesNo(row.booked || 'No'),
      sold: yesNo(row.sold || row['job won'] || 'No'),
      cancelled: yesNo(row.cancelled || row.canceled || 'No'),
      soldAmount: row['sold amount'] || row.soldamount || '$0',
      revenue: row.revenue || '$0',
    }
  }

  const handleFileImport = async (e: ChangeEvent<HTMLInputElement>) => {
    if (!user) return
    const file = e.target.files?.[0]
    if (!file) return

    const text = await file.text()
    const leadsRef = collection(db, 'users', user.uid, 'leads')

    try {
      let rows: Record<string, string>[] = []

      if (file.name.toLowerCase().endsWith('.json')) {
        const parsed = JSON.parse(text)
        if (Array.isArray(parsed)) {
          rows = parsed as Record<string, string>[]
        }
      } else {
        rows = csvToRows(text)
      }

      if (rows.length === 0) {
        setImportStatus('No rows found. Check your file format.')
        return
      }

      for (const row of rows) {
        const lead = normalizeImportedLead(row)
        if (!lead.date || !lead.customer) continue

        await addDoc(leadsRef, {
          ...lead,
          jobWon: lead.sold,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      }

      setImportStatus(`Imported ${rows.length} rows from ${file.name}`)
      e.target.value = ''
    } catch {
      setImportStatus('Import failed. Use CSV/JSON with matching headers.')
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
          <button
            className={page === 'leads' ? '' : 'ghost'}
            onClick={() => setPage('leads')}
          >
            Leads
          </button>
          <button
            className={page === 'weekly-dashboard' ? '' : 'ghost'}
            onClick={() => setPage('weekly-dashboard')}
          >
            Weekly Dashboard
          </button>
          <button className="ghost" onClick={seedData}>
            Load sample leads
          </button>
          <button className="ghost" onClick={() => signOut(auth)}>
            Logout
          </button>
        </div>
      </header>

      {page === 'leads' ? (
        <>
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
              <strong>{money(stats.totalCost)}</strong>
            </article>
            <article className="stat-card">
              <h2>Avg Reply Time</h2>
              <strong>{stats.avgReplyTime.toFixed(1)} mins</strong>
            </article>
          </section>

          <section className="card import-card">
            <div>
              <h3>Import current leads</h3>
              <p className="muted">
                Upload CSV or JSON. Minimum fields: <code>date</code>, <code>customer</code>, <code>lead source</code>.
              </p>
            </div>
            <label className="file-label">
              <span>Choose file</span>
              <input type="file" accept=".csv,.json" onChange={handleFileImport} />
            </label>
            {importStatus && <p className="muted">{importStatus}</p>}
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
                Booked
                <select
                  value={form.booked}
                  onChange={(e) =>
                    setForm({ ...form, booked: e.target.value as YesNo })
                  }
                >
                  <option value="No">No</option>
                  <option value="Yes">Yes</option>
                </select>
              </label>
              <label>
                Sold
                <select
                  value={form.sold}
                  onChange={(e) => setForm({ ...form, sold: e.target.value as YesNo })}
                >
                  <option value="No">No</option>
                  <option value="Yes">Yes</option>
                </select>
              </label>
              <label>
                Cancelled
                <select
                  value={form.cancelled}
                  onChange={(e) =>
                    setForm({ ...form, cancelled: e.target.value as YesNo })
                  }
                >
                  <option value="No">No</option>
                  <option value="Yes">Yes</option>
                </select>
              </label>
              <label>
                Sold Amount ($)
                <input
                  placeholder="$0"
                  value={form.soldAmount}
                  onChange={(e) =>
                    setForm({ ...form, soldAmount: e.target.value })
                  }
                />
              </label>
              <label>
                Revenue ($)
                <input
                  placeholder="$0"
                  value={form.revenue}
                  onChange={(e) => setForm({ ...form, revenue: e.target.value })}
                />
              </label>
              <label>
                Reply Time Category
                <select
                  value={form.replyTimeCategory}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      replyTimeCategory: e.target.value as ReplyTimeCategory,
                    })
                  }
                >
                  <option value="7:00-3:30">7:00-3:30</option>
                  <option value="3:00-6:00">3:00-6:00</option>
                  <option value="After 6">After 6</option>
                  <option value="Weekend">Weekend</option>
                </select>
              </label>
              <label>
                Reply Time (minutes)
                <input
                  type="number"
                  min={0}
                  placeholder="e.g. 25"
                  value={form.replyTimeMinutes}
                  onChange={(e) =>
                    setForm({ ...form, replyTimeMinutes: e.target.value })
                  }
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
                    <th>Booked</th>
                    <th>Sold</th>
                    <th>Cancelled</th>
                    <th>Sold $</th>
                    <th>Revenue</th>
                    <th>Reply Window</th>
                    <th>Reply (mins)</th>
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
                      <td>{lead.booked}</td>
                      <td>{lead.sold}</td>
                      <td>{lead.cancelled}</td>
                      <td>{lead.soldAmount}</td>
                      <td>{lead.revenue}</td>
                      <td>{lead.replyTimeCategory}</td>
                      <td>{getReplyMinutes(lead) ?? '-'}</td>
                      <td>{lead.comments}</td>
                      <td>
                        <div className="row">
                          <button className="ghost" onClick={() => onEdit(lead)}>
                            Edit
                          </button>
                          <button
                            className="danger"
                            onClick={() => onDelete(lead.id)}
                          >
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

          <section className="card">
            <h3>Average Reply Time by Category</h3>
            <ul>
              {(Object.keys(stats.avgReplyByCategory) as ReplyTimeCategory[]).map(
                (category) => {
                  const data = stats.avgReplyByCategory[category]
                  const avg = data.count > 0 ? data.sum / data.count : 0
                  return (
                    <li key={category}>
                      {category}: <strong>{avg.toFixed(1)} mins</strong>{' '}
                      <small>({data.count} leads)</small>
                    </li>
                  )
                },
              )}
            </ul>
          </section>
        </>
      ) : (
        <>
          <section className="card filter-row">
            <label>
              Month
              <input
                type="month"
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value)}
              />
            </label>
            <label>
              Week
              <select
                value={selectedWeek}
                onChange={(e) => setSelectedWeek(e.target.value)}
              >
                {monthWeeks.map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <strong>
                {selectedMonth} | {selectedWeek}
              </strong>
            </div>
          </section>

          <section className="card table-wrap">
            <h3>Weekly Source Performance</h3>
            <table>
              <thead>
                <tr>
                  <th>Lead Source</th>
                  <th>Spend</th>
                  <th># of Leads</th>
                  <th>Booked Leads</th>
                  <th>Sold Leads</th>
                  <th>Cancelled</th>
                  <th>CPL</th>
                  <th>SOLD</th>
                  <th>Revenue</th>
                  <th>5X Return</th>
                </tr>
              </thead>
              <tbody>
                {weekly.rows.map((row) => (
                  <tr key={row.source}>
                    <td>{row.source}</td>
                    <td>{money(row.spend)}</td>
                    <td>{row.leads}</td>
                    <td>{row.booked}</td>
                    <td>{row.sold}</td>
                    <td>{row.cancelled}</td>
                    <td>{row.leads > 0 ? money(row.cpl) : '#DIV/0!'}</td>
                    <td>{money(row.soldAmount)}</td>
                    <td>{money(row.revenue)}</td>
                    <td>{money(row.fiveXReturn)}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>TOTAL</strong>
                  </td>
                  <td>
                    <strong>{money(weekly.totals.spend)}</strong>
                  </td>
                  <td>
                    <strong>{weekly.totals.leads}</strong>
                  </td>
                  <td>
                    <strong>{weekly.totals.booked}</strong>
                  </td>
                  <td>
                    <strong>{weekly.totals.sold}</strong>
                  </td>
                  <td>
                    <strong>{weekly.totals.cancelled}</strong>
                  </td>
                  <td>
                    <strong>
                      {weekly.totals.leads > 0
                        ? money(weeklyRatios.cpl)
                        : '#DIV/0!'}
                    </strong>
                  </td>
                  <td>
                    <strong>{money(weekly.totals.soldAmount)}</strong>
                  </td>
                  <td>
                    <strong>{money(weekly.totals.revenue)}</strong>
                  </td>
                  <td>
                    <strong>{money(weekly.totals.spend * 5)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <section className="stats-grid">
            <article className="stat-card">
              <h2>CPL</h2>
              <strong>
                {weekly.totals.leads > 0 ? money(weeklyRatios.cpl) : '#DIV/0!'}
              </strong>
            </article>
            <article className="stat-card">
              <h2>Cost per booked</h2>
              <strong>
                {weekly.totals.booked > 0
                  ? money(weeklyRatios.costPerBooked)
                  : '#DIV/0!'}
              </strong>
            </article>
            <article className="stat-card">
              <h2>Return on Ad Spend (X)</h2>
              <strong>{weeklyRatios.roasX.toFixed(2)}</strong>
            </article>
            <article className="stat-card">
              <h2>Booking Rate</h2>
              <strong>{percent(weeklyRatios.bookingRate)}</strong>
            </article>
            <article className="stat-card">
              <h2>Close Rate</h2>
              <strong>{percent(weeklyRatios.closeRate)}</strong>
            </article>
            <article className="stat-card">
              <h2>Cancelling Rate</h2>
              <strong>{percent(weeklyRatios.cancellingRate)}</strong>
            </article>
            <article className="stat-card">
              <h2>Response Time (STL)</h2>
              <strong>
                {Math.floor(weekly.totals.avgReplyMins / 60)}hr{' '}
                {Math.round(weekly.totals.avgReplyMins % 60)}min
              </strong>
            </article>
          </section>
        </>
      )}
    </main>
  )
}

export default App
