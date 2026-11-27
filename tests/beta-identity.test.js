'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('manifest exposes a distinct experimental identity without reusing stable id', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  assert.equal(manifest.id, 'cinemabox-beta');
  assert.equal(manifest.name, 'CinemaBox Beta');
  assert.match(manifest.version, /-beta\./);
  assert.equal(manifest.scrapers.length, 1);
  assert.equal(manifest.scrapers[0].id, 'cinemabox-beta');
  assert.equal(manifest.scrapers[0].name, 'CinemaBox Beta');
  assert.equal(manifest.scrapers[0].version, manifest.version);
});

test('package metadata is explicitly marked as beta', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'cinemabox-beta-nuvio-plugin');
  assert.match(pkg.version, /-beta\./);
});
