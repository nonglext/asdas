'use strict';

/*
 * Светлая тема однажды уже унаследовала токены от прежней тёмной базы:
 * --focus, --link, --text-danger, --text-positive и --text-warning остались
 * светлыми поверх светлого фона и давали 1.5–2.2:1. Текст ошибок был
 * нечитаем, а кольцо фокуса — невидимо.
 *
 * Тест считает реальный контраст прямо из theme.css, поэтому повторить ту же
 * ошибку молча уже не получится.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public/css/theme.css'), 'utf8');

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

function oklchToSrgb(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;

  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  ];

  return linear.map(v => {
    const encoded = v <= 0.0031308
      ? 12.92 * v
      : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;

    return Math.min(1, Math.max(0, encoded));
  });
}

function relativeLuminance([r, g, b]) {
  const f = v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/*
 * Берём последнее объявление токена внутри блока: именно оно и выигрывает
 * в каскаде, а значит именно его видит пользователь.
 */
function block(selector, marker) {
  let from = 0;

  // Один и тот же селектор встречается несколько раз (в том числе внутри
  // @media), поэтому нужный блок опознаём по содержимому, а не по позиции.
  for (;;) {
    const start = css.indexOf(selector, from);
    assert.notEqual(start, -1, `не найден блок ${selector}`);

    const open = css.indexOf('{', start);
    const end = css.indexOf('\n}', open);
    assert.ok(end > open, `не удалось прочитать блок ${selector}`);

    const body = css.slice(open, end);

    if (!marker || body.includes(marker)) return body;

    from = end;
  }
}

function token(scope, name) {
  const matches = [
    ...scope.matchAll(
      new RegExp(`--${name}:\\s*oklch\\(\\s*([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)`, 'g')
    )
  ];

  assert.ok(matches.length, `токен --${name} не найден или задан не в oklch()`);

  const [, l, c, h] = matches[matches.length - 1];
  return oklchToSrgb(Number(l) / 100, Number(c), Number(h));
}

const light = block(':root {', 'color-scheme: light');
const dark = block(':root[data-theme="gray"] {', 'color-scheme: dark');

test('светлая тема: семантические цвета читаются на своём фоне', () => {
  const bg = token(light, 'bg');
  const bg1 = token(light, 'bg1');

  const pairs = [
    ['text', bg, AA_TEXT],
    ['text2', bg, AA_TEXT],
    ['text3', bg, AA_TEXT],
    ['text-danger', bg1, AA_TEXT],
    ['text-positive', bg1, AA_TEXT],
    ['text-warning', bg1, AA_TEXT],
    ['text-brand', bg1, AA_TEXT],
    ['link', bg1, AA_TEXT],
    ['mention-fg', bg, AA_TEXT],
    ['focus', bg, AA_NON_TEXT]
  ];

  for (const [name, background, minimum] of pairs) {
    const value = contrast(token(light, name), background);

    assert.ok(
      value >= minimum,
      `--${name}: ${value.toFixed(2)}:1, нужно минимум ${minimum}:1`
    );
  }
});

test('тёмная тема: те же токены переопределены и тоже читаются', () => {
  const bg = token(dark, 'bg');
  const bg1 = token(dark, 'bg1');

  // Если тёмная тема перестанет переопределять любой из них, она унаследует
  // тёмное значение светлой темы — то есть повторит ту же ошибку зеркально.
  const pairs = [
    ['text', bg, AA_TEXT],
    ['text2', bg, AA_TEXT],
    ['text3', bg, AA_TEXT],
    ['text-danger', bg1, AA_TEXT],
    ['text-positive', bg1, AA_TEXT],
    ['text-warning', bg1, AA_TEXT],
    ['text-brand', bg1, AA_TEXT],
    ['link', bg1, AA_TEXT],
    ['mention-fg', bg, AA_TEXT],
    ['focus', bg, AA_NON_TEXT]
  ];

  for (const [name, background, minimum] of pairs) {
    const value = contrast(token(dark, name), background);

    assert.ok(
      value >= minimum,
      `gray --${name}: ${value.toFixed(2)}:1, нужно минимум ${minimum}:1`
    );
  }
});

test('режим повышенного контраста усиливает контраст, а не роняет его', () => {
  const start = css.indexOf('@media (prefers-contrast: more)');
  assert.notEqual(start, -1, 'блок prefers-contrast: more отсутствует');

  const scope = css.slice(start, css.indexOf('\n}\n', css.indexOf('\n  }', start)));

  const lightOverrides = scope.slice(0, scope.indexOf(':root[data-theme="gray"]'));
  const bg = token(light, 'bg');

  for (const name of ['text2', 'text3', 'text4']) {
    const boosted = contrast(token(lightOverrides, name), bg);
    const normal = contrast(token(light, name), bg);

    assert.ok(
      boosted >= normal,
      `--${name} в prefers-contrast: more даёт ${boosted.toFixed(2)}:1 ` +
      `против обычных ${normal.toFixed(2)}:1`
    );
  }
});
