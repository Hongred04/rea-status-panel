/* REA 状态面板 — 前端逻辑
   三个接口并行请求、独立渲染：本地状态先出，doctor 与更新检查随后补上。 */

const $ = (id) => document.getElementById(id);

const state = { status: null, doctor: null, release: null };

/* ---------------- 通用工具 ---------------- */

function setPill(el, level, text) {
  if (!el) return;
  el.dataset.level = level;
  el.textContent = text;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function row(parent, key, value, valueClass) {
  const d = el('div', 'row');
  d.appendChild(el('span', 'k', key));
  const v = el('span', 'v' + (valueClass ? ' ' + valueClass : ''));
  if (value instanceof Node) v.appendChild(value);
  else v.textContent = value === undefined || value === null || value === '' ? '—' : String(value);
  d.appendChild(v);
  parent.appendChild(d);
  return v;
}

function list(parent, items) {
  const ul = el('ul', 'list-plain');
  for (const it of items) {
    const li = el('li', it.level || '');
    li.appendChild(el('span', '', it.text));
    ul.appendChild(li);
  }
  parent.appendChild(ul);
}

function fixBlock(parent, label, command) {
  const box = el('div', 'fix');
  const head = el('div', 'fix-head');
  head.appendChild(el('span', '', label));
  const btn = el('button', 'copy', '复制');
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(command);
      btn.textContent = '已复制';
    } catch {
      btn.textContent = '复制失败';
    }
    setTimeout(() => { btn.textContent = '复制'; }, 1600);
  });
  head.appendChild(btn);
  box.appendChild(head);
  box.appendChild(el('code', '', command));
  parent.appendChild(box);
}

function fmtAbsolute(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { hour12: false });
}

function fmtRelative(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const hours = Math.round(min / 60);
  if (hours < 24) return hours + ' 小时前';
  const days = Math.round(hours / 24);
  if (days < 30) return days + ' 天前';
  return Math.round(days / 30) + ' 个月前';
}

/* ---------------- 总体状态 ---------------- */

function renderOverall() {
  const box = $('overall');
  const text = $('overallText');
  const s = state.status;
  const d = state.doctor;

  if (!s) {
    box.dataset.level = 'pending';
    text.textContent = '检查中…';
    return;
  }

  if (!s.cli.ok) {
    box.dataset.level = 'fail';
    text.textContent = 'REA 未就绪';
    return;
  }

  if (!s.mcp.ok) {
    box.dataset.level = 'fail';
    text.textContent = 'WorkBuddy 未接入';
    return;
  }

  const nodeVersion = (d && d.node && d.node.version) || s.node.version;
  const nodeOk = (d && d.node && d.node.compliant) ?? s.node.compliant;

  // 只有明确判定为不合规才降级；未知（null）不降级
  if (nodeOk === false) {
    box.dataset.level = 'warn';
    text.textContent = '可用 · Node 版本偏低';
    return;
  }

  box.dataset.level = 'ok';
  text.textContent = '全部正常';
}

/* ---------------- 本地快速状态 ---------------- */

