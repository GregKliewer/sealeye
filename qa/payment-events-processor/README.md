# Payment Events Processor

Decides what happens to each outgoing payment: it takes payment events as they occur, confirms the payee against the beneficiary record, and writes back a released or held outcome, signed so the decision can be proven afterwards.
Owned by the Payments Product team at Northline Bank, on behalf of payment operations.
Depends on the payment event stream, the beneficiary lookup service and the outcome store. Decisions only: no balances, no payment instructions, no customer records.
Must not be reachable from the public internet. It takes its work from the payment stream, it answers to nobody outside the bank, and its outcomes are read by payment operations tooling.
