/**
 * REA 状态面板 — 本地服务（CommonJS 版）
 *
 * 同时支持两种运行形态：
 *   1. 直接运行：node server.cjs —— 前端文件从 ui/ 目录读取
 *   2. 打包为单文件 exe（Node SEA）—— 前端文件从 exe 内嵌资源读取
 *
 * 之所以是 CommonJS：Node 22 的 SEA（单可执行文件）只接受 CommonJS 入口，
 * 且不支持顶层 await，因此启动逻辑收进 main()。
 *
 * 接口：
 *   GET /api/status   本地快速状态（CLI、MCP 接入、技能包、Node）      ~200ms
 *   GET /api/doctor   官方 doctor 明细（分析引擎、Node 权威版本）      ~3s（30s 缓存）
 *   GET /api/release  REA 是否有新版本（npm 主源 + GitHub 增强源）    ~3-8s（60s 缓存）
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');

const HOME = os.homedir();
const WB_DIR = path.join(HOME, '.workbuddy');
const PORT_START = Number(process.env.REA_PANEL_PORT || 7755);
const NO_OPEN = process.argv.includes('--no-open');

const NODE_RANGE_TEXT = '^22.23.4 || ^24.22.1 || >=26.12.1';
const NPM_LATEST = 'https://registry.npmjs.org/rea-agents/latest';
const GH_LATEST = 'https://api.github.com/repos/morluto/rea/releases/latest';

/* ------------------------------------------------------------------ */
/* 前端资源：SEA 内嵌优先，回退磁盘                                      */
/* ------------------------------------------------------------------ */

const ASSET_NAMES = ['index.html', 'style.css', 'app.js'];

function readAsset(name) {
  try {
    const sea = require('node:sea');
    if (typeof sea.isSea === 'function' && sea.isSea()) {
      return sea.getAsset(name, 'utf8');
    }
  } catch {
    /* 非 SEA 环境没有 node:sea，走磁盘 */
  }
  try {
    return fs.readFileSync(path.join(__dirname, 'ui', name), 'utf8');
  } catch {
    return null;
  }
}

const ASSETS = new Map();
for (const name of ASSET_NAMES) {
  const text = readAsset(name);
  if (text !== null) ASSETS.set(name, text);
}

/* ------------------------------------------------------------------ */
/* 定位 REA                                                            */
/* ------------------------------------------------------------------ */

function findRea() {
  const bases = [];

  try {
    const verFile = path.join(WB_DIR, 'binaries', 'node', 'versions', 'current');
    const ver = fs.readFileSync(verFile, 'utf8').trim();
    if (ver) bases.push(path.join(WB_DIR, 'binaries', 'node', 'versions', ver));
  } catch {
    /* 指针文件不存在时跳过 */
  }

  bases.push(path.dirname(process.execPath));
  bases.push(path.join(HOME, '.node24'));
  if (process.env.APPDATA) bases.push(path.join(process.env.APPDATA, 'npm'));

  // 同一台机器可能存在多份安装（不同 Node 版本各一份），取版本最高的那份
  const found = [];
  for (const base of bases) {
    const exe = process.platform === 'win32'
      ? path.join(base, 'node.exe')
      : path.join(base, 'bin', 'node');
    const pkgRoot = path.join(base, 'node_modules', 'rea-agents');
    const script = path.join(pkgRoot, 'scripts', 'rea.mjs');
    if (!fs.existsSync(exe) || !fs.existsSync(script)) continue;

    let version = null;
    try {
      version = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version;
    } catch {
      /* 版本读不到不影响可用性判断 */
    }
    found.push({ exe, scriptArgs: [script], pkgPath: pkgRoot, version });
  }

  if (found.length === 0) return null;
  found.sort((a, b) => compareVersion(b.version, a.version));
  return found[0];
}

function runRea(rea, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      rea.exe,
      [...rea.scriptArgs, ...args],
      { timeout: timeoutMs || 20000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          failed: Boolean(err),
          killed: Boolean(err && err.killed),
          code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          stdout: stdout || '',
          stderr: stderr || '',
        });
      },
    );
  });
}

/* ------------------------------------------------------------------ */
/* 版本工具                                                            */
/* ------------------------------------------------------------------ */