function renderStatus(s) {
  // 命令行
  clear($('cliBody'));
  if (s.cli.ok) {
    setPill($('cliPill'), 'ok', '可用');
    row($('cliBody'), '版本', s.cli.version || '未知', 'mono');
    row($('cliBody'), '安装位置', s.cli.path, 'mono muted path');
  } else {
    setPill($('cliPill'), 'fail', '不可用');
    row($('cliBody'), '问题', s.cli.detail);
    fixBlock($('cliBody'), '修复命令', 'npm install -g rea-agents@6.8.0 --omit=optional');
  }

  // WorkBuddy 接入
  clear($('mcpBody'));
  if (s.mcp.ok) {
    setPill($('mcpPill'), 'ok', '已接入');
    row($('mcpBody'), '配置文件', s.mcp.configPath, 'mono muted path');
    row($('mcpBody'), '启动命令', s.mcp.command, 'mono path');

    // 显式暴露「注册所用版本」与「命令行版本」不一致的情况
    let mismatch = false;
    if (s.mcp.reaVersion) {
      const wrap = el('span', '');
      wrap.appendChild(el('span', 'mono', s.mcp.reaVersion));
      mismatch = Boolean(s.cli.ok && s.cli.version && s.mcp.reaVersion !== s.cli.version);
      if (mismatch) {
        wrap.appendChild(el('span', 'tag tag-warn', '与命令行 ' + s.cli.version + ' 不一致'));
      }
      row($('mcpBody'), '接入版本', wrap);
    }

    const note = el('div', 'foot-note');
    note.style.marginTop = '8px';
    note.textContent = '注：此处校验配置有效性。若工具在对话中不可用，还需在 WorkBuddy 连接器管理中对 rea 点击「信任」并重启会话。';
    $('mcpBody').appendChild(note);

    if (mismatch) {
      appendRepairButton($('mcpBody'), '同步到 ' + s.cli.version);
    }
  } else {
    setPill($('mcpPill'), 'fail', '未接入');
    row($('mcpBody'), '问题', s.mcp.detail);
    if (s.mcp.suggestion) {
      fixBlock($('mcpBody'), '可直接替换为以下配置（mcp.json）', JSON.stringify(s.mcp.suggestion, null, 2));
    }
    appendRepairButton($('mcpBody'), '一键修复接入');
  }

  // 技能包
  clear($('skillBody'));  if (s.skill.ok) {
    setPill($('skillPill'), 'ok', '已安装');
    row($('skillBody'), '名称', 'reverse-engineer-anything');
    row($('skillBody'), '位置', s.skill.path, 'mono muted path');
  } else {
    setPill($('skillPill'), 'fail', '缺失');
    row($('skillBody'), '问题', s.skill.detail);
    fixBlock($('skillBody'), '重新安装技能包（复制包内 skills 目录即可）', 'xcopy /E /I "' + (s.cli.path || '<rea-agents 安装目录>') + '\\skills\\reverse-engineer-anything" "%USERPROFILE%\\.workbuddy\\skills\\reverse-engineer-anything"');
  }

  // 运行环境（初步，doctor 到达后以权威值覆盖）
  renderNode(s.node.version, s.node.compliant, s.node.required);

  renderDsh(s.dsh);

  renderOverall();
}

/* ---------------- DeepSeek Harness ---------------- */

function renderDsh(d) {
  const body = $('dshBody');
  if (!body) return;
  clear(body);

  if (!d) {
    setPill($('dshPill'), 'pending', '未知');
    row(body, '状态', '未获取到数据');
    return;
  }

  if (!d.detected) {
    setPill($('dshPill'), 'info', '未安装');
    row(body, '状态', '未检测到 DeepSeek Harness');
    row(body, '数据目录', d.home, 'mono muted path');
    return;
  }

  if (!d.registered) {
    setPill($('dshPill'), 'fail', '未接入');
    row(body, '问题', d.detail || '补丁中没有 rea 条目');
    row(body, '补丁文件', d.patchPath, 'mono muted path');
    const tip = el('div', 'foot-note');
    tip.style.marginTop = '8px';
    tip.textContent = '修复：用 Node 24 环境执行 rea setup --client dsh --yes（Node 低于 22.23.4 时该命令会静默跳过）。';
    body.appendChild(tip);
    return;
  }

  const pluginBad = d.pluginMatches === false;
  setPill($('dshPill'), pluginBad ? 'warn' : 'ok', pluginBad ? '插件版本不符' : '已接入');

  if (d.dshVersion) {
    const wrap = el('span', '');
    wrap.appendChild(el('span', 'mono', d.dshVersion));
    if (d.versionSource === 'updater') {
      wrap.appendChild(el('span', 'tag', '来自更新器'));
    }
    row(body, 'DSH 版本', wrap);
  }
  row(body, '启动命令', d.command, 'mono path');

  if (d.reaVersion) {
    const wrap = el('span', '');
    wrap.appendChild(el('span', 'mono', d.reaVersion));
    if (state.status && state.status.cli.ok && d.reaVersion !== state.status.cli.version) {
      wrap.appendChild(el('span', 'tag tag-warn', '与命令行 ' + state.status.cli.version + ' 不一致'));
    }
    row(body, '接入版本', wrap);
  }

  if (d.plugin) {
    const wrap = el('span', '');
    wrap.appendChild(el('span', 'mono', d.plugin));
    if (pluginBad) {
      wrap.appendChild(el('span', 'tag tag-warn', '应匹配 ' + d.dshVersion));
    }
    row(body, 'MCP 插件', wrap);
  }

  const note = el('div', 'foot-note');
  note.style.marginTop = '8px';
  if (d.versionDrift) {
    note.textContent =
      '注：DSH 运行时清单仍记录 ' + d.runtimeVersion + '，桌面程序已升级到 ' + d.dshVersion +
      ' 但清单未同步。插件应按 ' + d.dshVersion + ' 对齐。';
  } else {
    note.textContent = d.plugin
      ? '补丁与插件由 REA 官方 setup 生成。DSH 升级后插件版本需同步，否则会加载失败。'
      : '注意：补丁已写入但缺少 MCP 插件，DSH 启动时该条目会被跳过。';
  }
  body.appendChild(note);

  if (pluginBad) {
    appendDshAlignButton(body, d);
  }
}

