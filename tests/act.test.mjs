import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';

// 与 tests/notes.test.mjs 同款轻量接缝：桩掉 TUI/宿主依赖，直接调用扩展模块的纯函数与处理器。
const home = mkdtempSync(join(tmpdir(), 'ysk-act-test-'));
after(() => rmSync(home, { recursive: true, force: true }));
const data = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
// 宽度函数桩：ASCII/ANSI 输入下与 pi-tui 真实现同宽（扩展实现禁止用 .length，这里量的是可见宽度）。
const widthStub = `
  export const visibleWidth = (str) => str.replace(/\\x1b\\[[0-9;]*m/g, '').length;
  export const truncateToWidth = (text, maxWidth, ellipsis = '...', pad = false) => {
    const width = visibleWidth(text);
    if (maxWidth <= 0) return '';
    if (width <= maxWidth) return pad ? text + ' '.repeat(maxWidth - width) : text;
    const ew = visibleWidth(ellipsis);
    if (ew >= maxWidth) return ellipsis.slice(0, maxWidth);
    return text.slice(0, maxWidth - ew) + ellipsis;
  };
`;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'node:os') return { url: data(`export const homedir = () => ${JSON.stringify(home)}`), shortCircuit: true };
  if (specifier === '@earendil-works/pi-coding-agent') return { url: data('export class DynamicBorder {}; export const getMarkdownTheme = () => ({})'), shortCircuit: true };
  if (specifier === '@earendil-works/pi-tui') return { url: data(`export class Container {}; export class Markdown {}; export class Text {}; export const matchesKey = () => false;${widthStub}`), shortCircuit: true };
  return next(specifier, context);
}});
const { default: extension, parse, decideActRoute, actMessage, drawerLine } = await import(process.env.YSK_TEST_SOURCE ?? '../extensions/you-should-know/index.ts');

// ---- (a) 解析器补 act/urgency ----

test('parse reads act and urgency before explain', () => {
  const p = parse('learn: The cache misses on every request.\ntag: Heads up\nevidence: src/cache.ts:12\nact: Add the cache warmup in src/cache.ts.\nurgency: now\nexplain: Why it matters.');
  assert.equal(p.kind, 'line');
  assert.equal(p.line, 'The cache misses on every request.');
  assert.equal(p.tag, 'Heads up');
  assert.equal(p.evidence, 'src/cache.ts:12');
  assert.equal(p.act, 'Add the cache warmup in src/cache.ts.');
  assert.equal(p.urgency, 'now');
  assert.equal(p.explanation, 'Why it matters.');
});

test('act: none and a missing act both parse to no act', () => {
  assert.equal(parse('learn: A thing.\ntag: Heads up\nact: none\nurgency: later\nexplain: Why.').act, undefined);
  assert.equal(parse('learn: A thing.\ntag: Heads up\nexplain: Why.').act, undefined);
});

test('a missing or invalid urgency falls back to later and warns only when act is set', () => {
  const warnings = [];
  const warn = (entry) => warnings.push(entry);
  assert.equal(parse('learn: A thing.\nact: Fix it.\n', warn).urgency, 'later');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].event, 'act_urgency_defaulted');
  assert.equal(parse('learn: A thing.\nact: Fix it.\nurgency: soon\n', warn).urgency, 'later');
  assert.equal(warnings.length, 2);
  assert.equal(warnings[1].reason, 'invalid');
  assert.equal(parse('learn: A thing.\nact: Fix it.\nurgency: now\n', warn).urgency, 'now');
  assert.equal(parse('learn: A thing.\nact: none\n', warn).urgency, 'later');
  assert.equal(parse('learn: A thing.\ntag: Heads up\n', warn).urgency, 'later');
  assert.equal(warnings.length, 2);
});

test('act and urgency after explain stay part of the explanation', () => {
  const p = parse('learn: A thing.\ntag: Heads up\nexplain: Why it matters.\nact: Sneaky instruction.\nurgency: now');
  assert.equal(p.act, undefined);
  assert.equal(p.urgency, 'later');
  assert.match(p.explanation, /act: Sneaky instruction\./);
  assert.match(p.explanation, /urgency: now/);
});

