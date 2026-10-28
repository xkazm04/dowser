# Pebble Shop

A small web shop for handmade goods: a product catalogue with search, a cart, a two-step
checkout (delivery address, then card payment through StonePay) and the monthly Pebble Box
subscription. Shop owners self-host it; releases are published on the project's release page.

## Install

```sh
npm ci
npm start
```

The shop listens on port 8080 by default. Set `PORT` to change it.

## Configure

Every setting is an environment variable. See [docs/configuration.md](docs/configuration.md).

## Admin CLI

The `pebble` command handles receipts, bulk price updates, packing slips and the nightly report. See
[docs/cli.md](docs/cli.md).

## API

The storefront talks to a small JSON API. See [docs/api.md](docs/api.md).

## Tests

```sh
npm test
```

## Development

`npm run seed -- --products 20` fills a local database with demo products. Upgrading an
existing shop: see [docs/upgrading.md](docs/upgrading.md).