function parseVersion(raw) {
  if (!raw) return null;
  const m = String(raw).trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function compareVersion(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  return (pa.major - pb.major) || (pa.minor - pb.minor) || (pa.patch - pb.patch);
}

function isNodeCompliant(version) {
  const v = parseVersion(version);
  if (!v) return false;
  if (v.major === 22) return v.minor > 23 || (v.minor === 23 && v.patch >= 4);
  if (v.major === 24) return v.minor > 22 || (v.minor === 22 && v.patch >= 1);
  if (v.major === 26) return v.minor > 12 || (v.minor === 12 && v.patch >= 1);
  if (v.major > 26) return true;
  return false;
}

/**
 * 从 rea 所用 node 的目录名（如 22.22.2-6）推断 node 版本。
 * 目录名不含版本号时（如 ~/.node24）返回 null，交由 doctor 给出权威版本，
 * 避免用错误版本号误报「不合规」。
 */
function nodeVersionFromRea(rea) {
  if (!rea) return null;
  const dir = path.basename(path.dirname(rea.exe));
  const m = dir.match(/^(\d+\.\d+\.\d+)/);
  if (m) return m[1];
  // 与当前进程同一个可执行文件时可直接采信
  try {
    if (path.resolve(rea.exe) === path.resolve(process.execPath)) {
      return process.version.replace(/^v/, '');
    }
  } catch {
    /* 路径解析失败时按未知处理 */
  }
  return null;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function fetchJson(url, timeoutMs, headers) {
  const res = await fetch(url, {
    headers: Object.assign({ 'user-agent': 'rea-status-panel' }, headers || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/* ------------------------------------------------------------------ */
/* /api/status                                                         */
/* ------------------------------------------------------------------ */

/** 从 mcp 注册的脚本路径反推该注册使用的是哪一份 rea-agents 及版本。 */
function reaVersionFromScript(scriptPath) {
  if (!scriptPath) return null;
  const needle = path.sep + 'rea-agents' + path.sep;
  const idx = String(scriptPath).lastIndexOf(needle);
  if (idx < 0) return null;
  const root = String(scriptPath).slice(0, idx + needle.length - 1);
  const pkg = readJson(path.join(root, 'package.json'));
  return pkg && pkg.version ? pkg.version : null;
}

/* ------------------------------------------------------------------ */
/* DeepSeek Harness                                                    */
/* ------------------------------------------------------------------ */

/** 在 cordis 补丁里找出 id: rea-mcp 那一条的 command 与 args。 */
function parseDshPatch(text) {
  const lines = String(text).split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*-\s*id:\s*rea-mcp\s*$/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  const unquote = (s) => s.replace(/^["']|["']$/g, '');
  let command = null;
  const args = [];
  let inArgs = false;

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    // 遇到下一个补丁条目即停止
    if (/^\s*-\s*(id|insert):/.test(line)) break;

    const cm = line.match(/^\s*command:\s*(.+?)\s*$/);
    if (cm) {
      command = unquote(cm[1]);
      inArgs = false;
      continue;
    }
    if (/^\s*args:\s*$/.test(line)) {
      inArgs = true;
      continue;
    }
    if (inArgs) {
      const am = line.match(/^\s*-\s*(.+?)\s*$/);
      if (am) args.push(unquote(am[1]));
      else if (line.trim()) inArgs = false;
    }
  }

  return command ? { command, args } : null;
}

/**
 * DSH 程序版本探测。
 * runtime.json 的 desktopVersion 表示 runtime payload 清单，DSH 升级桌面程序后
 * 它不会同步（实测 11-04 的清单配 11-13 的程序），因此优先采用更新器
 * pending/update-info.json 里安装包文件名中的版本，那才是实际装上的版本。
 */
function detectDshVersions(dshHome) {
  const out = { version: null, source: null, runtimeVersion: null };

  const runtime = readJson(
    path.join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime', 'runtime.json'),
  );
  if (runtime && runtime.desktopVersion) out.runtimeVersion = runtime.desktopVersion;

  const localAppData = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
  const updateInfo = readJson(
    path.join(localAppData, '@deepseek-aidsh-desktop-updater', 'pending', 'update-info.json'),
  );
  if (updateInfo && updateInfo.fileName) {
    const m = String(updateInfo.fileName).match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/);
    if (m) {
      out.version = m[1];
      out.source = 'updater';
    }
  }

  if (!out.version && out.runtimeVersion) {
    out.version = out.runtimeVersion;
    out.source = 'runtime';
  }

  return out;
}

function collectDsh() {
  const homeEnv = process.env.DSH_HOME;
  const dshHome = homeEnv && homeEnv.trim() ? homeEnv.trim() : path.join(HOME, '.dsh');
  const patchPath = path.join(dshHome, 'cordis.patch.yml');
  const profileDir = path.join(dshHome, 'profiles', 'desktop');

  const out = {
    detected: fs.existsSync(dshHome),
    home: dshHome,
    patchPath,
    registered: false,
    command: null,
    args: [],
    reaVersion: null,
    dshVersion: null,
    plugin: null,
    pluginMatches: null,
    detail: null,
  };

  if (!out.detected) {
    out.detail = '未检测到 DeepSeek Harness 数据目录（' + dshHome + '）';
    return out;
  }

  // DSH 真实产品版本：优先更新器记录，其次 runtime 清单
  const versions = detectDshVersions(dshHome);
  out.dshVersion = versions.version;
  out.versionSource = versions.source;
  out.runtimeVersion = versions.runtimeVersion;
  if (versions.runtimeVersion && versions.version && versions.runtimeVersion !== versions.version) {
    out.versionDrift = true;
  }

  let text = null;
  try {
    text = fs.readFileSync(patchPath, 'utf8');
  } catch {
    /* 文件不存在或不可读 */
  }

  if (!text) {
    out.detail = '尚未接入 REA（缺少 ' + patchPath + '）';
    return out;
  }

  const entry = parseDshPatch(text);
  if (!entry) {
    out.detail = '补丁中没有 rea 条目';
    return out;
  }

  out.registered = true;
  out.command = entry.command;
  out.args = entry.args;

  const missing = [];
  if (!fs.existsSync(entry.command)) missing.push('启动程序不存在：' + entry.command);
  for (const a of entry.args) {
    if (/\.(mjs|cjs|js)$/i.test(a) && !fs.existsSync(a)) missing.push('脚本不存在：' + a);
  }
  if (missing.length) {
    out.registered = false;
    out.detail = missing[0];
  }

  out.reaVersion = reaVersionFromScript(entry.args.find((a) => /\.(mjs|cjs|js)$/i.test(a)));

  // 补丁只是声明，真正让 DSH 能加载的是这个插件包
  const pluginPkg = readJson(
    path.join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-mcp-client', 'package.json'),
  );
  if (pluginPkg && pluginPkg.version) {
    out.plugin = pluginPkg.version;
    out.pluginMatches = out.dshVersion ? pluginPkg.version === out.dshVersion : null;
  } else {
    out.detail = out.detail || '缺少 @deepseek-ai/dsh-mcp-client 插件，DSH 无法加载该条目';
  }

  return out;
}

function collectFastStatus() {
  const rea = findRea();
  // 目录名可推断时先用它；推断不出来则留空，等 doctor 返回权威版本
  const nodeVersion = nodeVersionFromRea(rea);

  const result = {
    checkedAt: new Date().toISOString(),
    cli: { ok: false, version: null, path: null, detail: null },
    mcp: { ok: false, configPath: path.join(WB_DIR, 'mcp.json'), detail: null },
    skill: {
      ok: false,
      path: path.join(WB_DIR, 'skills', 'reverse-engineer-anything', 'SKILL.md'),
      detail: null,
    },
    node: {
      version: nodeVersion,
      compliant: nodeVersion ? isNodeCompliant(nodeVersion) : null,
      required: NODE_RANGE_TEXT,
    },
  };

  if (!rea) {
    result.cli.detail = '未找到 rea-agents 安装目录（可能未安装，或 Node 升级后全局包丢失）';
  } else {
    result.cli = { ok: true, version: rea.version, path: rea.pkgPath, detail: null };
  }

  const mcpFile = result.mcp.configPath;
  if (!fs.existsSync(mcpFile)) {
    result.mcp.detail = '缺少 mcp.json，WorkBuddy 无法加载 REA';
  } else {
    const cfg = readJson(mcpFile);
    const srv = cfg && cfg.mcpServers && cfg.mcpServers.rea;
    if (!srv) {
      result.mcp.detail = 'mcp.json 中没有 rea 条目';
    } else {
      const missing = [];
      if (!srv.command) missing.push('command 字段为空');
      else if (!fs.existsSync(srv.command)) missing.push('command 指向的文件不存在：' + srv.command);

      for (const arg of Array.isArray(srv.args) ? srv.args : []) {
        if (/\.(mjs|cjs|js)$/i.test(arg) && !fs.existsSync(arg)) {
          missing.push('脚本路径已失效：' + arg);
        }
      }

      if (missing.length === 0) {
        result.mcp.ok = true;
        result.mcp.command = srv.command;
        result.mcp.args = srv.args || [];
        const scriptArg = (srv.args || []).find((a) => /\.(mjs|cjs|js)$/i.test(a));
        result.mcp.reaVersion = reaVersionFromScript(scriptArg);
      } else {
        result.mcp.detail = missing[0];
        result.mcp.missing = missing;
        if (rea) {
          result.mcp.suggestion = {
            mcpServers: { rea: { command: rea.exe, args: [...rea.scriptArgs, 'mcp'] } },
          };
        }
      }
    }
  }

  if (fs.existsSync(result.skill.path)) {
    result.skill.ok = true;
  } else {
    result.skill.detail = '缺少分析工作流指令，REA 工具仍可用但缺少使用规范';
  }

  result.dsh = collectDsh();

  return result;
}

/* ------------------------------------------------------------------ */
/* /api/doctor                                                         */
/* ------------------------------------------------------------------ */

const ENGINE_CHECKS = {
  hopper: 'Hopper',
  ghidra: 'Ghidra',
  'ida-registration': 'IDA',
  jadx: 'JADX',
  'kuna-installation': 'Kuna',
};

let doctorCache = { at: 0, data: null };

async function collectDoctor(force) {
  if (!force && doctorCache.data && Date.now() - doctorCache.at < 30000) {
    return Object.assign({}, doctorCache.data, { cached: true });
  }

  const rea = findRea();
  if (!rea) {
    return { ok: false, detail: '无法执行 doctor：未找到 rea', engines: null, node: null };
  }

  const run = await runRea(rea, ['doctor', '--format', 'json'], 25000);
  const raw = run.stdout.trim();

  let doc = null;
  if (raw) {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        doc = JSON.parse(raw.slice(start, end + 1));
      } catch {
        /* 解析失败按不可用处理 */
      }
    }
  }

  if (!doc) {
    const payload = {
      ok: false,
      detail: run.killed ? 'doctor 执行超时' : 'doctor 未返回可解析的结果',
      engines: null,
      node: null,
      stderr: run.stderr.slice(0, 400),
    };
    doctorCache = { at: Date.now(), data: payload };
    return payload;
  }

  const checks = Array.isArray(doc.scope_checks) ? doc.scope_checks : [];
  const nodeCheck = checks.find((c) => c.name === 'node');
  const nodeVersion =
    (nodeCheck && nodeCheck.details && nodeCheck.details.version) ||
    (nodeCheck && nodeCheck.detail) ||
    null;

  const ready = [];
  const missing = [];
  for (const name of Object.keys(ENGINE_CHECKS)) {
    const label = ENGINE_CHECKS[name];
    const c = checks.find((x) => x.name === name);
    if (c && c.ok === true) ready.push(label);
    else missing.push({ label, hint: (c && (c.detail || c.remediation)) || null });
  }

  const skillCheck = checks.find((c) => c.name === 'skill:identity');

  const payload = {
    ok: true,
    healthy: doc.healthy === true,
    node: nodeVersion
      ? {
          version: nodeVersion,
          compliant: isNodeCompliant(nodeVersion),
          required: NODE_RANGE_TEXT,
        }
      : null,
    engines: { ready, missing },
    skillIdentity: skillCheck ? skillCheck.ok === true : null,
    host: (checks.find((c) => c.name === 'host') || {}).detail || null,
  };

  doctorCache = { at: Date.now(), data: payload };
  return payload;
}

/* ------------------------------------------------------------------ */
/* /api/release                                                        */
/* ------------------------------------------------------------------ */

let releaseCache = { at: 0, data: null };

async function collectRelease(force) {
  if (!force && releaseCache.data && Date.now() - releaseCache.at < 60000) {
    return Object.assign({}, releaseCache.data, { cached: true });
  }

  const rea = findRea();
  const current = rea && rea.version ? rea.version : null;

  const out = {
    current,
    latest: null,
    updateAvailable: false,
    source: null,
    publishedAt: null,
    releaseUrl: null,
    notes: null,
    ghReachable: false,
    warnings: [],
  };

  try {
    const meta = await fetchJson(NPM_LATEST, 8000);
    if (meta && meta.version) {
      out.latest = meta.version;
      out.source = 'npm';
    }
  } catch (e) {
    out.warnings.push('npm registry 查询失败：' + (e.message || '网络不可达'));
  }

  try {
    const gh = await fetchJson(GH_LATEST, 5000, { accept: 'application/vnd.github+json' });
    out.ghReachable = true;
    if (gh) {
      const tag = String(gh.tag_name || '').replace(/^rea-agents-/, '');
      if (!out.latest && tag) {
        out.latest = tag;
        out.source = 'github';
      }
      out.releaseUrl = gh.html_url || null;
      out.releaseName = gh.name || null;
      out.publishedAt = gh.published_at || null;
      if (typeof gh.body === 'string') out.notes = gh.body.slice(0, 1200);
    }
  } catch {
    out.warnings.push('GitHub API 不可达（通常需要代理），已跳过 release 说明');
  }

  if (!out.releaseUrl) out.releaseUrl = 'https://github.com/morluto/rea/releases';

  if (out.latest && current) {
    out.updateAvailable = compareVersion(out.latest, current) > 0;
    out.upToDate = !out.updateAvailable;
  }

  releaseCache = { at: Date.now(), data: out };
  return out;
}

/* ------------------------------------------------------------------ */
/* 更新任务                                                            */
/* ------------------------------------------------------------------ */

/** 更新任务状态；同一时间只允许一个更新在跑。 */
let updateJob = {
  running: false,
  startedAt: null,
  finishedAt: null,
  ok: null,
  exitCode: null,
  fromVersion: null,
  toVersion: null,
  log: [],
};

const UPDATE_TIMEOUT_MS = 5 * 60 * 1000;

function pushLog(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    updateJob.log.push(t.slice(0, 400));
  }
  // 只保留最近 120 行，避免长任务把内存撑大
  if (updateJob.log.length > 120) updateJob.log.splice(0, updateJob.log.length - 120);
}

function startUpdate() {
  if (updateJob.running) {
    return { started: false, running: true, detail: '已有更新任务在执行' };
  }

  const rea = findRea();
  if (!rea) {
    return { started: false, error: '未找到 REA 安装，无法执行更新' };
  }

  updateJob = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: null,
    exitCode: null,
    fromVersion: rea.version,
    toVersion: null,
    log: [],
  };

  let child;
  try {
    child = spawn(rea.exe, [...rea.scriptArgs, 'update'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { NO_COLOR: '1' }),
    });
  } catch (e) {
    updateJob.running = false;
    updateJob.ok = false;
    updateJob.finishedAt = new Date().toISOString();
    pushLog('启动更新进程失败：' + e.message);
    return { started: false, error: e.message };
  }

  pushLog('执行：rea update（当前 ' + (rea.version || '未知') + '）');

  const timer = setTimeout(() => {
    pushLog('超过 5 分钟未完成，终止更新进程树');
    try {
      if (process.platform === 'win32' && child.pid) {
        // 更新会派生 npm 子进程，普通 kill 只杀父进程，必须按进程树终止
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      /* 进程可能已退出 */
    }
  }, UPDATE_TIMEOUT_MS);

  child.stdout.on('data', (d) => pushLog(d.toString('utf8')));
  child.stderr.on('data', (d) => pushLog(d.toString('utf8')));

  child.on('error', (e) => {
    pushLog('进程错误：' + e.message);
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    updateJob.running = false;
    updateJob.finishedAt = new Date().toISOString();
    updateJob.exitCode = code;
    updateJob.ok = code === 0;

    // 版本号重读，并让缓存失效，下次请求直接反映新版本
    const after = findRea();
    updateJob.toVersion = after && after.version ? after.version : null;
    doctorCache = { at: 0, data: null };
    releaseCache = { at: 0, data: null };

    pushLog(code === 0 ? '更新完成' : '更新进程退出码 ' + code);
  });

  return {
    started: true,
    fromVersion: rea.version,
    detail: '更新已启动，请勿关闭窗口',
  };
}

/* ------------------------------------------------------------------ */
/* 一键修复 WorkBuddy 接入                                              */
/* ------------------------------------------------------------------ */

/**
 * 把 mcp.json 里的 rea 条目重写为当前可用的 REA 路径。
 * 原则：写前备份、原文件不是合法 JSON 就中止（不覆盖用户配置）、写后回读校验。
 */
function repairMcpConfig() {
  const rea = findRea();
  if (!rea) {
    return { ok: false, error: '未找到可用的 REA 安装，无法修复接入' };
  }

  const cfgPath = path.join(WB_DIR, 'mcp.json');
  let cfg = {};
  let backup = null;

  if (fs.existsSync(cfgPath)) {
    const raw = fs.readFileSync(cfgPath, 'utf8');
    try {
      cfg = JSON.parse(raw) || {};
    } catch {
      return { ok: false, error: 'mcp.json 不是合法 JSON，已中止以免覆盖你的配置' };
    }
    backup = cfgPath + '.bak-' + Date.now();
    fs.copyFileSync(cfgPath, backup);
  }

  if (!cfg.mcpServers || typeof cfg.mcpServers !== 'object') cfg.mcpServers = {};
  cfg.mcpServers.rea = { command: rea.exe, args: [...rea.scriptArgs, 'mcp'] };

  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

  let verify = null;
  try {
    verify = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).mcpServers.rea;
  } catch {
    return { ok: false, error: '写入后回读失败' };
  }

  const valid =
    verify &&
    fs.existsSync(verify.command) &&
    (verify.args || []).some((a) => /\.(mjs|cjs|js)$/i.test(a) && fs.existsSync(a));

  return {
    ok: Boolean(valid),
    configPath: cfgPath,
    backup,
    command: verify ? verify.command : null,
    version: rea.version,
    detail: valid ? '接入已更新，重启 WorkBuddy 会话后生效' : '写入完成但校验未通过',
  };
}

/* ------------------------------------------------------------------ */
/* DSH 插件对齐                                                        */
/* ------------------------------------------------------------------ */

let dshRepairJob = {
  running: false,
  startedAt: null,
  finishedAt: null,
  ok: null,
  exitCode: null,
  targetVersion: null,
  fromVersion: null,
  resultVersion: null,
  log: [],
};

const DSH_REPAIR_TIMEOUT_MS = 3 * 60 * 1000;

function pushDshLog(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    dshRepairJob.log.push(t.slice(0, 400));
  }
  if (dshRepairJob.log.length > 100) dshRepairJob.log.splice(0, dshRepairJob.log.length - 100);
}

