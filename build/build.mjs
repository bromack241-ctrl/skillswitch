// 一键构建：把 src/ 打成单文件 SkillSwitch.exe（Node SEA）
// 用法：node build/build.mjs [--node <node.exe>]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');
const work = path.join(root, 'build', '.work');

const argv = process.argv.slice(2);
const nodeArg = argv.indexOf('--node');
const nodeExe = nodeArg >= 0 ? path.resolve(argv[nodeArg + 1]) : process.execPath;

for (const d of [dist, work]) fs.mkdirSync(d, { recursive: true });

// 1) 生成 bundle：把 index.html 内联进 server.js
const serverSrc = fs.readFileSync(path.join(src, 'server.js'), 'utf8');
if (/^const EMBEDDED_INDEX_HTML/m.test(serverSrc)) {
  throw new Error('server.js 里已经存在 EMBEDDED_INDEX_HTML 声明，请先移除');
}
const html = fs.readFileSync(path.join(src, 'public', 'index.html'), 'utf8');
const bundlePath = path.join(work, 'app.bundle.js');
fs.writeFileSync(bundlePath, `const EMBEDDED_INDEX_HTML = ${JSON.stringify(html)};\n` + serverSrc, 'utf8');
console.log('bundle  ->', bundlePath, fs.statSync(bundlePath).size, 'bytes');

// 2) 生成 SEA blob
const blobPath = path.join(work, 'sea-prep.blob');
const seaConfig = path.join(work, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: bundlePath,
  output: blobPath,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false
}, null, 2), 'utf8');

const gen = spawnSync(nodeExe, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });
if (gen.status !== 0) throw new Error('生成 SEA blob 失败');
console.log('blob    ->', blobPath, fs.statSync(blobPath).size, 'bytes');

// 3) 以 node.exe 为壳，注入 blob
const outExe = path.join(dist, 'SkillSwitch.exe');
fs.copyFileSync(nodeExe, outExe);

const { inject } = require('postject');
await inject(outExe, 'NODE_SEA_BLOB', fs.readFileSync(blobPath), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
});

// 换掉 Node 默认图标（否则任务栏/资源管理器显示的是 Node.js 的绿色图标）
const icoPath = path.join(root, 'build', 'icon', 'icon.ico');
if (fs.existsSync(icoPath)) {
  try {
    const ResEdit = require('resedit');
    const nt = ResEdit.NtExecutable.from(fs.readFileSync(outExe), { ignoreCert: true });
    const res = ResEdit.NtExecutableResource.from(nt);
    const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries, 1, 1033, iconFile.icons.map(i => i.data)
    );
    res.outputResource(nt);
    fs.writeFileSync(outExe, Buffer.from(nt.generate()));
    console.log('icon    -> embedded', iconFile.icons.length, 'sizes');
  } catch (e) {
    console.warn('icon    -> 跳过（' + e.message + '）');
  }
}
console.log('exe     ->', outExe, fs.statSync(outExe).size, 'bytes');

// 4) 把 PE 子系统从 CUI(3) 改成 GUI(2)：双击时不弹控制台黑框
function patchSubsystem(file, subsystem) {
  const fd = fs.openSync(file, 'r+');
  try {
    const head = Buffer.alloc(0x200);
    fs.readSync(fd, head, 0, head.length, 0);
    const peOff = head.readUInt32LE(0x3c);
    const magic = head.readUInt16LE(peOff + 4 + 20);
    if (magic !== 0x20b && magic !== 0x10b) throw new Error('不是有效的 PE 文件');
    const subOff = peOff + 4 + 20 + 68;
    const before = Buffer.alloc(2);
    fs.readSync(fd, before, 0, 2, subOff);
    fs.writeSync(fd, Buffer.from([subsystem & 0xff, (subsystem >> 8) & 0xff]), 0, 2, subOff);
    return before.readUInt16LE(0);
  } finally {
    fs.closeSync(fd);
  }
}
const prevSub = patchSubsystem(outExe, 2);
console.log('subsystem:', prevSub, '-> 2 (WINDOWS_GUI，无控制台)');