/* ---------------- DSH 插件对齐 ---------------- */

function appendDshAlignButton(parent, d) {
  const bar = el('div', 'update-bar');
  const btn = el('button', 'btn-primary', '对齐插件到 ' + d.dshVersion);
  btn.type = 'button';
  btn.id = 'btnDshAlign';

  btn.addEventListener('click', async () => {
    const ok = window.confirm(
      '将把 @deepseek-ai/dsh-mcp-client 安装为 ' + d.dshVersion + '，与当前 DSH 版本对齐。\n\n' +
      '建议先关闭 DeepSeek Harness，避免文件占用导致失败。\n\n继续吗？',
    );
    if (!ok) return;

    btn.disabled = true;
    btn.textContent = '对齐中…';

    try {
      const res = await fetch('/api/repair-dsh', { method: 'POST' });
      const j = await res.json();
      if (!j.started) {
        btn.textContent = j.detail || j.error || '无法开始';
        btn.disabled = false;
        return;
      }
      pollDshRepair();
    } catch (e) {
      btn.textContent = '请求失败';
      btn.disabled = false;
    }
  });

  bar.appendChild(btn);
  parent.appendChild(bar);

  const log = el('pre', 'update-log');
  log.id = 'dshLog';
  log.hidden = true;
  parent.appendChild(log);
}

async function pollDshRepair() {
  const log = $('dshLog');
  const btn = $('btnDshAlign');
  try {
    const res = await fetch('/api/repair-dsh');
    const j = await res.json();

    if (log) {
      log.hidden = false;
      log.textContent = (j.log && j.log.length ? j.log.join('\n') : '等待输出…');
      log.scrollTop = log.scrollHeight;
    }

    if (j.running) {
      setTimeout(pollDshRepair, 1000);
      return;
    }

    if (log) {
      log.textContent +=
        '\n\n' + (j.ok ? '✓ 对齐完成，当前插件 ' + j.resultVersion : '✗ 未成功（退出码 ' + j.exitCode + '）');
    }
    setTimeout(() => load(true), 1200);
  } catch {
    setTimeout(pollDshRepair, 2000);
  }
}