function resolveDshTooling(dshHome) {
  const runtime = path.join(dshHome, 'dsh-runtimes', 'dsh-primary-runtime');
  return {
    pnpm: path.join(runtime, 'dependencies', 'pnpm', 'bin', 'pnpm.cjs'),
    profile: path.join(dshHome, 'profiles', 'desktop'),
  };
}

/**
 * 把 dsh-mcp-client 装成与 DSH 版本一致。
 * 只用 DSH 自带的 pnpm，避免版本解析与宿主不一致；装完回读确认。
 */
function startDshRepair() {
  if (dshRepairJob.running) return { started: false, detail: '已有对齐任务在执行' };

  const dsh = collectDsh();
  if (!dsh.detected) return { started: false, error: '未检测到 DeepSeek Harness' };
  if (!dsh.dshVersion) {
    return { started: false, error: '无法确定 DSH 版本，无法选择匹配的插件版本' };
  }
  if (dsh.pluginMatches === true) {
    return { started: false, detail: '插件版本已与 DSH 匹配，无需对齐' };
  }

  const tooling = resolveDshTooling(dsh.home);
  if (!fs.existsSync(tooling.pnpm) || !fs.existsSync(tooling.profile)) {
    return { started: false, error: 'DSH 运行时缺少 pnpm 或 profile 目录' };
  }

  const rea = findRea();
  if (!rea) return { started: false, error: '未找到可用的 Node 运行时' };

  dshRepairJob = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: null,
    exitCode: null,
    targetVersion: dsh.dshVersion,
    fromVersion: dsh.plugin,
    resultVersion: null,
    log: [],
  };

  const spec = '@deepseek-ai/dsh-mcp-client@' + dsh.dshVersion;
  pushDshLog('目标 ' + spec + '（' + (dsh.plugin || '未安装') + ' → ' + dsh.dshVersion + '）');

  let child;
  try {
    child = spawn(rea.exe, [tooling.pnpm, 'add', spec, '--ignore-scripts'], {
      cwd: tooling.profile,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { NO_COLOR: '1' }),
    });
  } catch (e) {
    dshRepairJob.running = false;
    dshRepairJob.ok = false;
    pushDshLog('启动失败：' + e.message);
    return { started: false, error: e.message };
  }

  const timer = setTimeout(() => {
    pushDshLog('超过 3 分钟未完成，终止进程树');
    try {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      /* 进程可能已退出 */
    }
  }, DSH_REPAIR_TIMEOUT_MS);

  child.stdout.on('data', (d) => pushDshLog(d.toString('utf8')));
  child.stderr.on('data', (d) => pushDshLog(d.toString('utf8')));
  child.on('error', (e) => pushDshLog('进程错误：' + e.message));

  child.on('close', (code) => {
    clearTimeout(timer);
    dshRepairJob.running = false;
    dshRepairJob.finishedAt = new Date().toISOString();
    dshRepairJob.exitCode = code;

    const after = collectDsh();
    dshRepairJob.resultVersion = after.plugin;
    dshRepairJob.ok = code === 0 && after.pluginMatches === true;

    pushDshLog(
      dshRepairJob.ok
        ? '对齐完成，当前插件 ' + after.plugin
        : '未对齐成功（退出码 ' + code + '）',
    );
    doctorCache = { at: 0, data: null };
  });

  return { started: true, targetVersion: dsh.dshVersion, detail: '开始安装匹配插件' };
}

