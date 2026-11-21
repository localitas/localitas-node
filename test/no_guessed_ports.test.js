const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert');

const SRC = path.join(__dirname, '..', 'src');
const GUESSES = /8080|8090|localhost|127\.0\.0\.1|host\.docker\.internal/;

// Lines that may name a local address, each with why it is not a guess at core.
const ALLOWED = [
  // announce: the app tells core its own address on its own host; core's address is never guessed.
  { file: 'index.js', line: 'this._url = `http://localhost:${port}`;' },
  // automation: the names an automation's url may not hold, refused before sending (ownMachine); never called.
  { file: 'automation.js', line: "const OWN_NAMES = ['localhost', 'host.docker.internal'];" },
  { file: 'automation.js', line: "if (OWN_NAMES.includes(h) || h.endsWith('.localhost')) return true;" },
];

describe('package source', () => {
  it('guesses no host or port for core', () => {
    const found = [];
    for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.js'))) {
      fs.readFileSync(path.join(SRC, file), 'utf8').split('\n').forEach((text, i) => {
        if (!GUESSES.test(text)) return;
        if (ALLOWED.some((a) => a.file === file && text.trim() === a.line)) return;
        found.push(`${file}:${i + 1}: ${text.trim()}`);
      });
    }
    assert.deepStrictEqual(found, []);
  });
});
