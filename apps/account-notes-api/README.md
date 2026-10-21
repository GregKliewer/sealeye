# Account notes

Keeps the notes staff leave on an account: who wrote it, when, and what it says. Lists an account's notes between two dates, newest first, and finds notes by the words in them, across accounts.
Owned by the Contact Centre team at Northline Bank, for agents on a call and the quality team reviewing them.
Keeps its notes in a relational database the platform provides: notes are searched by date range and by their words, and listed in order, which a document table found by key cannot do. The app reads where to connect from DATABASE_HOST, DATABASE_PORT, DATABASE_NAME and DATABASE_USER, and signs in with its own identity: there is no password anywhere.
It checks the database's certificate against the platform's bundle, `platform-ca.crt`, which the platform channel publishes.
Used by the agent desktop. Questions and corrections go to the Contact Centre team.