/* ------------------------------------------------------------------ */
/* 客户端总览与一键接入                                                 */
/* ------------------------------------------------------------------ */

let clientsCache = { at: 0, data: null };
let clientsInFlight = null;

/**
 * 用 `rea setup --all-detected --dry-run` 拿全部客户端的检测/接入状态。
 * 这是 REA 官方的检测逻辑，比自己在面板里维护各客户端的 marker 路径可靠。
 * 60s 缓存 + in-flight 去重（setup dry-run 需要读几十个配置文件，约数秒）。
 */
async function collectClients(force) {
  if (!force && clientsCache.data && Date.now() - clientsCache.at < 60000) {
    return Object.assign({}, clientsCache.data, { cached: true });
  }
  if (clientsInFlight) return clientsInFlight;

  clientsInFlight = (async () => {
    const rea = findRea();
    if (!rea) {
      return { available: false, reason: '未找到 REA', clients: [], checkedAt: new Date().toISOString() };
    }
    try {
      const run = await runRea(
        rea,
        ['setup', '--all-detected', '--dry-run', '--format', 'json'],
        60000,
      );
      const raw = run.stdout || '';
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start < 0 || end <= start) throw new Error('REA 输出中没有 JSON');
      const parsed = JSON.parse(raw.slice(start, end + 1));

      const clients = (parsed.clientStates || []).map((c) => ({
        name: c.client.name,
        displayName: c.client.displayName,
        configPath: c.client.configPath || null,
        format: c.client.format || null,
        detected: Boolean(c.detected),
        configured: Boolean(c.configured),
        status: c.status,
        // REA 明确不支持自动写入的客户端（如 Grok Bot），只能手动配置
        manual: Boolean(
          c.client.registrationProfile &&
          c.client.registrationProfile.connection &&
          c.client.registrationProfile.connection.kind === 'unavailable',
        ),
      }));

      const data = { available: true, clients, checkedAt: new Date().toISOString() };
      clientsCache = { at: Date.now(), data };
      return data;
    } catch (e) {
      return {
        available: false,
        reason: e && e.message ? e.message : String(e),
        clients: [],
        checkedAt: new Date().toISOString(),
      };
    }
  })();

  const out = await clientsInFlight;
  clientsInFlight = null;
  return out;
}

