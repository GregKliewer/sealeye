const crypto = require('node:crypto')

const express = require('express')
const { Kafka } = require('kafkajs')
const { Pool } = require('pg')

const port = process.env.PORT || 3000
const brokers = (process.env.KAFKA_BROKERS || '').split(',').map(b => b.trim()).filter(Boolean)
const beneficiaryApiUrl = (process.env.BENEFICIARY_API_URL || '').replace(/\/+$/, '')
const signingKey = process.env.SIGNING_KEY

const TOPIC = 'payment.events'
const GROUP = 'payment-events-processor'

// Outcomes are the record payment operations reads, so they go to the payments store
// rather than staying in this process.
const outcomes = new Pool({ connectionString: process.env.DATABASE_URL })

const kafka = new Kafka({ clientId: GROUP, brokers })
const consumer = kafka.consumer({ groupId: GROUP })

// Nothing decides anything until the consumer is running, and the health endpoint says
// so rather than reporting well because the process happens to be up.
let consuming = false

const app = express()

app.get('/health', (req, res) => {
  res.status(consuming ? 200 : 503).json({
    service: GROUP,
    owner: 'Payments Product, Northline Bank',
    consuming,
    topic: TOPIC
  })
})

/**
 * The payee this payment is going to, from the beneficiary service. A payee nobody has
 * on file is not an error: it is a payment that does not go out today.
 */
async function lookupBeneficiary(reference) {
  const response = await fetch(`${beneficiaryApiUrl}/beneficiaries/${encodeURIComponent(reference)}`, {
    headers: { accept: 'application/json' }
  })

  if (response.status === 404) return null

  if (!response.ok) {
    throw new Error(`beneficiary lookup for ${reference} answered ${response.status}`)
  }

  return response.json()
}

/**
 * The fields of an outcome, in a fixed order, so the same decision always signs to the
 * same value and a signature can be checked years later.
 */
function canonical(outcome) {
  return [outcome.eventId, outcome.paymentReference, outcome.beneficiaryReference, outcome.decision, outcome.reason, outcome.decidedAt].join('\n')
}

function sign(outcome) {
  return crypto.createHmac('sha256', signingKey).update(canonical(outcome)).digest('hex')
}

/** A released payment is one with a verified payee. Everything else waits for a person. */
function decide(event, beneficiary) {
  if (!event.beneficiaryReference) return { decision: 'held', reason: 'the event names no beneficiary' }
  if (!beneficiary) return { decision: 'held', reason: 'no beneficiary on file for that reference' }
  if (beneficiary.status !== 'verified') return { decision: 'held', reason: `beneficiary is ${beneficiary.status}` }

  return { decision: 'released', reason: 'beneficiary verified' }
}

async function record(outcome) {
  await outcomes.query(
    `insert into payment_event_outcomes
       (event_id, payment_reference, beneficiary_reference, beneficiary_name, institution,
        decision, reason, decided_at, signature)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (event_id) do nothing`,
    [
      outcome.eventId,
      outcome.paymentReference,
      outcome.beneficiaryReference,
      outcome.beneficiaryName,
      outcome.institution,
      outcome.decision,
      outcome.reason,
      outcome.decidedAt,
      outcome.signature
    ]
  )
}

async function handle(message) {
  const event = JSON.parse(message.value.toString('utf8'))

  // Nothing to look up when the event names no payee, and an empty reference is not a
  // question worth asking the beneficiary service.
  const beneficiary = event.beneficiaryReference ? await lookupBeneficiary(event.beneficiaryReference) : null
  const { decision, reason } = decide(event, beneficiary)

  const outcome = {
    eventId: event.eventId,
    paymentReference: event.paymentReference,
    beneficiaryReference: event.beneficiaryReference,
    beneficiaryName: beneficiary ? beneficiary.payeeDisplayName : null,
    institution: beneficiary ? beneficiary.institution : null,
    decision,
    reason,
    decidedAt: new Date().toISOString()
  }

  outcome.signature = sign(outcome)

  await record(outcome)
  console.log(`${outcome.paymentReference}: ${decision} (${reason})`)
}

async function start() {
  if (!brokers.length) throw new Error('KAFKA_BROKERS is not set, so there is no payment stream to read')
  if (!beneficiaryApiUrl) throw new Error('BENEFICIARY_API_URL is not set, so no payee can be confirmed')
  if (!signingKey) throw new Error('SIGNING_KEY is not set, and an unsigned outcome cannot be proven later')

  app.listen(port, () => console.log(`payment-events-processor listening on port ${port}`))

  await consumer.connect()
  await consumer.subscribe({ topic: TOPIC, fromBeginning: false })

  await consumer.run({
    eachMessage: async ({ message }) => {
      try {
        await handle(message)
      } catch (err) {
        // Let it come back: an outcome that was never written is worse than one written
        // late, and the stream is what remembers the work.
        console.error(`could not decide ${message.key ? message.key.toString('utf8') : 'an event'}: ${err.message}`)
        throw err
      }
    }
  })

  consuming = true
  console.log(`reading ${TOPIC} as ${GROUP}`)
}

// Finish what is in hand, then let go of the stream and the store.
async function stop() {
  consuming = false
  await consumer.disconnect().catch(() => {})
  await outcomes.end().catch(() => {})
  process.exit(0)
}

process.on('SIGTERM', stop)
process.on('SIGINT', stop)

start().catch(err => {
  console.error(err.message)
  process.exit(1)
})
