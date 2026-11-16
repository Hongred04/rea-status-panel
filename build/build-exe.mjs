/**
 * 把状态面板打包成单文件 exe（Node SEA）。
 *
 * 流程：生成 sea-config → 生成注入 blob → 复制本机 node.exe → postject 注入
 * 产物：dist/REA-Panel.exe（自带 Node 运行时，不依赖目标机器是否装了 Node）
 *
 * 用法：node build\build-exe.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const OUT_EXE = path.join(DIST, 'REA-Panel.exe');
const BLOB = path.join(DIST, 'sea-prep.blob');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function step(msg) {
  console.log('\n▸ ' + msg);
}

fs.mkdirSync(DIST, { recursive: true });

// 1. 前端资源必须存在，否则打出来的 exe 会缺界面
const assets = {
  'index.html': 'ui/index.html',
  'style.css': 'ui/style.css',
  'app.js': 'ui/app.js',
};
for (const [name, rel] of Object.entries(assets)) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) throw new Error('缺少前端文件：' + rel);
  console.log('  资源 ' + name.padEnd(12) + (fs.statSync(p).size / 1024).toFixed(1) + ' KB');
}

// 2. sea 配置
step('生成 sea-config.json');
const seaConfig = {
  main: 'server.cjs',
  output: 'dist/sea-prep.blob',
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets,
};
fs.writeFileSync(path.join(ROOT, 'sea-config.json'), JSON.stringify(seaConfig, null, 2) + '\n');

// 3. 生成 blob
step('生成注入 blob');
execSync('node --experimental-sea-config sea-config.json', { cwd: ROOT, stdio: 'inherit' });
if (!fs.existsSync(BLOB)) throw new Error('blob 未生成');
console.log('  blob ' + (fs.statSync(BLOB).size / 1024).toFixed(1) + ' KB');

// 4. 复制运行时
step('复制 Node 运行时作为 exe 基础');
console.log('  来源 ' + process.execPath);
if (fs.existsSync(OUT_EXE)) fs.rmSync(OUT_EXE);
fs.copyFileSync(process.execPath, OUT_EXE);

// 5. 注入
step('注入 blob 到 exe');
execSync(
  `npx --yes postject "${OUT_EXE}" NODE_SEA_BLOB "${BLOB}" --sentinel-fuse ${FUSE}`,
  { cwd: ROOT, stdio: 'inherit' },
);

/**
 * 把 PE 子系统改为 GUI(2)，双击时不再弹出控制台窗口。
 * 日志改由服务写入 %LOCALAPPDATA%\REA-Panel\panel.log。
 */
function setWindowsGuiSubsystem(exePath) {
  const fd = fs.openSync(exePath, 'r+');
  try {
    const head = Buffer.alloc(0x400);
    fs.readSync(fd, head, 0, head.length, 0);

    const peOff = head.readUInt32LE(0x3c);
    if (head.readUInt32LE(peOff) !== 0x00004550) throw new Error('不是有效的 PE 文件');

    const optOff = peOff + 24; // PE 签名(4) + COFF 头(20)
    const magic = head.readUInt16LE(optOff);
    if (magic !== 0x10b && magic !== 0x20b) throw new Error('未知的 PE 可选头格式');

    const subOff = optOff + 68; // PE32 与 PE32+ 的 Subsystem 都在此偏移
    const before = head.readUInt16LE(subOff);
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(2, 0); // 2 = WINDOWS_GUI
    fs.writeSync(fd, buf, 0, 2, subOff);
    return before;
  } finally {
    fs.closeSync(fd);
  }
}

step('改为 GUI 子系统（双击不弹控制台）');
if (process.platform === 'win32') {
  const before = setWindowsGuiSubsystem(OUT_EXE);
  console.log('  Subsystem: ' + before + ' → 2');
} else {
  console.log('  非 Windows 平台，跳过');
}

// 6. 收尾
if (fs.existsSync(BLOB)) fs.rmSync(BLOB);

const mb = (fs.statSync(OUT_EXE).size / 1024 / 1024).toFixed(1);
console.log('\n完成：' + OUT_EXE + '  (' + mb + ' MB)');
console.log('提示：未签名 exe 首次运行可能触发 SmartScreen，需点「更多信息 → 仍要运行」。');