/* ------------------------------------------------------------------ */
/* 一键接入（rea setup --client）                                       */
/* ------------------------------------------------------------------ */

/**
 * 白名单来自 REA 的 SupportedClients，防止把任意参数拼进命令行。
 */
const SETUP_CLIENT_WHITELIST = new Set([
  'claude_code', 'claude_desktop', 'codex', 'cursor', 'gemini_cli', 'windsurf',
  'devin', 'opencode', 'antigravity', 'copilot_cli', 'commandcode', 'qwen_code',
  'kimi', 'vscode', 'trae', 'workbuddy', 'grok_build', 'omp', 'pi', 'hermes',
  'qoder', 'droid', 'zcode', 'dsh', 'freebuff', 'grok_bot', 'codebuddy', 'lm_studio',
]);

let setupJob = {
  running: false,
  client: null,
  startedAt: null,
  finishedAt: null,
  ok: null,
  exitCode: null,
  log: [],
};

function pushSetupLog(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    setupJob.log.push(t.slice(0, 400));
  }
  if (setupJob.log.length > 120) setupJob.log.splice(0, setupJob.log.length - 120);
}

const SETUP_TIMEOUT_MS = 3 * 60 * 1000;

function startSetupClient(clientName) {
  if (!clientName || !SETUP_CLIENT_WHITELIST.has(clientName)) {
    return { started: false, error: '不支持的客户端: ' + (clientName || '(空)' ) };
  }
  if (setupJob.running) {
    return { started: false, detail: '已有接入任务在执行（' + setupJob.client + '）' };
  }

  const rea = findRea();
  if (!rea) return { started: false, error: '未找到 REA 安装' };

  setupJob = {
    running: true,
    client: clientName,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: null,
    exitCode: null,
    log: [],
  };

  pushSetupLog('执行：rea setup --client ' + clientName + ' --yes');

  let child;
  try {
    child = spawn(rea.exe, [...rea.scriptArgs, 'setup', '--client', clientName, '--yes'], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, { NO_COLOR: '1' }),
    });
  } catch (e) {
    setupJob.running = false;
    setupJob.ok = false;
    pushSetupLog('启动失败：' + e.message);
    return { started: false, error: e.message };
  }

  const timer = setTimeout(() => {
    pushSetupLog('超过 3 分钟未完成，终止进程树');
    try {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      /* 进程可能已退出 */
    }
  }, SETUP_TIMEOUT_MS);

  child.stdout.on('data', (d) => pushSetupLog(d.toString('utf8')));
  child.stderr.on('data', (d) => pushSetupLog(d.toString('utf8')));
  child.on('error', (e) => pushSetupLog('进程错误：' + e.message));

  child.on('close', (code) => {
    clearTimeout(timer);
    setupJob.running = false;
    setupJob.finishedAt = new Date().toISOString();
    setupJob.exitCode = code;
    setupJob.ok = code === 0;

    // 接入结果以重跑一次 dry-run 的状态为准（clientStates 才是权威）
    pushSetupLog(code === 0 ? 'setup 进程正常结束' : 'setup 退出码 ' + code);
    clientsCache = { at: 0, data: null };
  });

  return { started: true, client: clientName, detail: '接入任务已启动' };
}

