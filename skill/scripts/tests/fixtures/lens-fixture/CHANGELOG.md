# Changelog

## 1.4.0

- Changed: a cart holds at most 20 items.
- Removed: the `pebble orders sync` command. The nightly report (`pebble report nightly`)
  replaces it. See [docs/upgrading.md](docs/upgrading.md).
- Added: `pebble slips print` writes packing slips with the carrier's tracking link.
- Added: `pebble report nightly --since <date>` reports every order since a date.

## 1.3.0

- Added: Pebble Box monthly subscription.
- Added: Save for later - signed-in customers keep products aside (`/wishlist`).
- Added: `pebble orders sync` pushes new orders to the accounting system.

## 1.2.0

- Added: product search with suggestions.
