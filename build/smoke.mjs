/**
 * 冒烟测试：启动打包后的 exe，验证接口可用性与安全约束。
 *
 * 用法：node build/smoke.mjs [exe路径]
 * 退出码 0 表示全部通过。
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = process.argv[2] || path.join(ROOT, 'dist', 'REA-Panel.exe');
const PORT = Number(process.env.SMOKE_PORT || 7911);
const BASE = `http://127.0.0.1:${PORT}`;

if (!fs.existsSync(EXE)) {
  console.error('找不到 exe：' + EXE + '\n请先执行 node build/build-exe.mjs');
  process.exit(1);
}

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log((passed ? '  ✓ ' : '  ✗ ') + name + (detail ? '  — ' + detail : ''));
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }).on('close', resolve);
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ }
      resolve();
    }
  });
}

async function waitReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/api/status', { signal: AbortSignal.timeout(1500) });
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

/** 底层请求：fetch 不允许覆盖 Host 头，测 DNS rebinding 防护必须走 http.request。 */
function rawStatus(pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method: 'GET', headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const child = spawn(EXE, ['--no-open'], {
  env: { ...process.env, REA_PANEL_PORT: String(PORT) },
  stdio: 'ignore',
  windowsHide: true,
});

console.log('\n冒烟测试：' + path.basename(EXE) + '  (端口 ' + PORT + ')\n');

let exitCode = 1;
try {
  const ready = await waitReady(20000);
  check('服务在 20 秒内就绪', ready);
  if (!ready) throw new Error('服务未就绪');

  const status = await (await fetch(BASE + '/api/status')).json();
  check('/api/status 返回版本', Boolean(status.cli && status.cli.version), 'cli=' + (status.cli && status.cli.version));
  check('/api/status 含 DSH 字段', Boolean(status.dsh), 'detected=' + (status.dsh && status.dsh.detected));

  const doctor = await (await fetch(BASE + '/api/doctor')).json();
  check('/api/doctor 可解析', typeof doctor.ok === 'boolean');

  const release = await (await fetch(BASE + '/api/release')).json();
  check('/api/release 有当前版本', Boolean(release.current), 'current=' + release.current);

  const html = await (await fetch(BASE + '/')).text();
  check('首页返回 HTML', html.includes('REA 状态面板'));

  const updateState = await (await fetch(BASE + '/api/update')).json();
  check('GET /api/update 返回任务状态', typeof updateState.running === 'boolean');

  const dshRepair = await (await fetch(BASE + '/api/repair-dsh')).json();
  check('GET /api/repair-dsh 返回任务状态', typeof dshRepair.running === 'boolean');

  // 安全断言：携带外部 Origin 的写请求必须被拒绝
  const badOrigin = await fetch(BASE + '/api/repair-mcp', {
    method: 'POST',
    headers: { origin: 'https://evil.example' },
  });
  check('跨站写请求被拒绝(403)', badOrigin.status === 403, 'status=' + badOrigin.status);

  // 安全断言：伪造 Host（DNS rebinding 场景）必须被拒绝
  const badHostStatus = await rawStatus('/api/status', { host: 'evil.example' });
  check('非回环 Host 被拒绝(403)', badHostStatus === 403, 'status=' + badHostStatus);

  const failed = results.filter((r) => !r.passed);
  console.log('\n结果：' + (results.length - failed.length) + '/' + results.length + ' 项通过');
  exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error('\n执行中断：' + (e && e.message ? e.message : e));
  exitCode = 1;
} finally {
  await killTree(child.pid);
  const logFile = path.join(process.env.LOCALAPPDATA || '', 'REA-Panel', 'panel.log');
  if (fs.existsSync(logFile)) {
    console.log('运行日志：' + logFile);
  }
}

process.exit(exitCode);