function renderNode(version, compliant, required) {
  clear($('nodeBody'));

  // 版本未知时不要下定论，等 doctor 给出权威结果
  if (!version) {
    setPill($('nodePill'), 'pending', '检测中');
    row($('nodeBody'), 'Node.js', '等待官方自检结果…');
    const req0 = el('div', 'foot-note');
    req0.style.marginTop = '6px';
    req0.textContent = '官方要求 ' + required;
    $('nodeBody').appendChild(req0);
    return;
  }

  setPill($('nodePill'), compliant ? 'ok' : 'warn', compliant ? '符合要求' : '版本偏低');
  const v = el('span', 'mono', version);
  if (!compliant) v.classList.add('is-stale');
  row($('nodeBody'), 'Node.js', v);

  // 版本区间含多段符号，右对齐容易被折断，改为左对齐小字说明
  const req = el('div', 'foot-note');
  req.style.marginTop = '6px';
  req.textContent = '官方要求 ' + required;
  $('nodeBody').appendChild(req);

  if (!compliant) {
    const note = el('div', 'warn-line');
    note.textContent = '当前版本低于 REA 声明的最低版本，实测可运行，但不受官方支持。如需彻底合规，可升级到 Node 24 LTS。';
    $('nodeBody').appendChild(note);
  }
}

/* ---------------- doctor ---------------- */

function renderDoctor(d) {
  if (!d) return;

  if (d.node) {
    renderNode(d.node.version, d.node.compliant, d.node.required);
  }

  clear($('engineBody'));
  const engines = d.engines;

  if (!engines) {
    setPill($('enginePill'), 'fail', '检查失败');
    row($('engineBody'), '问题', d.detail || '无法获取引擎状态');
    if (d.stderr) {
      const note = el('div', 'foot-note');
      note.style.marginTop = '8px';
      note.textContent = d.stderr;
      $('engineBody').appendChild(note);
    }
    renderScope(null);
    renderOverall();
    return;
  }

  const ready = engines.ready || [];
  const missing = engines.missing || [];

  if (ready.length > 0) {
    setPill($('enginePill'), 'ok', ready.length + ' 个就绪');
  } else {
    setPill($('enginePill'), 'info', '未启用');
  }

  if (ready.length > 0) {
    row($('engineBody'), '已就绪', ready.join('、'));
  }
  if (missing.length > 0) {
    const names = missing.map((m) => m.label).join('、');
    row($('engineBody'), '未配置', names, 'muted');
    const note = el('div', 'foot-note');
    note.style.marginTop = '8px';
    note.textContent = '深度引擎用于反编译汇编与伪代码，属可选组件。REA 本身不会自动安装，需自行准备 Hopper / Ghidra / IDA。';
    $('engineBody').appendChild(note);
  }

  renderScope(engines);
  renderOverall();
}

/* ---------------- 能力范围 ---------------- */

function renderScope(engines) {
  clear($('scopeBody'));
  const hasEngine = engines && engines.ready && engines.ready.length > 0;

  if (!state.status || !state.status.cli.ok) {
    setPill($('scopePill'), 'fail', '不可用');
    list($('scopeBody'), [{ text: 'REA 未安装，无可用能力', level: 'warn' }]);
    return;
  }

  setPill($('scopePill'), hasEngine ? 'ok' : 'info', hasEngine ? '全功能' : '仅静态分析');

  list($('scopeBody'), [
    { text: 'JavaScript / Electron 应用结构还原', level: 'ok' },
    { text: '.NET 程序集、APK、Go / Rust 二进制', level: 'ok' },
    { text: '模型文件、IL2CPP、Godot PCK 解析', level: 'ok' },
    { text: '网页抓取与网络流量包分析', level: 'ok' },
  ]);

  if (!hasEngine) {
    const note = el('div', 'warn-line');
    note.textContent = '不可用：需要反编译汇编 / 伪代码的原生二进制深度分析。配置任一深度引擎后解锁。';
    $('scopeBody').appendChild(note);
  }
}

/* ---------------- 版本与更新 ---------------- */

