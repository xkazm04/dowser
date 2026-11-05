// @ts-check
// tools/claude-bin.mjs: the eval tools start an npm-installed claude.cmd on Windows by running the shim's target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdShimTarget, resolveClaude, spawnClaude, which } from '../../../tools/claude-bin.mjs';
import { removeDir, tempDir } from './_fixture.mjs';

/** The cmd-shim npm writes for a global bin (as `npm i -g` leaves it in %APPDATA%\npm). @param {string} rel */
const npmShim = (rel) => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*`, '',
].join('\r\n');

test('cmdShimTarget: the script an npm cmd-shim launches, or nothing for another .cmd', () => {
  assert.equal(cmdShimTarget(npmShim('node_modules\\@anthropic-ai\\claude-code\\cli.js'), 'C:\\npm'),
    join('C:\\npm', 'node_modules\\@anthropic-ai\\claude-code\\cli.js'));
  assert.equal(cmdShimTarget('@"%~dp0bin\\claude.exe" %*\r\n', 'C:\\x'), join('C:\\x', 'bin\\claude.exe'));
  assert.equal(cmdShimTarget('@echo hello\r\n', 'C:\\x'), undefined);
});

test('resolveClaude: a Windows claude.cmd runs its target under this Node, an .exe as it is, elsewhere the name', () => {
  const dir = tempDir('claude-bin');
  try {
    const cli = join(dir, 'node_modules/@anthropic-ai/claude-code/cli.js');
    mkdirSync(join(dir, 'node_modules/@anthropic-ai/claude-code'), { recursive: true });
    // echoes its arguments, so the test sees exactly what the CLI would receive
    writeFileSync(cli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
    writeFileSync(join(dir, 'claude.cmd'), npmShim('node_modules\\@anthropic-ai\\claude-code\\cli.js'));
    const env = { platform: 'win32', path: dir, pathext: '.COM;.EXE;.BAT;.CMD' };
    assert.equal(which('claude', env), join(dir, 'claude.cmd'));
    const c = resolveClaude('claude', env);
    assert.deepEqual(c, { command: process.execPath, args: [cli], shell: false, resolved: join(dir, 'claude.cmd') });
    // a multi-line prompt with quotes and cmd.exe metacharacters arrives whole (a shell would cut or read it)
    const prompt = 'Scan this repo.\n- Run only "doc-drift" & report {"state":"skipped"} | <done>';
    const r = spawnClaude(['-p', prompt, '--output-format', 'json'], { encoding: 'utf8' }, c);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), ['-p', prompt, '--output-format', 'json']);

    // a shim whose target is gone falls back to the shell; a native .exe and other platforms spawn directly
    writeFileSync(join(dir, 'other.cmd'), npmShim('node_modules\\missing\\cli.js'));
    assert.equal(resolveClaude('other', env).shell, true);
    writeFileSync(join(dir, 'native.exe'), '');
    assert.deepEqual(resolveClaude('native', env), { command: join(dir, 'native.exe'), args: [], shell: false, resolved: join(dir, 'native.exe') });
    assert.deepEqual(resolveClaude('claude', { platform: 'linux', path: dir }), { command: 'claude', args: [], shell: false, resolved: 'claude' });
  } finally {
    removeDir(dir);
  }
});