test('the old learn/tag/evidence/explain format without act still parses', () => {
  const p = parse('learn: The fixture found a billing change.\ntag: Heads up\nevidence: receipt.txt\nexplain: The price changed.');
  assert.equal(p.kind, 'line');
  assert.equal(p.act, undefined);
  assert.equal(p.urgency, 'later');
  assert.equal(p.evidence, 'receipt.txt');
  assert.equal(p.explanation, 'The price changed.');
});

// ---- (b) 路由决策纯函数 + 护栏 ----

test('decideActRoute routes on act and urgency', () => {
  assert.equal(decideActRoute({ line: 'A thing.', urgency: 'now' }, 0, []), 'skip'); // act 缺失 → 只进人可见通道
  assert.equal(decideActRoute({ line: 'A thing.', act: 'Fix it.', urgency: 'now' }, 0, []), 'steer');
  assert.equal(decideActRoute({ line: 'A thing.', act: 'Fix it.', urgency: 'later' }, 0, []), 'persist');
  assert.equal(decideActRoute({ line: 'A thing.', act: 'Fix it.' }, 0, []), 'persist'); // urgency 缺失 → later
});

test('decideActRoute drops a repeated line and anything past two sends per run', () => {
  assert.equal(decideActRoute({ line: 'The same note.', act: 'Fix it.', urgency: 'now' }, 0, ['the SAME note!']), 'drop'); // 去重先行
  assert.equal(decideActRoute({ line: 'New note.', act: 'Fix it.', urgency: 'now' }, 2, []), 'drop_cap'); // 每 run 上限 2 条
  assert.equal(decideActRoute({ line: 'New note.', act: 'Fix it.', urgency: 'later' }, 1, []), 'persist');
  assert.equal(decideActRoute({ line: 'New note.', act: 'Fix it.', urgency: 'now' }, 0, ['other line']), 'steer');
});

// ---- (c) 注入文本拼装 ----

test('actMessage opens with the fixed declaration and keeps the order', () => {
  const text = actMessage('Add the cache warmup in src/cache.ts.', 'Heads up', 'The cache misses on every request.', 'src/cache.ts:12');
  const lines = text.split('\n');
  assert.equal(lines[0], '这是侧 agent 的观察，先验证再改，判断错就直接说错。');
  assert.deepEqual(lines, [
    '这是侧 agent 的观察，先验证再改，判断错就直接说错。',
    '',
    'act: Add the cache warmup in src/cache.ts.',
    '',
    'Heads up · The cache misses on every request.',
    'Evidence: src/cache.ts:12',
  ]);
});

test('actMessage drops the Evidence line when evidence is missing', () => {
  const text = actMessage('Fix it.', 'You should know', 'A thing.');
  assert.equal(text.split('\n').length, 5);
  assert.match(text, /\nYou should know · A thing\.$/);
  assert.ok(!text.includes('Evidence:'));
});

// ---- (d) 抽屉单行渲染 ----

const theme = { fg: (_color, text) => text, bold: (text) => text };
const vw = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
const note = (line, extra = {}) => ({ id: 'n-' + line, line, tag: 'You should know', shownAt: 0, promptsSurvived: 0, ...extra });

test('drawerLine renders the newest note as exactly one line with mark, tag, from and line', () => {
  assert.equal(drawerLine([note('Older note.'), note('Newer note.', { from: 'child' })], 80, theme), '✦ You should know (child) · Newer note. +1');
  assert.equal(drawerLine([note('Only one.', { from: 'child' })], 80, theme), '✦ You should know (child) · Only one.');
});

test('drawerLine counts the hidden notes at the end and stays silent for one note', () => {
  const four = [note('a.'), note('b.'), note('c.'), note('d.')];
  assert.ok(drawerLine(four, 80, theme).endsWith(' +3'));
  assert.ok(!drawerLine([note('a.')], 80, theme).includes(' +'));
});

test('drawerLine truncates the body to the width and reserves the +N suffix', () => {
  const line = drawerLine([note('Older note.'), note('Newer note with a very long line that needs truncation.')], 30, theme);
  assert.equal(vw(line), 30);
  assert.ok(line.endsWith(' +1'));
  assert.ok(line.includes('...'));
  assert.ok(!line.includes('\n'));
});

