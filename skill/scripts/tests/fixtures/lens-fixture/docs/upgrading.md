# Upgrading

## From 1.3 to 1.4

1.3 gets security fixes until 31 March 2027, so there is no rush; upgrade when your nightly jobs
can be changed.

On 1.3 the nightly cron pushes orders to accounting with:

```sh
0 2 * * * cd /srv/pebble && npx pebble orders sync
```

1.4 removed `pebble orders sync`. Before you upgrade, replace that line with the nightly report
and import its CSV into your accounting system:

```sh
0 2 * * * cd /srv/pebble && npx pebble report nightly --out /srv/reports
```

1.4 also lowers the cart limit to 20 items (`MAX_CART_ITEMS`). Set the variable if your shop
needs more.
