import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml } from './html-escape.js';

test('escapeHtml escapes every HTML-significant character', () => {
  assert.equal(escapeHtml(`<script>&"'`), '&lt;script&gt;&amp;&quot;&#39;');
});

test('escapeHtml leaves plain text untouched', () => {
  assert.equal(escapeHtml('SP-ABC'), 'SP-ABC');
});

test('escapeHtml coerces a non-string value first', () => {
  assert.equal(escapeHtml(123), '123');
});

test('escapeHtml neutralizes a stored-XSS-style callsign', () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const escaped = escapeHtml(malicious);
  assert.ok(!escaped.includes('<'));
  assert.ok(!escaped.includes('>'));
});
