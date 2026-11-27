# Spill

Simple bill splitter that cares about your time.

- `/` splits a bill between people and sends it to settlement.
- `/settle/` keeps a local transaction ledger and shows who pays whom. It can also sync that ledger across devices with a shared `?k=` key.

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