function renderRelease(r) {
  if (!r) return;

  const current = r.current || (state.status && state.status.cli.version) || null;
  $('vCurrent').textContent = current || '未知';
  $('vCurrentMeta').textContent = current ? '本地已安装' : '未检测到安装';

  $('vLatest').textContent = r.latest || '—';
  $('vLatest').classList.remove('is-stale');

  if (!r.latest) {
    setPill($('releasePill'), 'warn', '无法检查');
    $('vLatestMeta').textContent = '上游查询失败';
    $('vArrow').textContent = '·';
  } else if (r.updateAvailable) {
    setPill($('releasePill'), 'warn', '有新版本');
    $('vLatest').classList.add('is-stale');
    $('vArrow').textContent = '↑';
    $('vArrow').style.color = 'var(--warn)';
    $('vLatestMeta').textContent = r.publishedAt ? '发布于 ' + fmtRelative(r.publishedAt) : '来自上游发布';
  } else {
    setPill($('releasePill'), 'ok', '已是最新');
    $('vArrow').textContent = '=';
    $('vLatestMeta').textContent = r.publishedAt ? '发布于 ' + fmtRelative(r.publishedAt) : '与本地一致';
  }

  $('vLink').href = r.releaseUrl || 'https://github.com/morluto/rea/releases';

  const srcMap = { npm: 'npm registry', github: 'GitHub Releases' };
  const parts = [];
  if (r.source) parts.push('数据源：' + (srcMap[r.source] || r.source));
  if (r.current && r.latest) parts.push('本地 ' + r.current + ' / 上游 ' + r.latest);
  $('vSource').textContent = parts.join('　·　');

  const warnBox = $('vWarn');
  if (r.warnings && r.warnings.length) {
    warnBox.hidden = false;
    warnBox.textContent = r.warnings.join('；');
  } else {
    warnBox.hidden = true;
  }

  // 有更新时提供一键更新；命令保留为次要选项
  const fixHolder = $('releaseFix');
  clear(fixHolder);
  if (r.updateAvailable && r.latest) {
    buildUpdateActions(fixHolder, r);
  }
}

/* ---------------- 客户端接入总览 ---------------- */

function renderClients(data) {
  const body = $('clientsBody');
  clear(body);

  if (!data || !data.available) {
    setPill($('clientsPill'), 'pending', '不可用');
    row(body, '原因', (data && data.reason) || '未知');
    return;
  }

  const cs = data.clients || [];
  const configured = cs.filter((c) => c.configured);
  const detected = cs.filter((c) => c.detected && !c.configured);
  const missing = cs.filter((c) => !c.detected);

  setPill($('clientsPill'), 'ok', configured.length + ' 已接入 / ' + cs.length + ' 受支持');

  // 排序：已接入 → 待接入 → 未安装
  const ordered = [...configured, ...detected, ...missing];

  const wrap = el('div', 'client-list');
  for (const c of ordered) {
    const rowEl = el('div', 'client-row');

    const nameWrap = el('span', 'client-name-wrap');
    nameWrap.appendChild(el('span', 'client-name', c.displayName));
    nameWrap.appendChild(el('span', 'client-id mono muted', c.name));
    rowEl.appendChild(nameWrap);

    const right = el('span', 'client-state');

    if (c.configured) {
      right.appendChild(el('span', 'tag tag-ok', '已接入'));
    } else if (c.manual) {
      right.appendChild(el('span', 'tag', '需手动配置'));
    } else if (c.detected) {
      right.appendChild(el('span', 'tag tag-warn', '待接入'));
      const btn = el('button', 'btn-ghost btn-small', '接入');
      btn.type = 'button';
      btn.addEventListener('click', () => startClientSetup(c.name, btn));
      right.appendChild(btn);
    } else {
      right.appendChild(el('span', 'tag tag-muted', '未安装'));
    }

    rowEl.appendChild(right);
    wrap.appendChild(rowEl);
  }
  body.appendChild(wrap);

  const meta = el('div', 'foot-note');
  meta.style.marginTop = '8px';
  meta.textContent =
    '接入动作由 REA 官方 setup 执行（写配置前自行备份）。检查时间 ' +
    new Date(data.checkedAt).toLocaleTimeString('zh-CN', { hour12: false });
  body.appendChild(meta);

  const log = el('pre', 'update-log');
  log.id = 'setupLog';
  log.hidden = true;
  body.appendChild(log);
}

