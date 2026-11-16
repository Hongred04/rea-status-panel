/**
 * REA 接入与面板的卸载/回退脚本。
 *
 * 设计原则：
 *   1. 默认只预览，必须显式 --apply 才动手。
 *   2. 配置文件只做「精确条目移除」，绝不整文件删除 —— ~/.dsh/cordis.patch.yml
 *      与 ~/.workbuddy/mcp.json 里还有用户自己的配置。
 *   3. 任何修改前先备份。
 *   4. 所有路径必须落在预期根目录内，越界即拒绝。
 *
 * 用法：
 *   node build/uninstall.mjs                 预览全部步骤
 *   node build/uninstall.mjs --apply         执行（不含面板自身与下载缓存）
 *   node build/uninstall.mjs --apply --all   连面板自身、源码目录一并清理
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = os.homedir();
const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');

/** --only dsh-patch,wb-mcp ：只处理指定步骤，便于分步回退与隔离测试。 */
const ONLY = (() => {
  const i = process.argv.indexOf('--only');
  if (i >= 0 && process.argv[i + 1]) {
    return process.argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
  }
  return null;
})();

const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim()
  ? process.env.DSH_HOME.trim()
  : path.join(HOME, '.dsh');
const WB_HOME = path.join(HOME, '.workbuddy');
const AGENTS_HOME = path.join(HOME, '.agents');
const NODE24 = path.join(HOME, '.node24');
const PANEL_STATE = path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'REA-Panel');
const DESKTOP_EXE = path.join(HOME, 'Desktop', 'AI相关', 'REA 状态面板.exe');

const log = (s) => console.log(s);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** 只允许删除这些根目录下的内容。 */
const ALLOWED_ROOTS = [DSH_HOME, WB_HOME, AGENTS_HOME, NODE24, PANEL_STATE, ROOT, path.dirname(DESKTOP_EXE)];

function assertInside(target) {
  const abs = path.resolve(target);
  const ok = ALLOWED_ROOTS.some((root) => abs === path.resolve(root) || abs.startsWith(path.resolve(root) + path.sep));
  if (!ok) throw new Error('路径越界，拒绝操作: ' + abs);
  return abs;
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const dest = file + '.bak-' + stamp();
  fs.copyFileSync(file, dest);
  return dest;
}

function removePath(target) {
  const abs = assertInside(target);
  if (!fs.existsSync(abs)) return false;
  fs.rmSync(abs, { recursive: true, force: true });
  return true;
}

/**
 * 从 cordis 补丁中精确移除 id: rea-mcp 那一条。
 * 返回新文本；找不到则返回 null。
 */
function stripReaFromCordisPatch(text) {
  const lines = text.split(/\r?\n/);

  // 顶层补丁条目（行首 "- "，无缩进）
  const bounds = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^- /.test(lines[i])) bounds.push(i);
  }
  bounds.push(lines.length);

  for (let b = 0; b < bounds.length - 1; b += 1) {
    const start = bounds[b];
    const end = bounds[b + 1];
    const block = lines.slice(start, end);

    const reaIdx = block.findIndex((l) => /^\s*-\s*id:\s*rea-mcp\s*$/.test(l));
    if (reaIdx < 0) continue;

    const idIndexes = [];
    block.forEach((l, i) => {
      if (/^\s*-\s*id:/.test(l)) idIndexes.push(i);
    });

    if (idIndexes.length <= 1) {
      // 这个顶层块只有 rea 一条，整块移除
      lines.splice(start, end - start);
    } else {
      // 还有别的插件条目，只移除 rea 这一条
      const at = idIndexes.indexOf(reaIdx);
      const next = at + 1 < idIndexes.length ? idIndexes[at + 1] : block.length;
      lines.splice(start + reaIdx, next - reaIdx);
    }

    // 收敛连续空行
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  }
  return null;
}

const steps = [];

/* ---------------- 1. DSH 补丁条目 ---------------- */
steps.push({
  id: 'dsh-patch',
  title: 'DSH 接入条目（cordis.patch.yml）',
  run() {
    const file = path.join(DSH_HOME, 'cordis.patch.yml');
    if (!fs.existsSync(file)) return '未发现，跳过';

    const text = fs.readFileSync(file, 'utf8');
    const next = stripReaFromCordisPatch(text);
    if (next === null) return '补丁中没有 rea 条目，跳过';

    if (!APPLY) return '将移除 rea-mcp 条目（保留你的其他 DSH 配置）';

    const bak = backup(file);
    fs.writeFileSync(file, next, 'utf8');
    return '已移除 rea-mcp 条目' + (bak ? '，备份 ' + path.basename(bak) : '');
  },
});

