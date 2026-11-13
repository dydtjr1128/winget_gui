const assert = require('node:assert/strict');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

async function loadI18n() {
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '..', 'src', 'i18n.mjs')).href;
  return import(moduleUrl);
}

test('uses the system language option to pick the first supported system language', async () => {
  const { resolveLocalePreference } = await loadI18n();

  assert.equal(
    resolveLocalePreference('system', { languages: ['fr-FR', 'ko-KR', 'en-US'] }),
    'ko'
  );
});

test('falls back to English when the system language is not supported', async () => {
  const { resolveLocalePreference } = await loadI18n();

  assert.equal(resolveLocalePreference('system', { languages: ['fr-FR'] }), 'en');
});

test('honors explicit language preferences over the system language', async () => {
  const { resolveLocalePreference } = await loadI18n();

  assert.equal(resolveLocalePreference('ko', { languages: ['en-US'] }), 'ko');
  assert.equal(resolveLocalePreference('en', { languages: ['ko-KR'] }), 'en');
});

test('normalizes regional language tags to bundled UI locales', async () => {
  const { normalizeLocale } = await loadI18n();

  assert.equal(normalizeLocale('ko-KR'), 'ko');
  assert.equal(normalizeLocale('en-US'), 'en');
  assert.equal(normalizeLocale('zh-CN'), 'en');
});

test('provides the cached-list notice in both locales', async () => {
  const { createTranslator, formatDateTimeLabel } = await loadI18n();
  const time = formatDateTimeLabel(new Date(2026, 10, 13, 9, 58), 'en');

  assert.match(time, /Nov/);
  assert.match(createTranslator('en').t('alerts.cachedList', { time }), /^List from Nov/);
  assert.match(createTranslator('ko').t('alerts.cachedList', { time: 'X' }), /^X 기준 이전 목록/);
});

test('translates UI labels and interpolates counts', async () => {
  const { createTranslator } = await loadI18n();
  const { t } = createTranslator('en-US');

  assert.equal(t('language.system'), 'System language');
  assert.equal(
    t('alerts.countMismatch', { wingetCount: 12, displayedCount: 10 }),
    'winget reported 12, but the table shows 10.'
  );
});