async function startClientSetup(name, btn) {
  const ok = window.confirm(
    '将对 ' + name + ' 执行：rea setup --client ' + name + ' --yes\n\n' +
    'REA 会写入该客户端的 MCP 配置（涉及退出类客户端时会提示先关闭）。\n继续吗？',
  );
  if (!ok) return;

  btn.disabled = true;
  btn.textContent = '接入中…';

  try {
    const res = await fetch('/api/setup-client?client=' + encodeURIComponent(name), {
      method: 'POST',
    });
    const j = await res.json();
    if (!j.started) {
      btn.textContent = j.detail || j.error || '无法开始';
      btn.disabled = false;
      return;
    }
    pollSetup();
  } catch (e) {
    btn.textContent = '请求失败';
    btn.disabled = false;
  }
}

async function pollSetup() {
  const log = $('setupLog');
  try {
    const res = await fetch('/api/setup-client');
    const j = await res.json();

    if (log) {
      log.hidden = false;
      log.textContent = j.log && j.log.length ? j.log.join('\n') : '等待输出…';
      log.scrollTop = log.scrollHeight;
    }

    if (j.running) {
      setTimeout(pollSetup, 1000);
      return;
    }

    if (log) {
      log.textContent += '\n\n' + (j.ok ? '✓ setup 完成' : '✗ 未成功（退出码 ' + j.exitCode + '）');
    }
    setTimeout(() => load(true), 1500);
  } catch {
    setTimeout(pollSetup, 2000);
  }
}

/** 页面刷新时若接入任务仍在跑，恢复轮询。 */
async function restoreSetupState() {
  try {
    const res = await fetch('/api/setup-client');
    const j = await res.json();
    if (j.running) pollSetup();
  } catch {
    /* 忽略 */
  }
}

/* ---------------- 一键修复接入 ---------------- */

function appendRepairButton(parent, label) {
  const bar = el('div', 'update-bar');
  const btn = el('button', 'btn-primary', label);
  btn.type = 'button';

  btn.addEventListener('click', async () => {
    const ok = window.confirm(
      '将把 WorkBuddy 的 REA 接入重写为当前可用版本。\n\n' +
      '修改前会自动备份 mcp.json，完成后需要重启 WorkBuddy 会话才会生效。\n\n继续吗？',
    );
    if (!ok) return;

    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = '处理中…';

    try {
      const res = await fetch('/api/repair-mcp', { method: 'POST' });
      const j = await res.json();
      if (j.ok) {
        btn.textContent = '已修复（重启会话后生效）';
        setTimeout(() => load(true), 900);
      } else {
        btn.textContent = '失败';
        btn.disabled = false;
        const note = el('div', 'warn-line');
        note.textContent = j.error || j.detail || '未知错误';
        parent.appendChild(note);
      }
    } catch (e) {
      btn.textContent = '请求失败';
      btn.disabled = false;
      setTimeout(() => { btn.textContent = original; }, 2000);
    }
  });

  bar.appendChild(btn);
  parent.appendChild(bar);
}

/* ---------------- 一键更新 ---------------- */

let updateTimer = null;

function buildUpdateActions(holder, r) {
  const bar = el('div', 'update-bar');

  const btn = el('button', 'btn-primary', '立即更新到 ' + r.latest);
  btn.type = 'button';
  btn.id = 'btnUpdate';
  btn.addEventListener('click', () => startUpdate(r.latest));
  bar.appendChild(btn);

  const copy = el('button', 'btn-ghost', '复制命令');
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText('rea update');
      copy.textContent = '已复制';
    } catch {
      copy.textContent = '复制失败';
    }
    setTimeout(() => { copy.textContent = '复制命令'; }, 1500);
  });
  bar.appendChild(copy);

  holder.appendChild(bar);

  const log = el('pre', 'update-log');
  log.id = 'updateLog';
  log.hidden = true;
  holder.appendChild(log);
}

function showLog(text) {
  const log = $('updateLog');
  if (!log) return;
  log.hidden = false;
  log.textContent = text;
  log.scrollTop = log.scrollHeight;
}

