import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 真实 pi 进程 + 本地协议 fixture：判定文本由 fixture 给出，观测面是 checks.jsonl / RPC 事件 / session 文件。
const extension = process.env.YSK_TEST_SOURCE ?? fileURLToPath(new URL('../extensions/you-should-know/index.ts', import.meta.url));
const HEADER = '这是侧 agent 的观察，先验证再改，判断错就直接说错。';

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'ysk-act-e2e-'));
  const agentDir = join(root, 'agent');
  const logDir = join(agentDir, 'you-should-know');
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, 'checks.jsonl');
  writeFileSync(logFile, '');
  writeFileSync(join(root, 'receipt.txt'), 'local fixture');
  const session = join(root, 'session.jsonl');
  const children = new Set();
  const state = {
    root, agentDir, logFile, session,
    outputs: [], steps: 25, holdAfter: undefined,
    sideRequests: 0, mainPayloads: [], events: [],
    entries: () => readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
    checks: () => state.entries().filter((entry) => entry.event === 'check'),
    async waitChecks(count) {
      const deadline = Date.now() + 20_000;
      while (state.checks().length < count) {
        if (Date.now() > deadline) throw new Error(`only ${state.checks().length}/${count} checks: ${readFileSync(logFile, 'utf8')}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    async waitFor(predicate, ms = 15_000) {
      const deadline = Date.now() + ms;
      while (!state.events.some(predicate)) {
        if (Date.now() > deadline) throw new Error('expected event did not arrive');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
  let injected;
  state.injected = new Promise((resolve) => { injected = resolve; });
  // act_injected 一进检查日志就放行被卡住的请求：steer 必须落进它之后重建的上下文。
  const poll = setInterval(() => {
    try { if (readFileSync(logFile, 'utf8').includes('act_injected')) { injected(); clearInterval(poll); } } catch {}
  }, 50);
  poll.unref?.();
  const respond = (response, delta, finish) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (value) => response.write(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [value] })}\n\n`);
    frame({ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null });
    frame({ index: 0, delta: {}, finish_reason: finish });
    response.end('data: [DONE]\n\n');
  };
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    const messages = payload.messages ?? payload.input;
    if (JSON.stringify(messages.at(-1)).includes('These are the last suggestions offered')) {
      const text = state.outputs[Math.min(state.sideRequests, state.outputs.length - 1)];
      state.sideRequests++;
      respond(response, { content: text }, 'stop');
      return;
    }
    state.mainPayloads.push(payload);
    const toolSteps = messages.filter((message) => message.role === 'tool').length;
    // turn_end(6) 在它自己的那轮响应完成后才触发，所以卡住的是再下一轮的请求：
    // 它被判定的直推放行后才重建上下文，steer 就一定进了后续请求。
    if (state.holdAfter !== undefined && toolSteps >= state.holdAfter) await Promise.race([state.injected, new Promise((resolve) => setTimeout(resolve, 8_000))]);
    if (toolSteps < state.steps) respond(response, { tool_calls: [{ index: 0, id: `read-${toolSteps}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: join(root, 'receipt.txt') }) } }] }, 'tool_calls');
    else respond(response, { content: 'Fixture complete.' }, 'stop');
  });
  server.on('upgrade', (_request, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  state.open = async (prompt) => {
    if (!server.listening) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { localfixture: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'local-only', models: [{ id: 'fixture', contextWindow: 128000, maxTokens: 1024 }] } } }));
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, YSK_DEBUG: '1' };
    delete env.PI_SUBAGENT_ACTIVITY_FILE; delete env.YSK_MODEL;
    const child = spawn('pi', ['--mode', 'rpc', '--offline', '--no-skills', '--no-context-files', '--no-extensions', '-e', extension, '--provider', 'localfixture', '--model', 'fixture', '--thinking', 'off', '--session', session], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], signal: AbortSignal.timeout(30_000) });
    children.add(child);
    let buffer = '', stderr = '';
    child.stderr.on('data', (data) => { stderr += data; });
    child.stdout.on('data', (data) => {
      buffer += data;
      for (;;) {
        const at = buffer.indexOf('\n'); if (at < 0) break;
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try { state.events.push(JSON.parse(line)); } catch { continue; }
      }
    });
    if (prompt) child.stdin.write(JSON.stringify({ id: 'run', type: 'prompt', message: prompt }) + '\n');
    return { child, stderr: () => stderr };
  };
  state.send = (record) => { [...children].at(-1).stdin.write(JSON.stringify(record) + '\n'); };
  state.getMessages = async () => {
    const child = [...children].at(-1);
    const id = 'get-' + Math.random().toString(36).slice(2);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('get_messages timed out')), 10_000);
      const onData = (data) => {
        for (const chunk of String(data).split('\n').filter(Boolean)) {
          let event; try { event = JSON.parse(chunk); } catch { continue; }
          if (event.type === 'response' && event.id === id) { clearTimeout(timer); child.stdout.off('data', onData); resolve(event.data); }
        }
      };
      child.stdout.on('data', onData);
      child.stdin.write(JSON.stringify({ id, type: 'get_messages' }) + '\n');
    });
  };
  state.stop = async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
      children.delete(child);
    }
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  };
  state.close = async () => { clearInterval(poll); await state.stop(); rmSync(root, { recursive: true, force: true }); };
  return state;
};

test('act: none stays in the human channel only', { timeout: 30_000 }, async () => {
  const f = fixture();
  try {
    f.outputs = ['learn: The fixture found a billing change.\ntag: Heads up\nevidence: receipt.txt\nact: none\nurgency: later\nexplain: The price changed.'];
    f.steps = 7;
    await f.open('Read the fixture file seven times, then finish.');
    await f.waitChecks(1);
    await f.waitFor((event) => event.type === 'agent_settled');
    assert.equal(f.checks()[0].outcome, 'shown');
    assert.equal(f.entries().filter((entry) => entry.event === 'act_injected' || entry.event === 'act_dropped').length, 0);
    const notices = f.events.filter((event) => event.method === 'notify' && event.message?.includes('[ysk:'));
    assert.equal(notices.length, 1, 'the human channel keeps working');
    assert.ok(!readFileSync(f.session, 'utf8').includes('actDelivered'));
  } finally { await f.close(); }
});

test('act with urgency now steers into the running run with the fixed declaration', { timeout: 30_000 }, async () => {
  const f = fixture();
  try {
    f.outputs = ['learn: The fixture found a routing bug.\ntag: Heads up\nevidence: receipt.txt\nact: Fix the route table in router.ts.\nurgency: now\nexplain: The route table drops every second request.'];
    f.steps = 9;
    f.holdAfter = 7;
    await f.open('Read the fixture file nine times, then finish.');
    await f.waitChecks(1);
    const injected = f.entries().find((entry) => entry.event === 'act_injected');
    assert.ok(injected, JSON.stringify(f.entries()));
    assert.equal(injected.deliverAs, 'steer');
    assert.equal(injected.urgency, 'now');
    assert.equal(injected.line, 'The fixture found a routing bug.');
    await f.waitFor((event) => event.type === 'agent_settled');
    // 人的通道（notify）与 agent 的通道（注入）都不得缺失。
    assert.equal(f.events.filter((event) => event.method === 'notify' && event.message?.includes('[ysk:')).length, 1);
    const delivered = f.events.find((event) => event.type === 'message_end' && event.message?.customType === 'you-should-know');
    assert.ok(delivered, 'the injection is a custom message in the session stream');
    assert.ok(delivered.message.content.includes(HEADER), 'the injection text opens with the fixed declaration');
    assert.equal(delivered.message.details.actDelivered, true);
    const session = readFileSync(f.session, 'utf8');
    assert.ok(session.includes('actDelivered'), 'the injection is in the session record');
    assert.ok(f.mainPayloads.some((payload) => JSON.stringify(payload.messages ?? payload.input).includes(HEADER)), 'steer really reached a later request');
  } finally { await f.close(); }
});

test('act with urgency later persists without waking the agent', { timeout: 30_000 }, async () => {
  const f = fixture();
  try {
    f.outputs = ['learn: The fixture found a slow query.\ntag: You should know\nevidence: receipt.txt\nact: Add an index on orders.created_at.\nurgency: later\nexplain: The query scans the whole table.'];
    f.steps = 7;
    await f.open('Read the fixture file seven times, then finish.');
    await f.waitChecks(1);
    const delivered = f.waitFor((event) => event.type === 'message_end' && event.message?.customType === 'you-should-know');
    const injected = f.entries().find((entry) => entry.event === 'act_injected');
    assert.ok(injected, JSON.stringify(f.entries()));
    assert.equal(injected.deliverAs, 'append');
    await delivered;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    // 不唤醒 = 不新起一个 run。注意：本轮结束时会追加进会话记录，所以后续请求仍能看到它，
    // 这是「落盘」的应有语义，不要为了「证明没注入」而去断言 payload 里不含声明头——那个断言在正确实现下也会失败。
    assert.equal(f.events.filter((event) => event.type === 'agent_start').length, 1, 'the persisted act must not start a new run');
    await f.stop();
    await f.open(); // 重启后消息仍在会话记录里
    const { messages } = await f.getMessages();
    assert.equal(messages.filter((message) => message.role === 'custom' && message.customType === 'you-should-know' && message.content.includes(HEADER)).length, 1);
  } finally { await f.close(); }
});

test('per-run cap drops the third act and a repeated line drops its act, both audited', { timeout: 60_000 }, async () => {
  const f = fixture();
  try {
    f.outputs = [
      'learn: The fixture found problem one.\ntag: Heads up\nevidence: receipt.txt\nact: Fix problem one.\nurgency: now\nexplain: Problem one breaks the build.',
      'learn: The fixture found problem one.\ntag: Heads up\nevidence: receipt.txt\nact: Fix problem one.\nurgency: now\nexplain: Problem one breaks the build.',
      'learn: The fixture found problem two.\ntag: Heads up\nevidence: receipt.txt\nact: Fix problem two.\nurgency: later\nexplain: Problem two wastes time.',
      'learn: The fixture found problem three.\ntag: Heads up\nevidence: receipt.txt\nact: Fix problem three.\nurgency: now\nexplain: Problem three loses data.',
      'learn: The fixture found problem four.\ntag: Heads up\nevidence: receipt.txt\nact: Fix problem four.\nurgency: now\nexplain: Problem four leaks memory.',
    ];
    f.steps = 25;
    await f.open('Read the fixture file twenty-five times, then finish.');
    await f.waitChecks(4);
    const outcomes = f.checks().map((check) => check.outcome);
    assert.deepEqual(outcomes, ['shown', 'deduped', 'shown', 'shown'], JSON.stringify(outcomes));
    const injected = f.entries().filter((entry) => entry.event === 'act_injected');
    assert.equal(injected.length, 2, 'two acts per run');
    assert.deepEqual(injected.map((entry) => entry.deliverAs), ['steer', 'append']);
    const dropped = f.entries().filter((entry) => entry.event === 'act_dropped');
    assert.deepEqual(dropped.map((entry) => entry.reason), ['dedup', 'cap']);
    assert.equal(dropped[0].line, 'The fixture found problem one.');
    assert.equal(dropped[1].line, 'The fixture found problem three.');
    // 先写 state.seen 再发送：被丢弃的 act 也已经进 seen，重跑不会重发。
    const seen = JSON.parse(readFileSync(join(f.agentDir, 'you-should-know/state.json'), 'utf8')).seen;
    for (const line of ['The fixture found problem one.', 'The fixture found problem two.', 'The fixture found problem three.']) assert.ok(seen.includes(line), `${line} must be in state.seen`);
    // run 边界：下一个 run 开始时计数归零，新 run 的 act 不再被 cap。
    f.steps = 32;
    f.send({ id: 'run2', type: 'prompt', message: 'Read the fixture file seven more times, then finish.' });
    await f.waitChecks(5);
    const acts = f.entries().filter((entry) => entry.event === 'act_injected');
    assert.equal(acts.length, 3, 'the next run may act again');
    assert.equal(acts[2].line, 'The fixture found problem four.');
  } finally { await f.close(); }
});
