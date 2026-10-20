const express = require('express')
const fs = require('node:fs')
const path = require('node:path')
const { Client } = require('pg')
const { Signer } = require('@aws-sdk/rds-signer')

const app = express()
const port = process.env.PORT || 3000

// Where the database is and who the app is to it. The platform gives this service the
// right to sign in as that user with its own identity; there is no password to keep.
const database = {
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT || 5432),
  database: process.env.DATABASE_NAME,
  user: process.env.DATABASE_USER
}
const configured = Boolean(database.host && database.database && database.user)

// The platform's certificate bundle, published in the platform channel: the connection
// is checked against it, never just encrypted.
function certificates () {
  const file = path.join(__dirname, 'platform-ca.crt')
  if (!fs.existsSync(file)) throw new Error("platform-ca.crt is missing: it is the platform's certificate bundle, published in the platform channel")
  return fs.readFileSync(file)
}

// A fresh connection for each request: the sign-in token is good for a quarter of an
// hour, and the app does not stay running between requests.
async function connect () {
  const signer = new Signer({ hostname: database.host, port: database.port, username: database.user })
  const client = new Client({ ...database, password: await signer.getAuthToken(), ssl: { ca: certificates(), rejectUnauthorized: true } })
  await client.connect()
  await client.query(`create table if not exists notes (
    id bigserial primary key,
    account text not null,
    author text not null,
    body text not null,
    written_at timestamptz not null default now()
  )`)
  await client.query('create index if not exists notes_account_written on notes (account, written_at desc)')
  return client
}

async function withDatabase (res, next, work) {
  if (!configured) return res.status(503).json({ error: 'no_database', message: 'No database is configured for this service.' })
  const client = await connect()
  try {
    await work(client)
  } catch (err) {
    next(err)
  } finally {
    await client.end()
  }
}

app.use(express.json())

app.get('/', (req, res) => res.json({
  service: 'account-notes-api',
  owner: 'Contact Centre, Northline Bank',
  status: configured ? 'ok' : 'no database configured',
  examples: ['POST /accounts/ACC-1001/notes', 'GET /accounts/ACC-1001/notes?since=2026-01-01&until=2026-12-31', 'GET /notes?q=overdraft']
}))

// A note is who said what about an account, and when.
app.post('/accounts/:account/notes', (req, res, next) => withDatabase(res, next, async client => {
  const account = String(req.params.account).toUpperCase()
  const { author, body } = req.body || {}
  if (!author || !body) {
    return res.status(400).json({ error: 'note_incomplete', message: 'A note needs an author and a body.' })
  }
  const { rows } = await client.query(
    'insert into notes (account, author, body) values ($1, $2, $3) returning id, account, author, body, written_at',
    [account, author, body]
  )
  res.status(201).json(rows[0])
}))

// An account's notes between two dates, newest first.
app.get('/accounts/:account/notes', (req, res, next) => withDatabase(res, next, async client => {
  const account = String(req.params.account).toUpperCase()
  const since = req.query.since ? new Date(String(req.query.since)) : new Date(0)
  const until = req.query.until ? new Date(String(req.query.until)) : new Date()
  const { rows } = await client.query(
    'select id, account, author, body, written_at from notes where account = $1 and written_at between $2 and $3 order by written_at desc limit 100',
    [account, since, until]
  )
  res.json(rows)
}))

// Notes anywhere that say a word.
app.get('/notes', (req, res, next) => withDatabase(res, next, async client => {
  const q = String(req.query.q || '').trim()
  if (!q) return res.status(400).json({ error: 'no_words', message: 'Give the words to look for in q.' })
  const { rows } = await client.query(
    'select id, account, author, body, written_at from notes where body ilike $1 order by written_at desc limit 100',
    [`%${q}%`]
  )
  res.json(rows)
}))

app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: 'notes_unavailable', message: 'The notes database could not be reached.' })
})

app.listen(port, () => console.log(`account-notes-api listening on port ${port}`))