/* ------------------------------------------------------------------ */
/* 静态资源                                                            */
/* ------------------------------------------------------------------ */

const MIME = {
  'index.html': 'text/html; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
}

/**
 * 本机校验：Host 必须是回环地址。
 * 防止 DNS rebinding —— 恶意域名解析到 127.0.0.1 后，浏览器会把它当同源，
 * 只看 CORS 挡不住，必须校验 Host。
 */
function hostAllowed(req) {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '';
}

/**
 * 写操作校验：浏览器发起的跨站请求一定带 Origin，只放行回环来源。
 * 没有 Origin 的请求（curl、脚本、本地同名调用）视为非浏览器，放行。
 * 否则任意网页都能 POST /api/update 在本机装包，属于 CSRF。
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const h = u.hostname.toLowerCase();
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
  } catch {
    return false;
  }
}

function serveStatic(res, urlPath) {
  const name = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const body = ASSETS.get(name);

  if (body === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }

  res.writeHead(200, {
    'content-type': MIME[name] || 'text/plain; charset=utf-8',
    'cache-control': 'no-cache',
  });
  res.end(body);
}

/* ------------------------------------------------------------------ */
/* 日志                                                                */
/* ------------------------------------------------------------------ */

/**
 * 打包为 GUI 子系统的 exe 没有控制台，stdout 会丢失。
 * 因此所有提示同时写入 %LOCALAPPDATA%\REA-Panel\panel.log，便于排障。
 */