async function startUpdate(target) {
  const ok = window.confirm(
    '确定更新 REA 到 ' + target + '？\n\n' +
    '更新过程约 1-2 分钟，期间请保持面板窗口开启。\n' +
    '更新完成后需要重启使用 REA 的客户端。'
  );
  if (!ok) return;

  const btn = $('btnUpdate');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '更新中…';
  }
  showLog('正在启动更新…');

  try {
    const res = await fetch('/api/update', { method: 'POST' });
    const j = await res.json();
    if (!j.started) {
      showLog(j.error || j.detail || '无法启动更新');
      if (btn) {
        btn.disabled = false;
        btn.textContent = '立即更新到 ' + target;
      }
      return;
    }
    pollUpdate();
  } catch (e) {
    showLog('请求失败：' + (e.message || e));
    if (btn) btn.disabled = false;
  }
}

async function pollUpdate() {
  if (updateTimer) clearTimeout(updateTimer);
  try {
    const res = await fetch('/api/update');
    const j = await res.json();

    const lines = j.log && j.log.length ? j.log.join('\n') : '等待输出…';
    showLog(lines);

    if (j.running) {
      updateTimer = setTimeout(pollUpdate, 1000);
      return;
    }

    const btn = $('btnUpdate');
    if (btn) {
      btn.disabled = false;
      btn.textContent = j.ok ? '已更新，重新检查' : '重试更新';
    }

    const tail = j.ok
      ? '\n\n✓ 更新完成' + (j.toVersion ? '，当前版本 ' + j.toVersion : '') + '，正在刷新…'
      : '\n\n✗ 更新失败（退出码 ' + j.exitCode + '）';
    showLog(lines + tail);

    setTimeout(() => load(true), j.ok ? 1200 : 0);
  } catch {
    updateTimer = setTimeout(pollUpdate, 2000);
  }
}

/** 页面刷新时若更新仍在进行，恢复轮询，避免看不到进度。 */
async function restoreUpdateState() {
  try {
    const res = await fetch('/api/update');
    const j = await res.json();
    if (j.running) {
      const btn = $('btnUpdate');
      if (btn) {
        btn.disabled = true;
        btn.textContent = '更新中…';
      }
      pollUpdate();
    }
  } catch {
    /* 忽略 */
  }
}

/* ---------------- 加载 ---------------- */

function renderFatal(message) {
  const targets = ['cliBody', 'mcpBody', 'nodeBody', 'engineBody', 'skillBody', 'scopeBody'];
  for (const id of targets) {
    const node = $(id);
    if (node) {
      clear(node);
      row(node, '错误', message);
    }
  }
  setPill($('releasePill'), 'fail', '无法检查');
  $('overall').dataset.level = 'fail';
  $('overallText').textContent = '服务不可用';
}

async function load(force) {
  const btn = $('refresh');
  btn.disabled = true;
  const q = force ? '?force=1' : '';

  const statusP = fetch('/api/status' + q)
    .then((res) => res.json())
    .then((s) => {
      state.status = s;
      renderStatus(s);
      if (s.cli.ok) $('vCurrent').textContent = s.cli.version || '未知';
    })
    .catch((e) => { throw e; });

  const doctorP = fetch('/api/doctor' + q)
    .then((res) => res.json())
    .then((d) => {
      state.doctor = d;
      renderDoctor(d);
    })
    .catch(() => { /* doctor 失败不影响其余卡片 */ });

  const releaseP = fetch('/api/release' + q)
    .then((res) => res.json())
    .then((r) => {
      state.release = r;
      renderRelease(r);
    })
    .catch(() => {
      renderRelease({ current: null, latest: null, warnings: ['更新检查请求失败'] });
    });

  const clientsP = fetch('/api/clients' + q)
    .then((res) => res.json())
    .then((c) => {
      renderClients(c);
    })
    .catch(() => {
      renderClients(null);
    });

  try {
    await statusP;
  } catch (e) {
    renderFatal('无法连接到本地服务：' + (e && e.message ? e.message : e));
  }

  await Promise.allSettled([doctorP, releaseP, clientsP]);

  $('stamp').textContent = '最近检查 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  btn.disabled = false;

  restoreUpdateState();
  restoreSetupState();
}

$('refresh').addEventListener('click', () => load(true));
load(false);
