const express = require('express')
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb')
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require('@aws-sdk/lib-dynamodb')

const app = express()
const port = process.env.PORT || 3000

// The orders table. Its name arrives in ORDERS_TABLE; the platform gives this service
// the right to read and write it. Nothing else is configured here.
const tableName = process.env.ORDERS_TABLE
const table = DynamoDBDocumentClient.from(new DynamoDBClient({}))

app.use(express.json())

app.get('/', (req, res) => res.json({
  service: 'orders-api',
  owner: 'Branch Operations, Northline Bank',
  status: tableName ? 'ok' : 'no table configured',
  examples: ['PUT /orders/ORD-2026-0001', 'GET /orders/ORD-2026-0001']
}))

// An order is a small document found by its id: the branch, what was ordered and
// how many, and when the order was placed.
app.put('/orders/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id).toUpperCase()
    const { branch, item, quantity } = req.body || {}
    if (!branch || !item || !Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({
        error: 'order_incomplete',
        message: 'An order needs a branch, an item and a whole-number quantity of at least one.'
      })
    }
    const order = { id, branch, item, quantity, placedAt: new Date().toISOString() }
    await table.send(new PutCommand({ TableName: tableName, Item: order }))
    res.status(201).json(order)
  } catch (err) {
    next(err)
  }
})

app.get('/orders/:id', async (req, res, next) => {
  try {
    const id = String(req.params.id).toUpperCase()
    const { Item: order } = await table.send(new GetCommand({ TableName: tableName, Key: { id } }))
    // An order nobody placed is an ordinary answer, not a fault.
    if (!order) {
      return res.status(404).json({ error: 'order_not_found', id, message: 'No order is on file with that id.' })
    }
    res.json(order)
  } catch (err) {
    next(err)
  }
})

app.use((err, req, res, next) => {
  console.error(err)
  res.status(500).json({ error: 'orders_unavailable', message: 'The orders table could not be reached.' })
})

app.listen(port, () => console.log(`orders-api listening on port ${port}`))