const LOG_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'REA-Panel');
const LOG_MAX_BYTES = 1024 * 1024; // 超过 1MB 轮转，避免长期运行把日志堆到无限大
let logStream = null;

function rotateLogIfNeeded(file) {
  try {
    if (fs.statSync(file).size > LOG_MAX_BYTES) {
      fs.renameSync(file, file + '.1');
    }
  } catch {
    /* 文件还不存在或被占用，忽略 */
  }
}

function logLine(text) {
  try {
    if (!logStream) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const file = path.join(LOG_DIR, 'panel.log');
      rotateLogIfNeeded(file);
      logStream = fs.createWriteStream(file, { flags: 'a' });
    }
    logStream.write(new Date().toISOString() + '  ' + text + '\n');
  } catch {
    /* 日志写不进去不影响主流程 */
  }
  try {
    console.log(text);
  } catch {
    /* 无控制台时忽略 */
  }
}

function logError(text) {
  logLine(text);
  try {
    console.error(text);
  } catch {
    /* 无控制台时忽略 */
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

/** 定位 Edge（Windows 上基本必装），用于承载独立应用窗口。 */
function findBrowserExe() {
  const roots = [
    process.env['ProgramFiles(x86)'],
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft') : null,
  ].filter(Boolean);

  const rels = [
    ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ['Google', 'Chrome', 'Application', 'chrome.exe'],
  ];

  for (const root of roots) {
    for (const rel of rels) {
      const p = path.join(root, ...rel);
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        /* 忽略无权限路径 */
      }
    }
  }
  return null;
}

let appWindow = null;

/**
 * 以「应用窗口」方式打开：--app 去掉地址栏与标签页，独立 user-data-dir 让它成为
 * 独立窗口实例（而不是复用已有浏览器进程）。窗口关闭后结束服务，不留后台进程。
 */
function openAppWindow(target) {
  if (NO_OPEN) return;

  const exe = findBrowserExe();
  if (!exe) {
    // 找不到 Chromium 系浏览器时退回默认浏览器
    try {
      spawn('cmd', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch {
      /* 用户可手动访问地址 */
    }
    return;
  }

  const profileDir = path.join(
    process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'),
    'REA-Panel',
    'window',
  );

  const args = [
    '--app=' + target,
    '--user-data-dir=' + profileDir,
    '--window-size=1240,940',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    // 屏蔽账号登录与同步相关的首次运行提示（否则会弹出「同步你的浏览数据」）
    '--disable-sync',
    '--no-service-autorun',
    '--disable-background-networking',
    '--disable-features=Translate,msEdgeSidebarV2,msEdgeIdentityFRE,msEdgeSyncPromo,msImplicitSignin,SigninInterception,EdgeIdentityFRE',
  ];

  try {
    appWindow = spawn(exe, args, { stdio: 'ignore', windowsHide: false });

    // 用户关闭窗口 → 结束本地服务，避免残留后台进程
    appWindow.on('exit', () => {
      setTimeout(() => process.exit(0), 400);
    });

    appWindow.on('error', () => {
      /* 启动失败时保留服务，用户可手动打开地址 */
    });
  } catch {
    /* 忽略，服务仍然可用 */
  }
}

async function alreadyRunning(port) {
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/api/status', {
      signal: AbortSignal.timeout(700),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return Boolean(body && body.cli && body.checkedAt);
  } catch {
    return false;
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const force = url.searchParams.get('force') === '1';

    try {
      if (!hostAllowed(req)) {
        return sendJson(res, 403, { error: 'forbidden host' });
      }
      const isWrite = req.method !== 'GET' && req.method !== 'HEAD';
      if (isWrite && !originAllowed(req)) {
        return sendJson(res, 403, { error: 'cross-origin write rejected' });
      }

      if (url.pathname === '/api/status') return sendJson(res, 200, collectFastStatus());
      if (url.pathname === '/api/doctor') return sendJson(res, 200, await collectDoctor(force));
      if (url.pathname === '/api/release') return sendJson(res, 200, await collectRelease(force));
      if (url.pathname === '/api/update') {
        if (req.method === 'POST') return sendJson(res, 200, startUpdate());
        return sendJson(res, 200, updateJob);
      }
      if (url.pathname === '/api/repair-mcp') {
        if (req.method === 'POST') return sendJson(res, 200, repairMcpConfig());
        return sendJson(res, 405, { error: 'use POST' });
      }
      if (url.pathname === '/api/repair-dsh') {
        if (req.method === 'POST') return sendJson(res, 200, startDshRepair());
        return sendJson(res, 200, dshRepairJob);
      }
      if (url.pathname === '/api/clients') {
        return sendJson(res, 200, await collectClients(force));
      }
      if (url.pathname === '/api/setup-client') {
        if (req.method === 'POST') {
          return sendJson(res, 200, startSetupClient(url.searchParams.get('client')));
        }
        return sendJson(res, 200, setupJob);
      }
      if (url.pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'unknown endpoint' });
      return serveStatic(res, url.pathname);
    } catch (e) {
      sendJson(res, 500, { error: e && e.message ? e.message : String(e) });
    }
  });
}

