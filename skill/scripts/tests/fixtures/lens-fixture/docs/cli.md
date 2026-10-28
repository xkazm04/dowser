# Admin CLI

`pebble` is installed with the shop (`npm ci` links it as `npx pebble`).

## Commands

### `pebble receipts resend <order-id>`

Sends the receipt e-mail for an order again. See [receipts.md](receipts.md).

### `pebble prices import <file.json>`

Updates prices in bulk. The file is a JSON array of `{"sku": "...", "price": 12.5}` rows.

### `pebble report nightly [--out <dir>]`

Writes yesterday's orders to `orders-<date>.csv` in the given folder (default: the current one).

### `pebble orders sync`

Pushes new orders to the accounting system. Run it every night from cron:

```sh
0 2 * * * cd /srv/pebble && npx pebble orders sync
```

### `pebble version`

Prints the shop version and the git revision it was built from.
