import { useEffect, useMemo, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import './App.css'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  writeBatch,
} from 'firebase/firestore'
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth'
import type { User } from 'firebase/auth'
import { auth, db } from './firebase'
import * as XLSX from 'xlsx'

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

const normalizeHeader = (value: string) =>
  value
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, ' ')

const csvToMatrix = (text: string) => {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean)

  if (lines.length === 0) return [] as string[][]

  const delimiter = lines[0].includes('\t') ? '\t' : ','

  const parseLine = (line: string) => {
    if (delimiter === '\t') return line.split('\t').map((v) => v.trim())

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

  return lines.map(parseLine)
}

const csvToRows = (text: string) => {
  const matrix = csvToMatrix(text)
  if (matrix.length < 2) return [] as Record<string, string>[]

  const headers = matrix[0].map(normalizeHeader)

  return matrix.slice(1).map((cols) =>
    headers.reduce<Record<string, string>>((acc, h, idx) => {
      acc[h] = String(cols[idx] ?? '').trim()
      return acc
    }, {}),
  )
}

const parseScorecardToLeads = (text: string): LeadInput[] => {
  const matrix = csvToMatrix(text)
  if (!matrix.length) return []

  const headerRow = matrix.find((row) =>
    row.some((c) => /[A-Z]{3}:\s*\d+/i.test(c)),
  )
  const channelStart = matrix.findIndex((row) =>
    row[0]?.toLowerCase().includes('channel performance'),
  )
  if (!headerRow || channelStart === -1) return []

  const weekColumns = headerRow
    .map((value, idx) => ({ idx, value: value.trim() }))
    .filter((x) => /[A-Z]{3}:\s*\d+/i.test(x.value))

  if (!weekColumns.length) return []

  const monthMap: Record<string, number> = {
    JAN: 1,
    FEB: 2,
    MAR: 3,
    APR: 4,
    MAY: 5,
    JUN: 6,
    JUL: 7,
    AUG: 8,
    SEP: 9,
    OCT: 10,
    NOV: 11,
    DEC: 12,
  }

  const year = new Date().getFullYear()
  const leadsOut: LeadInput[] = []

  const end = matrix.findIndex(
    (row, idx) => idx > channelStart && row[0]?.toLowerCase().includes('brand & reputation'),
  )
  const channelRows = matrix.slice(channelStart + 1, end === -1 ? channelStart + 8 : end)

  for (const row of channelRows) {
    const source = (row[0] || '').trim()
    if (!source || /goal|actual/i.test(source)) continue

    for (const week of weekColumns) {
      const raw = String(row[week.idx] || '')
      const count = Number((raw.match(/\d+/) || ['0'])[0])
      if (!count || count < 1) continue

      const weekMatch = week.value.match(/([A-Z]{3}):\s*(\d{1,2})/i)
      const mon = weekMatch ? monthMap[weekMatch[1].toUpperCase()] : undefined
      const day = weekMatch ? Number(weekMatch[2]) : 1
      const date = `${year}-${String(mon || 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

      for (let i = 1; i <= count; i += 1) {
        leadsOut.push({
          date,
          customer: `Imported ${source} Lead ${i}`,
          leadSource: source,
          jobType: 'Imported',
          leadCost: '$0',
          jobWon: 'No',
          comments: `Imported from marketing scorecard (${week.value})`,
          replyTimeCategory: defaultReplyCategory,
          replyTimeMinutes: '',
          booked: 'No',
          sold: 'No',
          cancelled: 'No',
          soldAmount: '$0',
          revenue: '$0',
        })
      }
    }
  }

  return leadsOut
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
  const [showLeadModal, setShowLeadModal] = useState(false)
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
      setShowLeadModal(false)
    } catch (err) {
      const next = err instanceof Error ? err.message : 'Unable to save lead.'
      setMessage(next)
    }
  }

  const onEdit = (lead: Lead) => {
    setEditingId(lead.id)
    setShowLeadModal(true)
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

  const openNewLeadModal = () => {
    setEditingId(null)
    setForm(emptyLead)
    setShowLeadModal(true)
  }

  const onDelete = async (id: string) => {
    if (!user) return
    if (!window.confirm('Delete this lead?')) return

    const leadsRef = collection(db, 'users', user.uid, 'leads')
    await deleteDoc(doc(leadsRef, id))
  }

  const deleteAllLeads = async () => {
    if (!user) return
    const ok = window.confirm('Delete ALL leads? This cannot be undone.')
    if (!ok) return

    const leadsRef = collection(db, 'users', user.uid, 'leads')
    const snapshot = await getDocs(leadsRef)

    if (snapshot.empty) {
      setMessage('No leads to delete.')
      return
    }

    let deleted = 0
    let batch = writeBatch(db)
    let opCount = 0

    for (const row of snapshot.docs) {
      batch.delete(row.ref)
      opCount += 1
      deleted += 1

      if (opCount === 400) {
        await batch.commit()
        batch = writeBatch(db)
        opCount = 0
      }
    }

    if (opCount > 0) {
      await batch.commit()
    }

    setMessage(`Deleted ${deleted} leads.`)
  }

  const normalizeImportedLead = (row: Record<string, string>): LeadInput => {
    const yesNo = (value: string): YesNo =>
      value?.toLowerCase() === 'yes' ? 'Yes' : 'No'

    const pick = (...keys: string[]) => {
      for (const key of keys) {
        const value = row[normalizeHeader(key)]
        if (value !== undefined && value !== '') return value
      }
      return ''
    }

    const rawCategory = pick('reply time category')
    const allowed: ReplyTimeCategory[] = ['7:00-3:30', '3:00-6:00', 'After 6', 'Weekend']
    const replyTimeCategory = allowed.includes(rawCategory as ReplyTimeCategory)
      ? (rawCategory as ReplyTimeCategory)
      : defaultReplyCategory

    return {
      date: pick('date'),
      customer: pick('customer', 'name'),
      leadSource: pick('lead source', 'source'),
      jobType: pick('job type'),
      leadCost: pick('lead cost', 'cost') || '$0',
      jobWon: yesNo(pick('job won', 'sold') || 'No'),
      comments: pick('comments'),
      replyTimeCategory,
      replyTimeMinutes: pick('reply time minutes'),
      booked: yesNo(pick('booked') || 'No'),
      sold: yesNo(pick('sold', 'job won') || 'No'),
      cancelled: yesNo(pick('cancelled', 'canceled') || 'No'),
      soldAmount: pick('sold amount') || '$0',
      revenue: pick('revenue') || '$0',
    }
  }

  const handleFileImport = async (e: ChangeEvent<HTMLInputElement>) => {
    if (!user) return
    const file = e.target.files?.[0]
    if (!file) return

    setImportStatus(`Importing ${file.name}...`)
    const leadsRef = collection(db, 'users', user.uid, 'leads')

    try {
      let rows: Record<string, string>[] = []
      const lowerName = file.name.toLowerCase()

      if (lowerName.endsWith('.json')) {
        const parsed = JSON.parse(await file.text())
        if (Array.isArray(parsed)) rows = parsed as Record<string, string>[]
      } else if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls')) {
        const buffer = await file.arrayBuffer()
        const workbook = XLSX.read(buffer, { type: 'array' })
        const sheetName = workbook.SheetNames[0]
        const sheet = workbook.Sheets[sheetName]
        const jsonRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
          defval: '',
        })
        rows = jsonRows.map((r) => {
          const normalized: Record<string, string> = {}
          Object.entries(r).forEach(([key, value]) => {
            normalized[normalizeHeader(String(key))] = String(value ?? '').trim()
          })
          return normalized
        })
      } else {
        rows = csvToRows(await file.text())
      }

      if (rows.length === 0) {
        setImportStatus('No rows found. Check file headers and content.')
        return
      }

      let importedCount = 0
      for (const row of rows) {
        const lead = normalizeImportedLead(row)
        if (!lead.date || !lead.customer) continue

        await addDoc(leadsRef, {
          ...lead,
          jobWon: lead.sold,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
        importedCount += 1
      }

      if (importedCount === 0 && (lowerName.endsWith('.csv') || lowerName.endsWith('.tsv'))) {
        const scorecardLeads = parseScorecardToLeads(await file.text())
        for (const lead of scorecardLeads) {
          await addDoc(leadsRef, {
            ...lead,
            jobWon: lead.sold,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          })
          importedCount += 1
        }
      }

      if (importedCount === 0) {
        setImportStatus('Imported 0 rows. Make sure date + customer are present.')
      } else {
        setImportStatus(`Imported ${importedCount} leads from ${file.name}`)
      }

      e.target.value = ''
    } catch {
      setImportStatus('Import failed. Use CSV, XLSX, or JSON with matching headers.')
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
          {page === 'leads' ? (
            <>
              <button className="ghost" onClick={() => setPage('weekly-dashboard')}>
                Weekly Dashboard
              </button>
              <button onClick={openNewLeadModal}>Add Lead</button>
              <button className="danger" onClick={deleteAllLeads}>
                Delete all leads
              </button>
            </>
          ) : (
            <button className="ghost" onClick={() => setPage('leads')}>
              ← Back to Leads
            </button>
          )}
          <button className="ghost" onClick={() => signOut(auth)}>
            Logout
          </button>
        </div>
      </header>

      {message && <p className="muted">{message}</p>}

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
                Upload CSV, XLSX, or JSON. Supports normal lead rows and your marketing scorecard CSV format.
              </p>
            </div>
            <label className="file-label">
              <span>Choose file</span>
              <input type="file" accept=".csv,.tsv,.xlsx,.xls,.json" onChange={handleFileImport} />
            </label>
            {importStatus && <p className="muted">{importStatus}</p>}
          </section>

          <section className="card table-wrap leads-table">
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
          </section>

          {showLeadModal && (
            <div className="modal-overlay" onClick={() => setShowLeadModal(false)}>
              <div className="modal-card card" onClick={(e) => e.stopPropagation()}>
                <div className="row modal-head">
                  <h3>{editingId ? 'Edit Lead' : 'Add Lead'}</h3>
                  <button className="ghost" onClick={() => setShowLeadModal(false)}>
                    Close
                  </button>
                </div>
                <form onSubmit={saveLead} className="form-grid">
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
                      onChange={(e) => setForm({ ...form, booked: e.target.value as YesNo })}
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
                      onChange={(e) => setForm({ ...form, cancelled: e.target.value as YesNo })}
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
                      onChange={(e) => setForm({ ...form, soldAmount: e.target.value })}
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
                      onChange={(e) => setForm({ ...form, replyTimeMinutes: e.target.value })}
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
                          setShowLeadModal(false)
                        }}
                      >
                        Cancel Edit
                      </button>
                    )}
                  </div>
                </form>
              </div>
            </div>
          )}

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