/* ---------------- 2. DSH 侧插件 ---------------- */
steps.push({
  id: 'dsh-plugin',
  title: 'DSH 的 MCP 客户端插件',
  run() {
    const pluginDir = path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', '@deepseek-ai', 'dsh-mcp-client');
    const pkgFile = path.join(DSH_HOME, 'profiles', 'desktop', 'package.json');

    if (!fs.existsSync(pluginDir)) return '未安装，跳过';
    if (!APPLY) return '将删除插件目录并从 package.json 移除依赖';

    removePath(pluginDir);

    if (fs.existsSync(pkgFile)) {
      const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
      if (pkg.dependencies && pkg.dependencies['@deepseek-ai/dsh-mcp-client']) {
        backup(pkgFile);
        delete pkg.dependencies['@deepseek-ai/dsh-mcp-client'];
        fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
      }
    }
    return '已删除插件（pnpm-lock 未改，下次 pnpm install 会自动收敛）';
  },
});

/* ---------------- 3. DSH 技能包 ---------------- */
steps.push({
  id: 'dsh-skill',
  title: '共享技能包（~/.agents/skills）',
  run() {
    const dir = path.join(AGENTS_HOME, 'skills', 'reverse-engineer-anything');
    if (!fs.existsSync(dir)) return '未发现，跳过';
    if (!APPLY) return '将删除技能包目录';
    removePath(dir);
    return '已删除';
  },
});

/* ---------------- 4. WorkBuddy 接入 ---------------- */
steps.push({
  id: 'wb-mcp',
  title: 'WorkBuddy 接入条目（mcp.json）',
  run() {
    const file = path.join(WB_HOME, 'mcp.json');
    if (!fs.existsSync(file)) return '未发现，跳过';

    let cfg;
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return '不是合法 JSON，已跳过以免破坏配置';
    }
    if (!cfg.mcpServers || !cfg.mcpServers.rea) return '没有 rea 条目，跳过';

    if (!APPLY) return '将移除 mcpServers.rea（保留其他连接器）';

    const bak = backup(file);
    delete cfg.mcpServers.rea;
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    return '已移除 rea 条目' + (bak ? '，备份 ' + path.basename(bak) : '');
  },
});

/* ---------------- 5. WorkBuddy 技能包 ---------------- */
steps.push({
  id: 'wb-skill',
  title: 'WorkBuddy 技能包',
  run() {
    const dir = path.join(WB_HOME, 'skills', 'reverse-engineer-anything');
    if (!fs.existsSync(dir)) return '未发现，跳过';
    if (!APPLY) return '将删除技能包目录';
    removePath(dir);
    return '已删除';
  },
});

/* ---------------- 6. REA 运行时 ---------------- */
steps.push({
  id: 'rea-runtime',
  title: 'REA 运行时（~/.node24 内的 rea-agents）',
  run() {
    const dir = path.join(NODE24, 'node_modules', 'rea-agents');
    if (!fs.existsSync(dir)) return '未发现，跳过';
    if (!APPLY) return '将删除 rea-agents（保留 node.exe 本身）';
    removePath(dir);
    return '已删除';
  },
});

/* ---------------- 7. 面板自身（仅 --all） ---------------- */
steps.push({
  id: 'panel',
  title: '面板自身（exe、源码目录、本地状态）',
  run() {
    if (!ALL) return '需要 --all 才会处理';

    const targets = [DESKTOP_EXE, PANEL_STATE, ROOT].filter((p) => fs.existsSync(p));
    if (targets.length === 0) return '未发现，跳过';
    if (!APPLY) return '将删除：' + targets.join('、');

    const results = [];
    for (const t of targets) {
      if (path.resolve(t) === path.resolve(ROOT)) continue; // 最后再删，见下方提示
      results.push(removePath(t) ? '已删除 ' + path.basename(t) : '跳过 ' + path.basename(t));
    }
    results.push('源码目录 ' + ROOT + ' 请在脚本结束后手动删除（脚本正在其中运行）');
    return results.join('；');
  },
});

/* ---------------- 执行 ---------------- */

log('');
log('REA 卸载' + (APPLY ? (ALL ? '（含面板自身）' : '（保留面板自身）') : ' —— 预览模式'));
log('='.repeat(58));

const selected = ONLY ? steps.filter((s) => ONLY.includes(s.id)) : steps;
if (ONLY && selected.length === 0) {
  log('\n未匹配到步骤：' + ONLY.join(', '));
  log('可选值：' + steps.map((s) => s.id).join(', '));
  process.exit(1);
}

for (const step of selected) {
  let msg;
  try {
    msg = step.run();
  } catch (e) {
    msg = '失败：' + (e && e.message ? e.message : e);
  }
  log('\n[' + step.id + '] ' + step.title);
  log('  → ' + msg);
}

log('\n' + '='.repeat(58));
if (!APPLY) {
  log('以上为预览。确认无误后执行：');
  log('  node build/uninstall.mjs --apply          仅移除接入与插件');
  log('  node build/uninstall.mjs --apply --all    连面板与源码一并清理');
} else {
  log('执行完毕。DSH 与 WorkBuddy 需要重启才会感知配置变化。');
}
log('');