async function main() {
  process.title = 'REA 状态面板';

  const server = createServer();
  let attempt = 0;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 20) {
      attempt += 1;
      const next = PORT_START + attempt;
      logLine('端口 ' + (next - 1) + ' 被占用，尝试 ' + next);
      setTimeout(() => server.listen(next, '127.0.0.1'), 50);
      return;
    }
    logError('服务启动失败：' + err.message);
    process.exit(1);
  });

  // 已有实例在跑时，只把浏览器指过去，不重复占端口
  if (!NO_OPEN && (await alreadyRunning(PORT_START))) {
    logLine('面板已在运行：http://127.0.0.1:' + PORT_START + '/');
    openAppWindow('http://127.0.0.1:' + PORT_START + '/');
    setTimeout(() => process.exit(0), 400);
    return;
  }

  server.listen(PORT_START, '127.0.0.1', () => {
    const target = 'http://127.0.0.1:' + server.address().port + '/';
    logLine('  REA 状态面板已启动');
    logLine('  ' + target);
    logLine('  关闭应用窗口即停止服务');
    openAppWindow(target);
  });

  process.on('SIGINT', () => {
    logLine('已停止。');
    process.exit(0);
  });
}

main().catch((e) => {
  logError('启动异常：' + (e && e.message ? e.message : e));
  process.exit(1);
});
