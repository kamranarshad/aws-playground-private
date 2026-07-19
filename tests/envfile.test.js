const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const envfile = require('../server/envfile');

function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awsplay-envfile-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('parse handles values, quotes, export, comments, blanks, CRLF', () => {
  const text = [
    '# comment line',
    '',
    'PLAIN=value',
    'SPACED = padded value ',
    'export EXPORTED=yes',
    'DQ="double quoted"',
    "SQ='single quoted'",
    'EMPTY=',
    'EQ_IN_VALUE=a=b=c',
    'CRLF=windows\r',
    'HASH_IN_VALUE=abc#notcomment',
  ].join('\n');
  assert.deepStrictEqual(envfile.parse(text), {
    PLAIN: 'value',
    SPACED: 'padded value',
    EXPORTED: 'yes',
    DQ: 'double quoted',
    SQ: 'single quoted',
    EMPTY: '',
    EQ_IN_VALUE: 'a=b=c',
    CRLF: 'windows',
    HASH_IN_VALUE: 'abc#notcomment',
  });
});

test('parse skips invalid lines and bad keys', () => {
  const text = [
    'no_equals_sign',
    '1BAD=starts with digit',
    'BAD-KEY=hyphen',
    'GOOD=1',
    '=nokey',
  ].join('\n');
  assert.deepStrictEqual(envfile.parse(text), { GOOD: '1' });
});

test('resolve auto loads .env when present, {} when absent', () => {
  const dir = tmpProject({ '.env': 'FROM_FILE=1' });
  assert.deepStrictEqual(envfile.resolve(dir, 'auto'), { FROM_FILE: '1' });
  const empty = tmpProject({});
  assert.deepStrictEqual(envfile.resolve(empty, 'auto'), {});
});

test('resolve none loads nothing even when .env exists', () => {
  const dir = tmpProject({ '.env': 'FROM_FILE=1' });
  assert.deepStrictEqual(envfile.resolve(dir, 'none'), {});
});

test('resolve specific file; missing file is {}', () => {
  const dir = tmpProject({ '.env': 'A=base', '.env.local': 'A=local' });
  assert.deepStrictEqual(envfile.resolve(dir, '.env.local'), { A: 'local' });
  assert.deepStrictEqual(envfile.resolve(dir, '.env.production'), {});
});

test('resolve rejects traversal and non-envfile names', () => {
  const dir = tmpProject({ '.env': 'A=1', 'notes.txt': 'B=2' });
  assert.deepStrictEqual(envfile.resolve(dir, '../.env'), {});
  assert.deepStrictEqual(envfile.resolve(dir, '..\\.env'), {});
  assert.deepStrictEqual(envfile.resolve(dir, 'notes.txt'), {});
  assert.deepStrictEqual(envfile.resolve(dir, '/etc/passwd'), {});
  assert.deepStrictEqual(envfile.resolve(dir, ''), {});
  // absent setting means auto: .env exists here, so it loads
  assert.deepStrictEqual(envfile.resolve(dir, undefined), { A: '1' });
});

test('list returns sorted .env* files only', () => {
  const dir = tmpProject({
    '.env': '', '.env.local': '', '.envrc': '', 'app.py': '', '.environment': '',
  });
  fs.mkdirSync(path.join(dir, '.env.d'));
  assert.deepStrictEqual(envfile.list(dir), ['.env', '.env.local', '.environment', '.envrc']);
});

test('list is empty for unreadable dir', () => {
  assert.deepStrictEqual(envfile.list('/no/such/dir'), []);
});
