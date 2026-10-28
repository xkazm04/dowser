# Configuration

Pebble Shop reads its settings from environment variables at start-up.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Port the HTTP server listens on. |
| `MAX_CART_ITEMS` | `50` | Most items one cart can hold. |
| `SESSION_TTL_MINUTES` | `30` | Minutes of inactivity before a session ends. |
| `CURRENCY` | `EUR` | Currency for prices and charges. |
| `PEBBLE_DB` | `data/pebble.db` | Path of the SQLite database file. |

## Payment provider

Checkout charges cards through StonePay. Ask StonePay for a merchant key and keep it out of
version control.
