const express = require('express')
const app = express()
const port = process.env.PORT || 3000

// The beneficiary reference cache. Refreshed nightly from the payments system of
// record, and this copy is what the branch tools read all day. Reference data only:
// no balances, no payment instructions.
const beneficiaries = {
  'BEN-4417-2290': {
    accountReference: 'BEN-4417-2290',
    payeeDisplayName: 'Prairie Sky Roofing Ltd.',
    institution: 'Northline Bank',
    status: 'verified'
  },
  'BEN-8823-0145': {
    accountReference: 'BEN-8823-0145',
    payeeDisplayName: 'Hollis & Wren Legal Services',
    institution: 'Cascade Trust',
    status: 'pending_review'
  },
  'BEN-3390-7716': {
    accountReference: 'BEN-3390-7716',
    payeeDisplayName: 'Chinook Valley Dental Corp.',
    institution: 'Meridian Credit Union',
    status: 'closed'
  }
}

app.get('/', (req, res) => res.json({
  service: 'beneficiary-lookup-api',
  owner: 'Payments Product, Northline Bank',
  status: 'ok',
  examples: Object.keys(beneficiaries).map(reference => `/beneficiaries/${reference}`)
}))

app.get('/beneficiaries/:reference', (req, res) => {
  const reference = String(req.params.reference).toUpperCase()
  const beneficiary = beneficiaries[reference]
  const checkedAt = new Date().toISOString()

  // A reference nobody has on file is an ordinary answer, not an error worth paging
  // anyone about. The branch screen shows the message as it arrives.
  if (!beneficiary) {
    return res.status(404).json({
      error: 'beneficiary_not_found',
      accountReference: reference,
      message: 'No beneficiary is on file for that reference.',
      checkedAt
    })
  }

  res.json({ ...beneficiary, checkedAt })
})

app.listen(port, () => console.log(`beneficiary-lookup-api listening on port ${port}`))