test('drawerLine is one line for any note count, text or width', () => {
  for (const width of [1, 4, 10, 200]) {
    for (const notes of [[note('two\nlines')], [note('a'), note('b'), note('c')], [note('x'.repeat(500))]]) {
      const line = drawerLine(notes, width, theme);
      assert.ok(!line.includes('\n'));
      assert.ok(vw(line) <= width, `width ${width} exceeded: ${vw(line)}`);
    }
  }
  assert.ok(drawerLine([note('two\nlines')], 80, theme).includes('two lines'));
});

// ---- (d) 抽屉交互：展开菜单、alt+x、组件契约 ----

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

function open(session, seedNotes) {
  const handlers = new Map();
  const shortcuts = new Map();
  const selects = [];
  const answers = [];
  let widget;
  extension({
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (_, value) => { open.command = value.handler; },
    registerShortcut: (keys, value) => shortcuts.set(keys, value.handler),
    sendMessage() {}, sendUserMessage() {},
  });
  const ctx = {
    mode: 'tui', hasUI: true, isIdle: () => true,
    sessionManager: { getSessionDir: () => home, getSessionId: () => session },
    ui: {
      notify: () => {},
      select: async (title, options) => { selects.push({ title, options }); return answers.shift(); },
      setWidget: (_key, content) => { widget = content; },
    },
  };
  if (seedNotes) {
    const dir = join(home, 'artifacts', session);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'you-should-know.json'), JSON.stringify({ notes: seedNotes, answered: [] }));
  }
  handlers.get('session_start')({}, ctx);
  return {
    ctx, selects, answers, shortcuts,
    widget: () => widget,
    command: (text) => open.command(text ?? '', ctx),
    saved: () => JSON.parse(readFileSync(join(home, 'artifacts', session, 'you-should-know.json'), 'utf8')),
    close: () => handlers.get('session_shutdown')({}, ctx),
  };
}
const seeded = (session, lines) => open(session, lines.map((line, i) => ({ id: `n${i}`, line, tag: 'You should know', shownAt: 0, promptsSurvived: 0 })));

test('with several pending notes ysk lists all of them, newest first, and acts on the picked one', async () => {
  const client = seeded('menu', ['Older note.', 'Newer note.']);
  client.answers.push('You should know · Newer note.', '0 Dismiss');
  await client.command();
  assert.deepEqual(client.selects[0].options, ['You should know · Newer note.', 'You should know · Older note.']);
  assert.deepEqual(client.selects[1].options, ['1 Learn more', '2 Knew this already', '3 Chat in main session', '0 Dismiss']);
  assert.deepEqual(client.saved().notes.map((n) => n.line), ['Older note.']); // 点开哪条就处理哪条
  client.close();
});

test('one pending note goes straight to the action menu', async () => {
  const client = seeded('single', ['Only one.']);
  client.answers.push('0 Dismiss');
  await client.command();
  assert.equal(client.selects.length, 1);
  assert.deepEqual(client.selects[0].options, ['1 Learn more', '2 Knew this already', '3 Chat in main session', '0 Dismiss']);
  assert.ok(existsSync(join(home, 'artifacts', 'single', 'you-should-know.json')));
  assert.deepEqual(client.saved().notes, []);
  client.close();
});

test('alt+x closes the note the drawer shows (the newest) with no menu', async () => {
  const client = seeded('quick', ['Older note.', 'Newer note.']);
  client.shortcuts.get('alt+x')(client.ctx);
  assert.equal(client.selects.length, 0);
  assert.deepEqual(client.saved().notes.map((n) => n.line), ['Older note.']);
  client.close();
});

test('the drawer widget renders one single line for any backlog', async () => {
  const client = seeded('widget', ['a.', 'b.', 'c.']);
  const component = client.widget()(undefined, theme);
  assert.equal(typeof component.render, 'function');
  assert.equal(typeof component.invalidate, 'function');
  const lines = component.render(24);
  assert.equal(lines.length, 1);
  assert.equal(vw(lines[0]), 24);
  assert.ok(lines[0].endsWith(' +2'));
  client.close();
});
