# Spill

Simple bill splitter that cares about your time.

- `/` splits a bill between people and sends it to settlement.
- `/settle/` keeps local transaction ledgers and shows who pays whom. Up to 10 ledgers can be switched in the Ledgers dialog; each keeps its own people and transactions and has its own `?k=` key for cross-device sync. A new ledger can be blank or duplicate the current one to branch off. Ledgers are identified by the first 6 chars of that key, shown uppercase.

## Local sync

The deployed PubSub host rejects local origins. For local development, start the PubSub server:

```bash
cd ../pi/pubsub/src
node server.js
```

`/settle/` on `localhost` connects to `ws://localhost:8075` automatically.

## Tests

```bash
node tests/site.test.js
node tests/settle.test.js
```

## Built With

- [Alpine.js](https://alpinejs.dev/)
- [Bootstrap](https://getbootstrap.com/)
- [Vercel](https://vercel.com/)
