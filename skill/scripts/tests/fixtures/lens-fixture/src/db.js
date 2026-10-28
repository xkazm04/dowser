'use strict';
// One SQLite file holds the catalogue, carts and orders.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const db = new DatabaseSync(process.env.PEBBLE_DB || path.join(__dirname, '..', 'data', 'pebble.db'));

/** Runs a read query and returns every row. */
function query(sql, params = []) {
  return db.prepare(sql).all(...params);
}

/** Runs a write and returns the change count. */
function run(sql, params = []) {
  return db.prepare(sql).run(...params).changes;
}

module.exports = { query, run };
