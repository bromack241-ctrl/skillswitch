'use strict';
// 打包版由 build/build.mjs 在本文件前注入 const EMBEDDED_INDEX_HTML = "...";
// 直接 node src/server.js 运行时该常量不存在，会回退读取 src/public/index.html。


try { process.stdout.on('error', function () {}); process.stderr.on('error', function () {}); } catch (e) {}

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');
// 统一关掉子进程的控制台窗口：GUI 子系统下 powershell/taskkill/netstat 会各闪一个黑框
const exec = (cmd, opts, cb) => {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  return childProcess.exec(cmd, Object.assign({ windowsHide: true }, opts || {}), cb);
};
const execSync = (cmd, opts) => childProcess.execSync(cmd, Object.assign({ windowsHide: true }, opts || {}));
const tls = require('tls');
const net = require('net');

function isSea() {
  try { return require('node:sea').isSea(); } catch (e) { return false; }
}
const APP_DIR = isSea() ? path.dirname(process.execPath) : __dirname;
function getUserDataDir() {
  try {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const dir = path.join(base, 'SkillSwitch');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (e) { return APP_DIR; }
}
const DATA_DIR = isSea() ? getUserDataDir() : APP_DIR;
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LOG_FILE = path.join(DATA_DIR, 'skill-switch.log');
let manualProxy = null;
const INSTALLED_FILE = path.join(DATA_DIR, 'installed.json');
let installedRepos = {};
function loadInstalled() {
  try { installedRepos = JSON.parse(fs.readFileSync(INSTALLED_FILE, 'utf8').replace(/^\uFEFF/, '')) || {}; } catch (e) { installedRepos = {}; }
  return installedRepos;
}
function saveInstalled() {
  try { fs.writeFileSync(INSTALLED_FILE, JSON.stringify(installedRepos, null, 2), 'utf8'); } catch (e) {}
}
function allSkillDirs(cfg) {
  const dirs = [];
  for (const a of (cfg.agents || [])) for (const d of (a.skillDirs || [])) dirs.push(path.normalize(expandTilde(d)));
  for (const proj of (cfg.projects || [])) for (const a of (cfg.agents || [])) for (const rel of (a.projectSkillDirs || [])) dirs.push(path.normalize(path.join(expandTilde(proj), rel)));
  return dirs;
}
function isRepoInstalled(cfg, repoFullName) {
  const rec = installedRepos[repoFullName];
  if (!rec || !rec.skills || !rec.skills.length) return false;
  if (rec.target) {
    try {
      if (rec.skills.some(s => fs.existsSync(path.join(rec.target, s)))) return true;
    } catch (e) {}
  }
  const dirs = allSkillDirs(cfg);
  for (const s of rec.skills) {
    for (const d of dirs) { if (fs.existsSync(path.join(d, s))) return true; }
  }
  return false;
}
loadInstalled();

/* ---------- 版本 / 图标 ---------- */
const APP_ID = 'skillswitch';
const APP_VERSION = '1.7.0';

/* ---------- 安全：本地访问令牌 ---------- */
const TOKEN_FILE = path.join(DATA_DIR, 'token.txt');
function loadOrCreateToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (/^[a-f0-9]{32}$/i.test(t)) return t;
  } catch (e) {}
  let t = '';
  try { t = require('crypto').randomBytes(16).toString('hex'); } catch (e) { t = String(Date.now()) + String(Math.random()).slice(2); }
  try { fs.writeFileSync(TOKEN_FILE, t, 'utf8'); } catch (e) {}
  return t;
}
const API_TOKEN = loadOrCreateToken();

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !a.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];
function isLoopbackHost(h) {
  return LOOPBACK_HOSTS.indexOf(String(h || '').toLowerCase()) >= 0;
}
function hostHeaderAllowed(boundHost, hostHeader) {
  const name = String(hostHeader || '').toLowerCase().replace(/:\d+$/, '');
  if (isLoopbackHost(boundHost)) return isLoopbackHost(name);
  return true;
}

const DEFAULT_CONFIG = {
  port: 8756,
  host: '127.0.0.1',
  agents: [
    { id: 'codex', name: 'Codex', skillDirs: ['~/.codex/skills', '~/.agents/skills'] },
    { id: 'claude', name: 'Claude Code', skillDirs: ['~/.claude/skills'], projectSkillDirs: ['.claude/skills'] },
    { id: 'workbuddy', name: 'Work Buddy', skillDirs: ['~/.workbuddy/skills', '~/.codebuddy/skills'], projectSkillDirs: ['.workbuddy/skills', '.codebuddy/skills'] },
    { id: 'dsh', name: 'DSH', skillDirs: ['~/.dsh/skills', '~/.agents/skills'], projectSkillDirs: ['.dsh/skills'] }
  ],
  projects: [],
  github: {
    enabled: true,
    rankingQuery: 'skills topic:agent-skills',
    rankingLimit: 12,
    cacheMinutes: 10,
    sourceUrl: '',
    proxy: ''
  }
};

const DEFAULT_MUST_LIST = [
  { full_name: 'anthropics/skills', name: 'anthropics/skills', description: 'Anthropic 官方 Agent Skills 库（文档处理、数据分析等）', html_url: 'https://github.com/anthropics/skills', stars: null },
  { full_name: 'obra/superpowers', name: 'superpowers', description: 'Claude Code 超级工作流技能包（TDD / 重构 / 规划）', html_url: 'https://github.com/obra/superpowers', stars: null },
  { full_name: 'ComposioHQ/awesome-claude-skills', name: 'awesome-claude-skills', description: '最大的 Claude Skills 精选合集（分类导航）', html_url: 'https://github.com/ComposioHQ/awesome-claude-skills', stars: null },
  { full_name: 'obra/superpowers-skills', name: 'superpowers-skills', description: '社区可编辑的 superpowers 技能库', html_url: 'https://github.com/obra/superpowers-skills', stars: null }
];

function expandTilde(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function loadConfig() {
  let cfg;
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
    cfg = JSON.parse(raw);
  } catch (e) {
    cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf8'); } catch (_) {}
  }
  if (!Array.isArray(cfg.agents) || cfg.agents.length === 0) cfg.agents = JSON.parse(JSON.stringify(DEFAULT_CONFIG.agents));
  if (!Number.isInteger(cfg.port)) cfg.port = DEFAULT_CONFIG.port;
  if (typeof cfg.host !== 'string' || !cfg.host) cfg.host = DEFAULT_CONFIG.host;
  if (!Array.isArray(cfg.projects)) cfg.projects = [];
  if (!cfg.github || typeof cfg.github !== 'object') cfg.github = JSON.parse(JSON.stringify(DEFAULT_CONFIG.github));
  manualProxy = (cfg.github && typeof cfg.github.proxy === 'string' && cfg.github.proxy.trim()) ? cfg.github.proxy.trim() : null;
  return cfg;
}

function saveConfig(cfg) {
  let prev = { agents: [] };
  try { prev = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '')) || { agents: [] }; } catch (e) {}
  const prevById = new Map((prev.agents || []).filter(a => a && a.id).map(a => [a.id, a]));
  const clean = {
    // 端口/监听地址未提交时沿用磁盘旧值，避免"保存设置"把改过的端口悄悄重置回默认值
    port: Number.isInteger(cfg.port) ? cfg.port : (Number.isInteger(prev.port) ? prev.port : DEFAULT_CONFIG.port),
    host: (typeof cfg.host === 'string' && cfg.host) ? cfg.host : (typeof prev.host === 'string' && prev.host ? prev.host : DEFAULT_CONFIG.host),
    agents: [],
    projects: [],
    github: {
      enabled: !(cfg.github && cfg.github.enabled === false),
      rankingQuery: (cfg.github && typeof cfg.github.rankingQuery === 'string' && cfg.github.rankingQuery) ? cfg.github.rankingQuery : DEFAULT_CONFIG.github.rankingQuery,
      rankingLimit: Number.isInteger(cfg.github && cfg.github.rankingLimit) ? cfg.github.rankingLimit : DEFAULT_CONFIG.github.rankingLimit,
      cacheMinutes: Number.isInteger(cfg.github && cfg.github.cacheMinutes) ? cfg.github.cacheMinutes : DEFAULT_CONFIG.github.cacheMinutes,
      sourceUrl: (cfg.github && typeof cfg.github.sourceUrl === 'string' && cfg.github.sourceUrl) ? cfg.github.sourceUrl : '',
      proxy: (cfg.github && typeof cfg.github.proxy === 'string' && cfg.github.proxy) ? cfg.github.proxy.trim() : ''
    }
  };
  for (const a of (cfg.agents || [])) {
    if (!a || typeof a.id !== 'string' || !a.id.trim()) continue;
    const dirs = (Array.isArray(a.skillDirs) ? a.skillDirs : []).filter(d => typeof d === 'string' && d.trim()).map(d => d.trim());
    // 兼容旧前端：未提交 projectSkillDirs 时沿用磁盘上的旧值，避免一次保存就清空项目级目录
    const prevAgent = prevById.get(a.id.trim());
    const rawProj = Array.isArray(a.projectSkillDirs)
      ? a.projectSkillDirs
      : (prevAgent && Array.isArray(prevAgent.projectSkillDirs) ? prevAgent.projectSkillDirs : []);
    const projDirs = rawProj.filter(d => typeof d === 'string' && d.trim()).map(d => d.trim());
    clean.agents.push({ id: a.id.trim(), name: (a.name || a.id).trim(), skillDirs: dirs, projectSkillDirs: projDirs });
  }
  for (const p of (cfg.projects || [])) {
    if (typeof p === 'string' && p.trim()) clean.projects.push(p.trim());
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  try { recommendCache = { time: 0, value: null }; } catch (e) {}
  return clean;
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    try {
      const st = fs.statSync(LOG_FILE);
      if (st.size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    } catch (e) {}
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (_) {}
}

function parseFrontmatter(text) {
  const m = {};
  const lines = String(text).split(/\r?\n/);
  if (!lines[0] || lines[0].trim() !== '---') return m;
  let currentKey = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const idx = line.indexOf(':');
    if (idx > 0 && line[0] !== ' ' && line[0] !== '\t') {
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      m[key] = value;
      currentKey = key;
    } else if (currentKey && (line.startsWith(' ') || line.startsWith('\t')) && line.trim()) {
      m[currentKey] = (m[currentKey] ? m[currentKey] + ' ' : '') + line.trim();
    }
  }
  return m;
}

function scanOneDir(rawDir, extra) {
  const dir = path.normalize(expandTilde(rawDir));
  const entry = Object.assign({ path: rawDir, resolved: dir, exists: false, error: null, skills: [] }, extra || {});
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
    entry.exists = true;
  } catch (e) {
    entry.error = e.code === 'ENOENT' ? '目录不存在' : String(e.message || e.code);
    return entry;
  }
  function readMeta(filePath) {
    const out = { title: null, description: null, error: null };
    try {
      const fm = parseFrontmatter(fs.readFileSync(filePath, 'utf8'));
      if (fm.name) out.title = fm.name;
      if (fm.description) out.description = fm.description;
    } catch (e) {
      out.error = '读取元信息失败: ' + String(e.message || e.code);
    }
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.')) continue;
    const skillPath = path.join(dir, ent.name);
    const skill = { name: ent.name, dir: skillPath, enabled: null, title: null, description: null, error: null, flat: false };
    let files;
    try {
      files = fs.readdirSync(skillPath);
    } catch (e) {
      skill.error = '无法读取: ' + String(e.message || e.code);
      entry.skills.push(skill);
      continue;
    }
    const hasMd = files.some(f => f.toLowerCase() === 'skill.md');
    const hasDisabled = files.some(f => f.toLowerCase() === 'skill.md.disabled');
    if (!hasMd && !hasDisabled) continue;
    skill.enabled = hasMd;
    const fmFile = files.find(f => f.toLowerCase() === (hasMd ? 'skill.md' : 'skill.md.disabled'));
    if (fmFile) {
      const meta = readMeta(path.join(skillPath, fmFile));
      skill.title = meta.title;
      skill.description = meta.description;
      if (meta.error) skill.error = meta.error;
    }
    entry.skills.push(skill);
  }
  // 平铺技能：<root>/<name>.md 与 <root>/<name>.md.disabled
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const lower = ent.name.toLowerCase();
    let base = null, enabled = null;
    if (lower.endsWith('.md.disabled')) { base = ent.name.slice(0, ent.name.length - 12); enabled = false; }
    else if (lower.endsWith('.md')) { base = ent.name.slice(0, ent.name.length - 3); enabled = true; }
    if (!base || base.toLowerCase() === 'skill') continue;
    const filePath = path.join(dir, ent.name);
    const meta = readMeta(filePath);
    entry.skills.push({ name: base, dir: filePath, enabled, title: meta.title, description: meta.description, error: meta.error, flat: true });
  }
  entry.skills.sort((a, b) => a.name.localeCompare(b.name));
  return entry;
}

function scanSkills(cfg) {
  const agents = [];
  const projects = (cfg.projects || []).map(expandTilde);
  for (const agent of cfg.agents) {
    const item = { id: agent.id, name: agent.name || agent.id, skillDirs: [] };
    for (const d of (agent.skillDirs || [])) {
      item.skillDirs.push(scanOneDir(d, { kind: 'user' }));
    }
    for (const proj of projects) {
      for (const rel of (agent.projectSkillDirs || [])) {
        item.skillDirs.push(scanOneDir(path.join(proj, rel), { kind: 'project', project: proj, rel: rel }));
      }
    }
    agents.push(item);
  }
  return agents;
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function renameSkill(dir, skillName, enable) {
  if (typeof skillName !== 'string' || !/^[^\\/:*?"<>|]+$/.test(skillName) || skillName === '.' || skillName === '..') {
    return { ok: false, error: '非法的技能名称' };
  }
  const skillPath = path.join(dir, skillName);
  if (!isInside(skillPath, dir)) return { ok: false, error: '非法路径' };
  if (!fs.existsSync(skillPath)) {
    // 平铺技能：<dir>/<name>.md 或 <dir>/<name>.md.disabled
    const flatMd = skillPath + '.md';
    const flatDis = skillPath + '.md.disabled';
    const hasMd = fs.existsSync(flatMd);
    const hasDis = fs.existsSync(flatDis);
    if (!hasMd && !hasDis) return { ok: false, error: '未找到该技能' };
    try {
      if (enable) {
        if (hasMd) return { ok: true, changed: false, state: 'enabled', message: '已是启用状态' };
        fs.renameSync(flatDis, flatMd);
        log('启用: ' + flatMd);
        return { ok: true, changed: true, state: 'enabled', message: '已启用' };
      }
      if (hasDis) return { ok: true, changed: false, state: 'disabled', message: '已是禁用状态' };
      fs.renameSync(flatMd, flatDis);
      log('禁用: ' + flatDis);
      return { ok: true, changed: true, state: 'disabled', message: '已禁用' };
    } catch (e) {
      return { ok: false, error: '操作失败: ' + String(e.message || e.code) };
    }
  }
  try {
    if (fs.lstatSync(skillPath).isSymbolicLink()) {
      return { ok: false, error: '该技能是符号链接／目录联接，为避免改到链接目标，已跳过' };
    }
  } catch (e) {
    return { ok: false, error: '无法访问技能目录: ' + String(e.message || e.code) };
  }
  let actualMd = null, actualDis = null;
  try {
    for (const f of fs.readdirSync(skillPath)) {
      const l = f.toLowerCase();
      if (l === 'skill.md') actualMd = f;
      else if (l === 'skill.md.disabled') actualDis = f;
    }
  } catch (e) {
    return { ok: false, error: '无法读取技能目录: ' + String(e.message || e.code) };
  }
  try {
    if (enable) {
      if (actualMd) return { ok: true, changed: false, state: 'enabled', message: '已是启用状态' };
      if (!actualDis) return { ok: false, error: '未找到 SKILL.md.disabled' };
      fs.renameSync(path.join(skillPath, actualDis), path.join(skillPath, 'SKILL.md'));
      log('启用: ' + path.join(dir, skillName));
      return { ok: true, changed: true, state: 'enabled', message: '已启用' };
    } else {
      if (actualDis) return { ok: true, changed: false, state: 'disabled', message: '已是禁用状态' };
      if (!actualMd) return { ok: false, error: '未找到 SKILL.md' };
      fs.renameSync(path.join(skillPath, actualMd), path.join(skillPath, 'SKILL.md.disabled'));
      log('禁用: ' + path.join(dir, skillName));
      return { ok: true, changed: true, state: 'disabled', message: '已禁用' };
    }
  } catch (e) {
    return { ok: false, error: '操作失败: ' + String(e.message || e.code) };
  }
}

function toggleSkill(cfg, dirInput, skillName, enable) {
  const targetDir = path.normalize(expandTilde(dirInput));
  let found = false;
  for (const agent of cfg.agents) {
    for (const d of (agent.skillDirs || [])) {
      if (path.normalize(expandTilde(d)) === targetDir) { found = true; break; }
    }
    if (!found) {
      for (const proj of (cfg.projects || [])) {
        for (const rel of (agent.projectSkillDirs || [])) {
          if (path.normalize(path.join(expandTilde(proj), rel)) === targetDir) { found = true; break; }
        }
        if (found) break;
      }
    }
    if (found) break;
  }
  if (!found) return { ok: false, error: '未在配置中找到该技能目录' };
  return renameSkill(targetDir, skillName, enable);
}

function batchToggle(cfg, agentId, enable) {
  const agents = scanSkills(cfg);
  const agent = agents.find(a => a.id === agentId);
  if (!agent) return { ok: false, error: '未找到该智能体' };
  let changed = 0, errors = [];
  for (const d of agent.skillDirs) {
    for (const s of d.skills) {
      if (s.enabled === null || s.enabled === enable) continue;
      const r = renameSkill(d.resolved, s.name, enable);
      if (r.ok && r.changed) changed++;
      else if (!r.ok) errors.push(s.name + ': ' + r.error);
    }
  }
  return { ok: true, changed, errors };
}

/* ---------- GitHub 搜索与安装 ---------- */
function validateRepo(s) {
  return typeof s === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s);
}

/* ---------- 删除到回收站（失败回落到直接删除） ---------- */
function recyclePath(p) {
  return new Promise((resolve) => {
    let script;
    try {
      const lines = [
        'Add-Type -AssemblyName Microsoft.VisualBasic',
        '$ok = $true',
        'try {',
        "  $p = '" + String(p).replace(/'/g, "''") + "'",
        '  if (Test-Path -LiteralPath $p -PathType Container) {',
        "    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin')",
        '  } else {',
        "    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin')",
        '  }',
        '} catch { [Console]::Error.Write($_.Exception.Message); $ok = $false }',
        '[Console]::Out.Write($ok)'
      ];
      const tmp = path.join(os.tmpdir(), 'skillswitch-recycle-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.ps1');
      fs.writeFileSync(tmp, '\uFEFF' + lines.join('\n'), 'utf8');
      exec('powershell -NoProfile -ExecutionPolicy Bypass -File "' + tmp + '"', { timeout: 60000 }, (err, stdout) => {
        try { fs.unlinkSync(tmp); } catch (e) {}
        if (err) return resolve(false);
        resolve(String(stdout || '').trim().toLowerCase() === 'true');
      });
    } catch (e) {
      resolve(false);
    }
  });
}

function httpsGetBuffer(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('无效 URL')); }
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'skill-switch-app', 'Accept': 'application/zip', 'Accept-Encoding': 'identity' },
      timeout: timeoutMs || 60000
    };
    const proxy = getProxy();
    if (proxy) opts.agent = makeProxyAgent(proxy, u.hostname, Number(u.port) || 443);
    const req = https.request(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpsGetBuffer(res.headers.location, timeoutMs));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('下载失败 HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
    req.end();
  });
}

function extractZip(buf, destDir) {
  const zlib = require('zlib');
  if (buf.length < 22) throw new Error('zip 文件过小');
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true });
  let totalDeclared = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    totalDeclared += uncompSize;
    if (uncompSize > 64 * 1024 * 1024 || totalDeclared > 256 * 1024 * 1024) {
      throw new Error('压缩包解压后体积超过上限，已中止（可能是异常仓库）');
    }
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('zip 本地头损坏');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.slice(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = comp;
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw new Error('不支持的 zip 压缩方式: ' + method);
    const outPath = path.resolve(root, name);
    if (outPath !== root && !outPath.startsWith(root + path.sep)) continue;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, data);
  }
}

function gitClone(repoFullName, dest) {
  const url = 'https://github.com/' + repoFullName + '.git';
  let proxyArgs = '';
  const proxy = getProxy();
  if (proxy) proxyArgs = ' -c http.proxy=' + proxy.origin + ' -c https.proxy=' + proxy.origin;
  return new Promise((resolve, reject) => {
    exec('git clone --depth 1 --quiet' + proxyArgs + ' ' + url + ' "' + dest + '"', { timeout: 180000 }, (err, stdout, stderr) => {
      if (err) reject(new Error('git clone 失败: ' + String(stderr || err.message || err).slice(0, 300)));
      else resolve();
    });
  });
}

function findSkillDirs(root, maxDepth) {
  const results = [];
  function walk(dir, d) {
    if (d > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    const hasSkill = entries.some(e => e.isFile() && e.name.toLowerCase() === 'skill.md');
    if (hasSkill) { results.push(dir); return; }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) walk(path.join(dir, e.name), d + 1);
    }
  }
  walk(root, 0);
  return results;
}

function skillDirName(sd) {
  let name = path.basename(sd).replace(/-(HEAD|main|master)$/i, '');
  try {
    const fm = parseFrontmatter(fs.readFileSync(path.join(sd, 'SKILL.md'), 'utf8'));
    if (fm.name && /^[A-Za-z0-9._-]+$/.test(fm.name)) name = fm.name;
  } catch (e) {}
  return name;
}

async function installSkill(cfg, repoFullName, agentId) {
  if (!validateRepo(repoFullName)) return { ok: false, error: '仓库名格式不正确（应为 用户名/仓库名）' };
  const agent = (cfg.agents || []).find(a => a.id === agentId);
  if (!agent) return { ok: false, error: '未找到目标智能体' };
  const dirs = (agent.skillDirs || []).map(expandTilde);
  if (!dirs.length) return { ok: false, error: '该智能体没有配置技能目录' };
  let target = null;
  for (const d of dirs) {
    try { fs.mkdirSync(d, { recursive: true }); target = d; break; } catch (e) {}
  }
  if (!target) return { ok: false, error: '无法写入该智能体的技能目录' };
  const rec = installedRepos[repoFullName];
  if (rec && rec.skills && rec.skills.length) {
    const allExist = rec.skills.every(s => fs.existsSync(path.join(target, s)));
    if (allExist) {
      return { ok: true, installed: [], skipped: rec.skills.slice(), target, count: 0, alreadyInstalled: true };
    }
  }
  try {
    const info = await race(httpsGetJson('https://api.github.com/repos/' + repoFullName, 5000), 6000);
    const sizeKB = info && info.size;
    if (sizeKB && sizeKB > 51200) {
      return { ok: false, error: '该仓库体积过大（约 ' + Math.round(sizeKB / 1024) + ' MB），不适合直接安装（可能不是技能仓库）' };
    }
  } catch (e) {}
  const tmp = path.join(os.tmpdir(), 'skill-switch-' + Date.now());
  try {
    const zipUrl = 'https://codeload.github.com/' + repoFullName + '/zip/HEAD';
    const zip = await race(httpsGetBuffer(zipUrl, 90000), 120000);
    fs.mkdirSync(tmp, { recursive: true });
    extractZip(zip, tmp);
    const skillDirs = findSkillDirs(tmp, 6);
    if (!skillDirs.length) return { ok: false, error: '该仓库中未找到技能（没有 SKILL.md）' };
    const installed = [];
    const skipped = [];
    const failed = [];
    const names = [];
    for (const sd of skillDirs) {
      const name = skillDirName(sd);
      names.push(name);
      const dest = path.join(target, name);
      if (fs.existsSync(dest)) { skipped.push(name); continue; }
      try {
        fs.cpSync(sd, dest, { recursive: true });
        installed.push(name);
      } catch (e) {
        failed.push({ name, error: String(e.message || e.code) });
        try { if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}
      }
    }
    installedRepos[repoFullName] = { at: new Date().toISOString(), target, skills: names };
    saveInstalled();
    recommendCache = { time: 0, value: null };
    log('安装技能: ' + repoFullName + ' -> ' + target + ' (新增: ' + (installed.join(', ') || '无') + '; 已存在跳过: ' + (skipped.join(', ') || '无') + (failed.length ? '; 失败: ' + failed.map(f => f.name + '(' + f.error + ')').join(', ') : '') + ')');
    return { ok: true, installed, skipped, failed, target, count: installed.length };
  } catch (e) {
    log('安装失败: ' + repoFullName + ' -> ' + String(e.message || e));
    return { ok: false, error: String(e.message || e) };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  }
}

async function deleteSkill(cfg, dirInput, skillName) {
  const targetDir = path.normalize(expandTilde(dirInput));
  let found = false;
  for (const agent of cfg.agents) {
    for (const d of (agent.skillDirs || [])) { if (path.normalize(expandTilde(d)) === targetDir) { found = true; break; } }
    if (!found) {
      for (const proj of (cfg.projects || [])) {
        for (const rel of (agent.projectSkillDirs || [])) {
          if (path.normalize(path.join(expandTilde(proj), rel)) === targetDir) { found = true; break; }
        }
        if (found) break;
      }
    }
    if (found) break;
  }
  if (!found) return { ok: false, error: '未在配置中找到该技能目录' };
  if (typeof skillName !== 'string' || !/^[^\\/:*?"<>|]+$/.test(skillName) || skillName === '.' || skillName === '..') return { ok: false, error: '非法的技能名称' };
  const skillPath = path.join(targetDir, skillName);
  if (!isInside(skillPath, targetDir)) return { ok: false, error: '非法路径' };
  let st = null;
  try { st = fs.lstatSync(skillPath); } catch (e) { st = null; }
  if (!st) {
    // 平铺技能：<dir>/<name>.md 或 <dir>/<name>.md.disabled
    const cand = [skillPath + '.md.disabled', skillPath + '.md'].find(fp => fs.existsSync(fp));
    if (!cand) return { ok: false, error: '未找到该技能' };
    const recycled = await recyclePath(cand);
    if (!recycled) {
      try { fs.rmSync(cand, { force: true }); } catch (e) { return { ok: false, error: '删除失败: ' + String(e.message || e.code) }; }
    }
    log('删除技能: ' + cand + (recycled ? '（回收站）' : ''));
    return { ok: true, deleted: skillName, recycled };
  }
  if (st.isSymbolicLink()) return { ok: false, error: '该技能是符号链接／目录联接，为避免删到链接目标，已跳过' };
  if (st.isFile()) {
    const lower = skillName.toLowerCase();
    if (!lower.endsWith('.md') && !lower.endsWith('.md.disabled')) return { ok: false, error: '该文件不是技能文件' };
    const recycled = await recyclePath(skillPath);
    if (!recycled) {
      try { fs.rmSync(skillPath, { force: true }); } catch (e) { return { ok: false, error: '删除失败: ' + String(e.message || e.code) }; }
    }
    log('删除技能: ' + skillPath + (recycled ? '（回收站）' : ''));
    return { ok: true, deleted: skillName, recycled };
  }
  let files;
  try { files = fs.readdirSync(skillPath); } catch (e) { return { ok: false, error: '无法读取技能目录: ' + String(e.message || e.code) }; }
  const isSkill = files.some(f => { const l = f.toLowerCase(); return l === 'skill.md' || l === 'skill.md.disabled'; });
  if (!isSkill) return { ok: false, error: '该目录不是技能目录（没有 SKILL.md）' };
  const recycled = await recyclePath(skillPath);
  if (!recycled) {
    try { fs.rmSync(skillPath, { recursive: true, force: true }); } catch (e) { return { ok: false, error: '删除失败: ' + String(e.message || e.code) }; }
  }
  log('删除技能: ' + skillPath + (recycled ? '（回收站）' : ''));
  return { ok: true, deleted: skillName, recycled };
}

async function uninstallRepo(cfg, repoFullName) {
  const rec = installedRepos[repoFullName];
  if (!rec || !rec.skills || !rec.skills.length) return { ok: false, error: '没有该仓库的安装记录' };
  const target = path.normalize(expandTilde(rec.target || ''));
  const allowed = new Set(allSkillDirs(cfg).map(d => path.normalize(expandTilde(d))));
  if (!target || !allowed.has(target)) {
    return { ok: false, error: '记录的安装目录已不在当前配置里，请手动删除，或先把该目录加回配置' };
  }
  const removed = [], skipped = [], failed = [];
  let recycledAll = true;
  for (const name of rec.skills) {
    const p = path.join(target, name);
    if (!fs.existsSync(p)) { skipped.push(name); continue; }
    try {
      if (fs.lstatSync(p).isSymbolicLink()) { skipped.push(name); continue; }
      const recycled = await recyclePath(p);
      if (!recycled) { fs.rmSync(p, { recursive: true, force: true }); recycledAll = false; }
      removed.push(name);
    } catch (e) {
      failed.push(name + ': ' + String(e.message || e.code));
    }
  }
  delete installedRepos[repoFullName];
  saveInstalled();
  recommendCache = { time: 0, value: null };
  log('卸载技能: ' + repoFullName + '（移除 ' + removed.length + ' 个，跳过 ' + skipped.length + ' 个）');
  return { ok: true, removed, skipped, failed, target, recycled: recycledAll && removed.length > 0 };
}

/* ---------- MCP / 插件 扫描（只读，第一步先「看得见」） ---------- */
// 极简 TOML 读取：只取「段名 + 段内键值」，够用且不引依赖
function parseTomlLite(text) {
  const sections = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) { cur = { path: sec[1], keys: {} }; sections.push(cur); continue; }
    const kv = /^([A-Za-z0-9_.\-"]+)\s*=\s*(.+)$/.exec(line);
    if (!kv || !cur) continue;
    let val = kv[2].trim();
    if (val.startsWith('"') || val.startsWith("'")) {
      const q = val[0];
      const end = val.indexOf(q, 1);
      if (end > 0) val = val.slice(1, end);
    } else {
      const hash = val.indexOf('#');
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    cur.keys[kv[1]] = val;
  }
  return sections;
}

function scanCodex(home) {
  const dir = path.join(home, '.codex');
  const cfgFile = path.join(dir, 'config.toml');
  const out = { tool: 'Codex', kind: 'codex', dir, exists: fs.existsSync(dir), configFile: cfgFile, mcp: [], plugins: [], marketplaces: [], error: null };
  if (!fs.existsSync(cfgFile)) return out;
  let text;
  try { text = fs.readFileSync(cfgFile, 'utf8'); } catch (e) { out.error = String(e.message || e); return out; }
  for (const s of parseTomlLite(text)) {
    let m;
    if ((m = /^mcp_servers\.(.+)$/.exec(s.path))) {
      const name = m[1].replace(/"/g, '');
      if (name.includes('.')) continue;              // 跳过 .env 之类的子段
      out.mcp.push({ name, command: s.keys.command || '', args: s.keys.args || '', enabled: s.keys.enabled !== 'false' });
    } else if ((m = /^plugins\.(.+)$/.exec(s.path))) {
      out.plugins.push({ name: m[1].replace(/"/g, ''), enabled: s.keys.enabled !== 'false' });
    } else if ((m = /^marketplaces\.(.+)$/.exec(s.path))) {
      out.marketplaces.push({ name: m[1].replace(/"/g, ''), source: s.keys.source || '' });
    }
  }
  return out;
}

function scanDsh(home) {
  const dir = path.join(home, '.dsh', 'profiles', 'desktop');
  const out = { tool: 'DSH', kind: 'dsh', dir, exists: fs.existsSync(dir), configFile: path.join(dir, 'cordis.patch.yml'), bundles: [], packages: [], patches: [], error: null };
  if (!fs.existsSync(dir)) return out;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    out.bundles = ((((pkg.dsh || {}).profile) || {}).bundles || []).map(n => ({ name: n }));
    out.packages = Object.keys(pkg.dependencies || {});
  } catch (e) { out.error = String(e.message || e); }
  try {
    const lines = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = /^-\s*id:\s*(.+)$/.exec(lines[i]);
      if (!m) continue;
      const entry = { id: m[1].trim(), name: '' };
      for (let j = i + 1; j < lines.length && j < i + 5; j++) {
        const n = /^\s+name:\s*(.+)$/.exec(lines[j]);
        if (n) { entry.name = n[1].trim().replace(/^["']|["']$/g, ''); break; }
        if (/^-\s*id:/.test(lines[j])) break;
      }
      out.patches.push(entry);
    }
  } catch (e) {}
  return out;
}

function scanClaude(home) {
  const dir = path.join(home, '.claude');
  const agentsDir = path.join(dir, 'agents');
  const cmdDir = path.join(dir, 'commands');
  const out = { tool: 'Claude Code', kind: 'claude', dir, exists: fs.existsSync(dir), configFile: path.join(dir, 'settings.json'), subagents: [], commands: [], mcp: [], error: null };
  const listMd = (d) => {
    try { return fs.readdirSync(d).filter(f => f.toLowerCase().endsWith('.md')).map(f => f.replace(/\.md$/i, '')); }
    catch (e) { return []; }
  };
  out.subagents = listMd(agentsDir);
  out.commands = listMd(cmdDir);
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    out.mcp = Object.keys(s.mcpServers || {});
  } catch (e) {}
  return out;
}

/* ---------- 悬浮注释：常见 MCP / 插件是干什么的 ---------- */
const DESCRIPTIONS = [
  [/cua_?repl|computer[-_]?use/i, '计算机操作：让 AI 点鼠标、开浏览器、操作桌面'],
  [/node_?repl|node[-_]?repl/i, 'Node 代码执行环境：跑 JS 片段、读写文件'],
  [/filesystem|file[-_]?system/i, '读写本机文件（按你给的目录白名单）'],
  [/memory/i, '长期记忆：跨会话保存事实和偏好'],
  [/fetch/i, '抓取网页内容并转成文本'],
  [/github/i, 'GitHub 仓库操作：issue、PR、代码搜索'],
  [/\bgit\b/i, '本地 git 操作：查看历史、diff、提交'],
  [/puppeteer|playwright|browser/i, '浏览器自动化：打开页面、点击、截图'],
  [/sqlite/i, 'SQLite 数据库查询与写入'],
  [/postgres|postgresql/i, 'PostgreSQL 数据库查询'],
  [/slack/i, '收发 Slack 消息'],
  [/google[-_]?maps/i, '地图与位置查询'],
  [/\btime\b/i, '时间与时区换算'],
  [/sequential[-_]?thinking/i, '分步推理：把复杂问题拆成多步'],
  [/everything/i, '官方示例服务，一般用来测试连通性'],
  [/^pdf$|pdf@/i, 'Codex 官方插件：读写 PDF'],
  [/documents?@|^documents?$/i, 'Codex 官方插件：Word/文档处理'],
  [/spreadsheets?@|^spreadsheets?$/i, 'Codex 官方插件：表格处理'],
  [/presentations?@|^presentations?$/i, 'Codex 官方插件：演示文稿'],
  [/template[-_]?creator/i, 'Codex 官方插件：从模板生成文件'],
  [/dsh-base/i, 'DSH 基础 bundle：核心能力集合'],
  [/dsh-web-app/i, 'DSH Web 界面 bundle'],
  [/dsh-pet|pet\b/i, '第三方插件：桌面宠物'],
  [/agent-default-model/i, 'DSH 补丁：默认用哪个模型'],
  [/agent-preset-registry/i, 'DSH 补丁：可选哪些 agent 预设'],
  [/ui-chat|ui-settings/i, 'DSH 补丁：界面相关配置'],
  [/llm-pi-ai/i, 'DSH 补丁：接入了哪些模型供应商']
];

function describe(name, extra) {
  const hay = String(name || '') + ' ' + String(extra || '');
  for (const [re, text] of DESCRIPTIONS) if (re.test(hay)) return text;
  return '';
}

function scanIntegrations() {
  const home = os.homedir();
  const tools = [scanCodex(home), scanDsh(home), scanClaude(home)];
  for (const t of tools) {
    for (const m of (t.mcp || [])) m.desc = describe(m.name, m.command) || 'MCP 服务（从配置里读到的，用途未知）';
    for (const p of (t.plugins || [])) p.desc = describe(p.name) || '插件（市场提供）';
    for (const b of (t.bundles || [])) b.desc = describe(b) || 'DSH bundle';
    for (const p of (t.patches || [])) p.desc = describe(p.name || p.id) || 'DSH 配置补丁';
  }
  return { home, tools };
}

/* ---------- 配置备份 / 回滚 / 安装 MCP（改配置前必备份） ---------- */
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

function backupFile(file) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, path.basename(file) + '.' + stamp + '.bak');
  fs.copyFileSync(file, dest);
  try {
    const all = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.bak')).sort();
    while (all.length > 20) { fs.unlinkSync(path.join(BACKUP_DIR, all.shift())); }
  } catch (e) {}
  return dest;
}

// 目前只支持 Codex：它把 MCP 放在一个 TOML 里，追加式修改最安全
function integrationTarget(kind) {
  const home = os.homedir();
  if (kind === 'codex') return { kind, label: 'Codex', file: path.join(home, '.codex', 'config.toml') };
  return null;
}

function normalizeRepo(input) {
  let s = String(input || '').trim();
  s = s.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
  const parts = s.split('/');
  if (parts.length < 2) return null;
  const repo = parts[0] + '/' + parts[1];
  return validateRepo(repo) ? repo : null;
}

// 从 README 猜启动命令——只给候选，最终由用户确认
function guessCommands(readme, pkgName) {
  const out = [];
  const JUNK = new Set(['npx', 'uvx', 'docker', 'node', 'run', 'install', 'pull', '-y', '--yes', 'mcp']);
  const push = (label, command, args) => {
    const first = String((args && args[0]) || '').toLowerCase();
    if (!first || JUNK.has(first) || first === command.toLowerCase()) return;   // 丢掉把命令名当包名的垃圾候选
    const key = command + ' ' + args.join(' ');
    if (!out.some(o => (o.command + ' ' + o.args.join(' ')) === key)) out.push({ label, command, args });
  };
  const text = String(readme || '');
  for (const m of text.matchAll(/npx\s+(?:-y\s+|--yes\s+)?(@?[A-Za-z0-9._/-]+)/g)) push('npx', 'npx', ['-y', m[1]]);
  for (const m of text.matchAll(/uvx\s+(?:--from\s+)?([A-Za-z0-9._-]+)/g)) push('uvx', 'uvx', [m[1]]);
  for (const m of text.matchAll(/docker\s+run\s+([^\n`"']{3,120})/g)) push('docker', 'docker', m[1].trim().split(/\s+/));
  if (pkgName && !out.some(o => o.command === 'npx')) push('package.json', 'npx', ['-y', pkgName]);
  return out;
}

async function previewMcpRepo(repoInput) {
  const repo = normalizeRepo(repoInput);
  if (!repo) return { ok: false, error: '看不懂这个仓库地址，应该是 用户名/仓库名 或 GitHub 链接' };

  let readme = '';
  let readmeError = null;
  try {
    const r = await race(httpsGetJson('https://api.github.com/repos/' + repo + '/readme', 8000), 9000);
    readme = Buffer.from(String(r.content || ''), 'base64').toString('utf8');
  } catch (e) { readmeError = friendlyNetError(e); }

  let pkgName = null;
  try {
    const c = await race(httpsGetJson('https://api.github.com/repos/' + repo + '/contents/package.json', 6000), 7000);
    const pkg = JSON.parse(Buffer.from(String(c.content || ''), 'base64').toString('utf8'));
    if (pkg && pkg.name) pkgName = pkg.name;
  } catch (e) {}

  return {
    ok: true,
    repo,
    packageName: pkgName,
    suggestedName: repo.split('/')[1].toLowerCase().replace(/[^a-z0-9_-]/g, '-'),
    candidates: guessCommands(readme, pkgName),
    readmeError,
    hasReadme: !!readme
  };
}

function installMcp(kind, name, command, args) {
  const t = integrationTarget(kind);
  if (!t) return { ok: false, error: '暂不支持这个目标：' + kind };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(name || ''))) {
    return { ok: false, error: 'MCP 名称只能用字母、数字、下划线和短横线（1~64 位）' };
  }
  if (!command || typeof command !== 'string') return { ok: false, error: '缺少启动命令' };
  if (!fs.existsSync(t.file)) return { ok: false, error: '找不到配置文件：' + t.file };
  const list = Array.isArray(args) ? args.map(String) : [];
  if (list.some(a => /[\r\n"]/.test(a))) return { ok: false, error: '参数里不能有换行或引号' };

  const text = fs.readFileSync(t.file, 'utf8');
  const exists = parseTomlLite(text).some(s => s.path === 'mcp_servers.' + name || s.path === 'mcp_servers."' + name + '"');
  if (exists) return { ok: false, error: '已经有一个叫 ' + name + ' 的 MCP 了' };

  const backup = backupFile(t.file);
  const block = '\n[mcp_servers.' + name + ']\n'
    + 'command = ' + JSON.stringify(command) + '\n'
    + 'args = [' + list.map(a => JSON.stringify(a)).join(', ') + ']\n';
  fs.appendFileSync(t.file, block, 'utf8');
  log('安装 MCP: ' + name + ' → ' + t.file + '（备份 ' + path.basename(backup) + '）');
  return { ok: true, file: t.file, backup: path.basename(backup), added: block.trim(), name };
}

// 只改目标段里的 enabled 行；没有就插在段头下面（绝不进子段）
// prefix: 'mcp_servers' 或 'plugins'——两者用同一套算法
function setSectionEnabled(kind, prefix, name, enable, nameRe, label) {
  const t = integrationTarget(kind);
  if (!t) return { ok: false, error: '暂不支持这个目标：' + kind };
  if (!nameRe.test(String(name || ''))) return { ok: false, error: (label || '名称') + '不合法' };
  if (!fs.existsSync(t.file)) return { ok: false, error: '找不到配置文件：' + t.file };

  const text = fs.readFileSync(t.file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const header = (l) => { const m = /^\s*\[(.+)\]\s*$/.exec(l); return m ? m[1].replace(/"/g, '') : null; };
  const path0 = prefix + '.' + name;

  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const p = header(lines[i]);
    if (p === path0) { start = i; continue; }
    if (start >= 0 && p !== null) { end = i; break; }     // 到下一个段头（含子段）为止
  }
  if (start < 0) return { ok: false, error: '配置里没有叫 ' + name + ' 的' + (label || '项目') };

  const want = enable ? 'true' : 'false';
  let changed = null;
  let found = false;
  for (let i = start + 1; i < end; i++) {
    const m = /^(\s*)enabled\s*=\s*(true|false)\s*$/i.exec(lines[i]);
    if (!m) continue;
    found = true;
    const before = lines[i];
    const next = m[1] + 'enabled = ' + want;
    if (before !== next) { lines[i] = next; changed = before.trim() + '  →  ' + next.trim(); }
    break;
  }
  if (!found) {
    lines.splice(start + 1, 0, 'enabled = ' + want);
    changed = '原本没有 enabled 行 → 新增 enabled = ' + want;
  }
  if (!changed) return { ok: true, changed: false, message: '已经是这个状态了', name, enabled: !!enable };

  const backup = backupFile(t.file);
  fs.writeFileSync(t.file, lines.join(eol), 'utf8');
  log('切换 ' + (label || '项目') + ': ' + name + ' enabled=' + want + '（备份 ' + path.basename(backup) + '）');
  return { ok: true, changed, backup: path.basename(backup), name, enabled: !!enable };
}

const NAME_RE_MCP = /^[A-Za-z0-9_-]{1,64}$/;
const NAME_RE_PLUGIN = /^[A-Za-z0-9_.@-]{1,128}$/;

function setMcpEnabled(kind, name, enable) {
  return setSectionEnabled(kind, 'mcp_servers', name, enable, NAME_RE_MCP, 'MCP');
}

function setPluginEnabled(kind, name, enable) {
  return setSectionEnabled(kind, 'plugins', name, enable, NAME_RE_PLUGIN, '插件');
}

// 声明一个插件（必须属于配置里已经声明过的市场）
function installPlugin(kind, name) {
  const t = integrationTarget(kind);
  if (!t) return { ok: false, error: '暂不支持这个目标：' + kind };
  if (!NAME_RE_PLUGIN.test(String(name || ''))) return { ok: false, error: '插件名不合法（形如 名字@市场）' };
  if (!fs.existsSync(t.file)) return { ok: false, error: '找不到配置文件：' + t.file };

  const text = fs.readFileSync(t.file, 'utf8');
  const secs = parseTomlLite(text);
  if (secs.some(s => s.path.replace(/"/g, '') === 'plugins.' + name)) {
    return { ok: false, error: '已经声明过这个插件了：' + name };
  }
  const market = String(name).split('@')[1] || '';
  const markets = secs.map(s => s.path.replace(/"/g, ''))
    .filter(p => p.startsWith('marketplaces.'))
    .map(p => p.slice('marketplaces.'.length));
  if (!market) return { ok: false, error: '插件名要写成 名字@市场，例如 pdf@openai-primary-runtime' };
  if (!markets.includes(market)) {
    return { ok: false, error: '配置里没声明过市场「' + market + '」。已声明的：' + (markets.join(', ') || '（无）') + '。本工具只写配置，不负责下载插件本体。' };
  }

  const backup = backupFile(t.file);
  const block = '\n[plugins."' + name + '"]\nenabled = true\n';
  fs.appendFileSync(t.file, block, 'utf8');
  log('声明插件: ' + name + ' → ' + t.file + '（备份 ' + path.basename(backup) + '）');
  return { ok: true, file: t.file, backup: path.basename(backup), added: block.trim(), name };
}

function listBackups() {
  try { return fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.bak')).sort().reverse(); }
  catch (e) { return []; }
}

// 精确移除一个段（含它的子段如 .env），其余内容逐字节保留
function removeSection(kind, prefix, name, nameRe, label) {
  const t = integrationTarget(kind);
  if (!t) return { ok: false, error: '暂不支持这个目标：' + kind };
  if (!nameRe.test(String(name || ''))) return { ok: false, error: (label || '名称') + '不合法' };
  if (!fs.existsSync(t.file)) return { ok: false, error: '找不到配置文件：' + t.file };

  const text = fs.readFileSync(t.file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const header = (l) => { const m = /^\s*\[(.+)\]\s*$/.exec(l); return m ? m[1].replace(/"/g, '') : null; };
  const isTarget = (p) => p === prefix + '.' + name || p.startsWith(prefix + '.' + name + '.');

  const keep = [];
  const removed = [];
  let i = 0;
  while (i < lines.length) {
    const p = header(lines[i]);
    if (p && isTarget(p)) {
      removed.push(lines[i]); i++;
      while (i < lines.length && header(lines[i]) === null) { removed.push(lines[i]); i++; }
      continue;
    }
    keep.push(lines[i]); i++;
  }
  if (!removed.length) return { ok: false, error: '配置里没有叫 ' + name + ' 的' + (label || '项目') };

  while (keep.length && keep[keep.length - 1].trim() === '') keep.pop();   // 去掉留下的空行
  const next = keep.join(eol).replace(/(\r?\n)+$/, '') + eol;

  const backup = backupFile(t.file);
  fs.writeFileSync(t.file, next, 'utf8');
  log('移除 ' + (label || '项目') + ': ' + name + ' ← ' + t.file + '（备份 ' + path.basename(backup) + '）');
  return {
    ok: true,
    file: t.file,
    backup: path.basename(backup),
    removed: removed.join(eol).replace(/(\r?\n)+$/, ''),
    name
  };
}

function removeMcp(kind, name) {
  return removeSection(kind, 'mcp_servers', name, NAME_RE_MCP, 'MCP');
}

function removePlugin(kind, name) {
  return removeSection(kind, 'plugins', name, NAME_RE_PLUGIN, '插件');
}

function rollbackBackup(backupName) {
  const base = path.basename(String(backupName || ''));
  if (!/\.bak$/.test(base)) return { ok: false, error: '备份文件名不合法' };
  const full = path.join(BACKUP_DIR, base);
  if (!fs.existsSync(full)) return { ok: false, error: '备份不存在' };
  const m = /^(.+?)\.\d{4}-\d{2}-\d{2}T[\d-]+Z\.bak$/.exec(base);
  if (!m) return { ok: false, error: '无法识别这个备份对应哪个文件' };
  const target = path.join(os.homedir(), '.codex', m[1]);
  if (!fs.existsSync(target)) return { ok: false, error: '原文件已不在：' + target };
  const safety = backupFile(target);              // 回滚前再备一次，回滚也能反悔
  fs.copyFileSync(full, target);
  log('回滚配置: ' + target + ' ← ' + base);
  return { ok: true, target, safety: path.basename(safety) };
}

/* ---------- 安装预览 ---------- */
async function previewRepo(repoFullName) {
  if (!validateRepo(repoFullName)) return { ok: false, error: '仓库名格式应为 用户名/仓库名' };
  try {
    const info = await race(httpsGetJson('https://api.github.com/repos/' + repoFullName, 6000), 7000);
    if (info && info.size && info.size > 51200) {
      return { ok: false, error: '该仓库约 ' + Math.round(info.size / 1024) + ' MB，体积过大，可能不是技能仓库' };
    }
  } catch (e) {}
  try {
    const tree = await race(httpsGetJson('https://api.github.com/repos/' + repoFullName + '/git/trees/HEAD?recursive=1', 9000), 10000);
    const skills = ((tree && tree.tree) || [])
      .filter(t => t.type === 'blob' && /(^|\/)SKILL\.md$/i.test(t.path))
      .map(t => {
        const dir = t.path.replace(/\/?SKILL\.md$/i, '');
        const base = dir ? path.basename(dir) : repoFullName.split('/')[1];
        return { dir: dir || '(仓库根目录)', name: base.replace(/-(HEAD|main|master)$/i, '') };
      });
    if (!skills.length) return { ok: false, error: '该仓库里没有 SKILL.md，不是技能仓库' };
    return { ok: true, repo: repoFullName, skills };
  } catch (e) {
    return { ok: false, error: friendlyNetError(e) };
  }
}

/* ---------- GitHub 推荐 ---------- */
function httpsGetJson(url, timeoutMs) {
  return doHttpsGet(url, timeoutMs, true).catch((e1) => {
    if (getProxy()) return doHttpsGet(url, timeoutMs, false);
    throw e1;
  });
}

function doHttpsGet(url, timeoutMs, useProxy) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('无效 URL')); }
    if (u.protocol !== 'https:') return reject(new Error('仅支持 https'));
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { 'User-Agent': 'skill-switch-app', 'Accept': 'application/vnd.github+json', 'Accept-Encoding': 'identity' },
      timeout: timeoutMs || 15000
    };
    const proxy = useProxy ? getProxy() : null;
    if (proxy) opts.agent = makeProxyAgent(proxy, u.hostname, Number(u.port) || 443);
    const req = https.request(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(doHttpsGet(res.headers.location, timeoutMs, useProxy));
      }
      let data = '';
      res.on('data', c => { data += c; if (data.length > 5e6) req.destroy(new Error('响应过大')); });
      res.on('end', () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('JSON 解析失败')); }
        } else {
          reject(new Error('GitHub API ' + res.statusCode));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub 请求超时')));
    req.on('error', reject);
    req.end();
  });
}

function friendlyNetError(e) {
  const s = String(e && e.message ? e.message : e);
  if (/超时|timeout/i.test(s)) return '无法访问 GitHub（连接超时），请检查网络或代理后重试';
  if (/EACCES|ECONNREFUSED|ENOTFOUND|ECONNRESET|socket|network|连接/i.test(s)) return '无法访问 GitHub（网络不可用），请检查网络或代理后重试';
  return 'GitHub 请求失败: ' + s;
}

function race(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('请求超时')), ms))]);
}

let cachedSystemProxy = undefined;
function getSystemProxy() {
  if (cachedSystemProxy !== undefined) return cachedSystemProxy;
  cachedSystemProxy = null;
  try {
    if (process.platform === 'win32') {
      const out = execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"', { encoding: 'utf8', timeout: 5000 });
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out);
      if (enabled) {
        const m = out.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
        if (m) {
          let raw = m[1].trim();
          const parts = raw.split(';');
          let chosen = null;
          for (const pp of parts) { if (/^https=/i.test(pp.trim())) { chosen = pp.trim().replace(/^https=/i, ''); break; } }
          if (!chosen) for (const pp of parts) { if (/^http=/i.test(pp.trim())) { chosen = pp.trim().replace(/^http=/i, ''); break; } }
          if (!chosen) chosen = parts[0].trim();
          if (chosen && !/^https?:\/\//i.test(chosen)) chosen = 'http://' + chosen;
          try { cachedSystemProxy = new URL(chosen); } catch (e) {}
        }
      }
    }
  } catch (e) {}
  return cachedSystemProxy;
}

function getProxy() {
  if (manualProxy) {
    let m = manualProxy;
    if (!/^https?:\/\//i.test(m)) m = 'http://' + m;
    try { const u = new URL(m); if (u.hostname) return u; } catch (e) {}
  }
  const p = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (p) { try { const u = new URL(p); if (u.hostname) return u; } catch (e) {} }
  return getSystemProxy();
}

function makeProxyAgent(proxy, host, port) {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = makeTunnelConnect(proxy, host, port);
  return agent;
}

function makeTunnelConnect(proxy, host, port) {
  return function createConnection(options, cb) {
    const raw = net.connect(Number(proxy.port) || 80, proxy.hostname);
    let buf = '';
    let settled = false;
    const done = (err, s) => { if (!settled) { settled = true; cb(err, s); } };
    raw.on('connect', () => raw.write('CONNECT ' + host + ':' + port + ' HTTP/1.1\r\nHost: ' + host + ':' + port + '\r\n\r\n'));
    raw.on('data', function onData(c) {
      buf += c;
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      raw.removeListener('data', onData);
      const statusLine = (buf.split('\r\n')[0] || '');
      if (statusLine.indexOf('200') < 0) { raw.destroy(); return done(new Error('代理连接失败: ' + statusLine)); }
      const rest = buf.slice(idx + 4);
      if (rest.length) raw.unshift(rest);
      const tlsSocket = tls.connect({ socket: raw, servername: host });
      tlsSocket.on('secureConnect', () => done(null, tlsSocket));
      tlsSocket.on('error', e => done(e));
    });
    raw.on('error', e => done(e));
    raw.setTimeout(20000, () => { raw.destroy(); done(new Error('代理连接超时')); });
  };
}
let recommendCache = { time: 0, value: null };

async function getRecommend(cfg) {
  const gh = cfg.github || {};
  if (gh.enabled === false) return { enabled: false, ranking: [], must: [], error: null };
  const now = Date.now();
  const ttl = (Number.isInteger(gh.cacheMinutes) ? gh.cacheMinutes : 10) * 60 * 1000;
  if (recommendCache.value && now - recommendCache.time < ttl) return recommendCache.value;

  const result = { enabled: true, ranking: [], must: JSON.parse(JSON.stringify(DEFAULT_MUST_LIST)), error: null, fetchedAt: Date.now() };
  result.must.forEach(m => { m.must = true; if (!m.url) m.url = m.html_url; });

  try {
    let items = [];
    if (gh.sourceUrl) {
      const data = await race(httpsGetJson(gh.sourceUrl, 5000), 6000);
      items = (Array.isArray(data) ? data : (data.items || [])).map(it => ({
        name: it.name || it.full_name || '',
        full_name: it.full_name || it.name || '',
        stars: it.stars != null ? it.stars : (it.stargazers_count || 0),
        description: it.description || '',
        url: it.url || it.html_url || '',
        must: false
      }));
    } else {
      const q = encodeURIComponent(gh.rankingQuery || DEFAULT_CONFIG.github.rankingQuery);
      const perPage = Number.isInteger(gh.rankingLimit) ? gh.rankingLimit : DEFAULT_CONFIG.github.rankingLimit;
      const data = await race(httpsGetJson('https://api.github.com/search/repositories?q=' + q + '&sort=stars&order=desc&per_page=' + perPage, 5000), 6000);
      items = (data.items || []).map(it => ({
        name: it.name || it.full_name,
        full_name: it.full_name || '',
        stars: it.stargazers_count || 0,
        description: it.description || '',
        url: it.html_url || '',
        must: false
      }));
    }
    result.ranking = items;
  } catch (e) {
    result.ranking = [];
    result.rankingError = friendlyNetError(e);
  }

  if (result.ranking.length) {
    try {
      const settled = await Promise.allSettled(result.must.map(m => race(httpsGetJson('https://api.github.com/repos/' + m.full_name, 5000), 6000)));
      settled.forEach((s, i) => {
        if (s.status === 'fulfilled' && s.value) {
          result.must[i].stars = s.value.stargazers_count || 0;
          if (s.value.description) result.must[i].description = s.value.description;
          if (s.value.html_url) result.must[i].url = s.value.html_url;
          if (s.value.name) result.must[i].name = s.value.name;
        }
      });
    } catch (e) {}
  }

  const mustNames = new Set(result.must.map(m => m.full_name));
  for (const r of result.ranking) if (mustNames.has(r.full_name)) r.must = true;
  for (const r of result.ranking) r.installed = isRepoInstalled(cfg, r.full_name);
  for (const m of result.must) m.installed = isRepoInstalled(cfg, m.full_name);

  if (!result.ranking.length && result.rankingError) result.error = result.rankingError;
  recommendCache = { time: Date.now(), value: result };
  return result;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e6) { req.destroy(); reject(new Error('请求体过大')); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function getIndexHtml() {
  if (typeof EMBEDDED_INDEX_HTML !== 'undefined' && EMBEDDED_INDEX_HTML) return EMBEDDED_INDEX_HTML;
  return fs.readFileSync(path.join(APP_DIR, 'public', 'index.html'));
}

const server = http.createServer(async (req, res) => {
  let url, p;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch (e) {
    return sendJSON(res, 400, { ok: false, error: '无效请求' });
  }
  p = url.pathname;

  try {
    const cfgForHost = loadConfig();
    if (!hostHeaderAllowed(cfgForHost.host, req.headers.host)) {
      return sendJSON(res, 403, { ok: false, error: '拒绝访问：Host 头不匹配（可能被 DNS rebinding 利用）' });
    }
    if (p === '/api' || p.startsWith('/api/')) {
      const supplied = req.headers['x-ss-token'] || url.searchParams.get('token');
      if (p !== '/api/hello' && !safeEqual(String(supplied || ''), API_TOKEN)) {
        return sendJSON(res, 401, { ok: false, error: '未授权：请用 http://' + cfgForHost.host + ':' + cfgForHost.port + ' 打开页面后再操作' });
      }
    }
    if (req.method === 'GET' && p === '/api/hello') {
      return sendJSON(res, 200, { id: APP_ID, version: APP_VERSION });
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      let html = getIndexHtml();
      const inject = '<script>window.__SS_TOKEN__=' + JSON.stringify(API_TOKEN) + ';</script>';
      html = html.indexOf('</head>') >= 0 ? html.replace('</head>', inject + '</head>') : inject + html;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && p === '/api/skills') {
      sendJSON(res, 200, { agents: scanSkills(loadConfig()) });
      return;
    }
    if (req.method === 'GET' && p === '/api/integrations') {
      try {
        sendJSON(res, 200, { ok: true, ...scanIntegrations(), backups: listBackups() });
      } catch (e) {
        sendJSON(res, 200, { ok: false, error: String(e.message || e), tools: [], backups: [] });
      }
      return;
    }
    if (req.method === 'POST' && p === '/api/integrations/preview-mcp') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const r = await previewMcpRepo(parsed.repo);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'POST' && p === '/api/integrations/install-mcp') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const r = installMcp(parsed.kind || 'codex', parsed.name, parsed.command, parsed.args);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'POST' && p === '/api/integrations/toggle-plugin') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const r = setPluginEnabled(parsed.kind || 'codex', parsed.name, parsed.enabled === true);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'POST' && p === '/api/integrations/remove-plugin') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const r = removePlugin(parsed.kind || 'codex', parsed.name);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'POST' && p === '/api/integrations/install-plugin') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const r = installPlugin(parsed.kind || 'codex', parsed.name);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'POST' && p === '/api/integrations/toggle-mcp') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const r = setMcpEnabled(parsed.kind || 'codex', parsed.name, parsed.enabled === true);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'POST' && p === '/api/integrations/remove-mcp') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const r = removeMcp(parsed.kind || 'codex', parsed.name);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'POST' && p === '/api/integrations/rollback') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const r = rollbackBackup(parsed.backup);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'GET' && p === '/api/recommend') {
      const r = await getRecommend(loadConfig());
      sendJSON(res, 200, r);
      return;
    }

    if (req.method === 'GET' && p === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return sendJSON(res, 200, { query: q, items: [], total: 0 });
      const cfg2 = loadConfig();
      const searchUrl = (query) => 'https://api.github.com/search/repositories?q=' + encodeURIComponent(query) + '&sort=stars&order=desc&per_page=30';
      const normalize = (data) => (data.items || []).map(it => ({
        name: it.name || it.full_name,
        full_name: it.full_name || '',
        stars: it.stargazers_count || 0,
        description: it.description || '',
        url: it.html_url || ''
      }));
      try {
        let data = await race(httpsGetJson(searchUrl(q), 8000), 9000);
        let relaxed = false;
        let usedQuery = q;
        // 多关键词时 GitHub 默认按 AND 匹配，很容易 0 结果：自动降级成 OR 再试一次
        const words = q.split(/\s+/).filter(w => w && w.indexOf(':') < 0);
        if (!data.total_count && words.length > 1) {
          try {
            const orQuery = words.join(' OR ');
            const d2 = await race(httpsGetJson(searchUrl(orQuery), 8000), 9000);
            if (d2.total_count) { data = d2; relaxed = true; usedQuery = orQuery; }
          } catch (e) {}
        }
        const items = normalize(data);
        for (const it of items) it.installed = isRepoInstalled(cfg2, it.full_name);
        sendJSON(res, 200, { query: q, usedQuery, total: data.total_count || 0, relaxed, items });
      } catch (e) {
        sendJSON(res, 200, { query: q, items: [], total: 0, error: friendlyNetError(e) });
      }
      return;
    }
    if (req.method === 'POST' && p === '/api/install') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const r = await installSkill(loadConfig(), parsed.repo, parsed.agentId);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }

    if (req.method === 'POST' && p === '/api/preview') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const r = await previewRepo(parsed.repo);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'POST' && p === '/api/delete') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const r = await deleteSkill(loadConfig(), parsed.dir, parsed.skill);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'POST' && p === '/api/uninstall') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const r = await uninstallRepo(loadConfig(), parsed.repo);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'GET' && p === '/api/config') {
      const cfg = loadConfig();
      sendJSON(res, 200, { port: cfg.port, host: cfg.host, agents: cfg.agents, projects: cfg.projects, github: cfg.github });
      return;
    }
    if (req.method === 'POST' && p === '/api/config') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const clean = saveConfig(parsed);
      log('更新配置');
      return sendJSON(res, 200, { ok: true, config: clean });
    }
    if (req.method === 'POST' && p === '/api/toggle') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const r = toggleSkill(loadConfig(), parsed.dir, parsed.skill, parsed.enable === true);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'POST' && p === '/api/batch') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body || '{}'); } catch (e) { return sendJSON(res, 400, { ok: false, error: 'JSON 解析失败' }); }
      const r = batchToggle(loadConfig(), parsed.agentId, parsed.enable === true);
      return sendJSON(res, r.ok ? 200 : 400, r);
    }
    if (req.method === 'POST' && p === '/api/exit') {
      sendJSON(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 300);
      return;
    }
    if (req.method === 'POST' && p === '/api/pick-folder') {
      try {
        const picked = await pickFolderDialog();
        if (!picked) return sendJSON(res, 200, { ok: false, error: '已取消选择' });
        return sendJSON(res, 200, { ok: true, path: picked });
      } catch (e) {
        return sendJSON(res, 200, { ok: false, error: String(e.message || e) });
      }
    }
    sendJSON(res, 404, { ok: false, error: '未找到: ' + p });
  } catch (e) {
    sendJSON(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
  }
});

function openBrowser(url) {
  if (!/^https?:\/\/[A-Za-z0-9._:\[\]-]+(\/[^\s"]*)?$/.test(String(url))) return;
  const platform = process.platform;
  const cmd = platform === 'win32' ? `start "" "${url}"`
    : platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

const config = loadConfig();
const URL_BASE = `http://${config.host}:${config.port}`;
if (!isLoopbackHost(config.host)) {
  console.warn('[警告] 服务绑定在非回环地址 ' + config.host + '，任何能访问该端口的设备都可能操作本机技能目录。');
  log('警告: 非回环绑定 ' + config.host);
}
let healTried = false;

function findPidOnPort(port) {
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', timeout: 5000 });
    const lines = out.split(/\r?\n/);
    const portRe = new RegExp(':' + port + '(\\s|$)');
    for (const line of lines) {
      if (!/LISTENING/i.test(line)) continue;
      if (!portRe.test(line)) continue;
      const parts = line.trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1], 10);
      if (pid > 0) return pid;
    }
  } catch (e) {}
  return null;
}

function isOurProcess(pid) {
  try {
    const out = execSync('tasklist /FI "PID eq ' + pid + '" /FO CSV /NH', { encoding: 'utf8', timeout: 5000 });
    return /SkillSwitch\.exe/i.test(out);
  } catch (e) { return false; }
}

function killPid(pid) {
  try { execSync('taskkill /PID ' + pid + ' /T /F', { timeout: 8000 }); return true; } catch (e) { return false; }
}

// 我们的进程是 GUI 子系统、没有前台窗口，子进程 PowerShell 直接 Show 对话框会被浏览器盖住。
// 做法：不可见属主窗口 + 300ms 定时器，对话框一出现就 SetWindowPos(TOPMOST) + SetForegroundWindow。
const PS_HELPER = [
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Text;',
  'using System.Runtime.InteropServices;',
  'public class SSWin {',
  '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
  '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
  '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);',
  '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
  '  public static int PromoteOthers(uint pid, string skip) {',
  '    int n = 0;',
  '    EnumWindows((h, l) => {',
  '      uint p; GetWindowThreadProcessId(h, out p);',
  '      if (p != pid) return true;',
  '      if (!IsWindowVisible(h)) return true;',
  '      var sb = new StringBuilder(512); GetWindowTextW(h, sb, 512);',
  '      if (sb.ToString() == skip) return true;',
  '      SetWindowPos(h, (IntPtr)(-1), 0, 0, 0, 0, 0x0001 | 0x0002);',
  '      SetForegroundWindow(h);',
  '      n++;',
  '      return true;',
  '    }, IntPtr.Zero);',
  '    return n;',
  '  }',
  '}',
  '"@',
  '$script:ssPid = [uint32]$PID',
  'function Show-TopMost() {',
  '  try { [void][SSWin]::PromoteOthers($script:ssPid, \'SkillSwitch\') } catch {}',
  '}',
  '$owner = New-Object System.Windows.Forms.Form',
  "$owner.Text = 'SkillSwitch'",
  '$owner.ShowInTaskbar = $false',
  '$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None',
  '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual',
  '$owner.Location = New-Object System.Drawing.Point(-3000, -3000)',
  '$owner.Size = New-Object System.Drawing.Size(1, 1)',
  '$owner.Show()',
  '$timer = New-Object System.Windows.Forms.Timer',
  '$timer.Interval = 300'
];

function showDialog(msg, title) {
  try {
    // 注意：VBS 的 Popup 无法容纳换行，且 UTF-8 无 BOM 的中文会被 WSH 解析失败。
    // 改用 PowerShell + System.Windows.Forms，并写入带 BOM 的 UTF-8。
    const safeTitle = String(title || '技能开关').replace(/'/g, "''");
    const body = String(msg == null ? '' : msg).replace(/\r\n?/g, '\n');
    const ps = PS_HELPER.concat([
      "$caption = '" + safeTitle + "'",
      '$timer.Add_Tick({ Show-TopMost })',
      '$timer.Start()',
      "$m = @'",
      body,
      "'@",
      '[void][System.Windows.Forms.MessageBox]::Show($owner, $m, $caption, '
        + '[System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)',
      '$timer.Stop()',
      '$owner.Close()'
    ]).join("\n");
    const tmp = path.join(os.tmpdir(), 'skillswitch-msg-' + Date.now() + '.ps1');
    fs.writeFileSync(tmp, '\uFEFF' + ps, 'utf8');
    exec('powershell -NoProfile -ExecutionPolicy Bypass -File "' + tmp + '"', { timeout: 60000 }, () => { try { fs.unlinkSync(tmp); } catch (e) {} });
  } catch (e) {}
}

function pickFolderDialog() {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), 'skillswitch-pick-' + Date.now() + '.ps1');
    const caption = '选择技能目录或项目根目录';
    const ps = PS_HELPER.concat([
      "$caption = '" + caption.replace(/'/g, "''") + "'",
      '$timer.Add_Tick({ Show-TopMost })',
      '$timer.Start()',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$d.Description = $caption',
      '$d.ShowNewFolderButton = $true',
      '$d.AutoUpgradeEnabled = $true',
      '$r = $d.ShowDialog($owner)',
      '$timer.Stop()',
      'if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }',
      '$owner.Close()'
    ]).join("\n");
    try { fs.writeFileSync(tmp, '\uFEFF' + ps, 'utf8'); } catch (e) { return reject(e); }
    exec('powershell -NoProfile -STA -ExecutionPolicy Bypass -File "' + tmp + '"', { timeout: 180000 }, (err, stdout) => {
      try { fs.unlinkSync(tmp); } catch (e) {}
      if (err) return reject(err);
      resolve(String(stdout || '').trim());
    });
  });
}

function onListening() {
  log('服务器启动 v' + APP_VERSION + ': ' + URL_BASE);
  console.log('==============================================');
  console.log('  技能开关 Skill Switch v' + APP_VERSION);
  console.log('  访问地址: ' + URL_BASE);
  console.log('  在网页右上角点「退出」可停止服务');
  console.log('==============================================');
  if (!process.argv.includes('--no-open')) openBrowser(URL_BASE);
}

function processName(pid) {
  try {
    const out = execSync('tasklist /FI "PID eq ' + Number(pid) + '" /FO CSV /NH', { encoding: 'utf8', timeout: 5000 });
    const m = out.match(/^"([^"]+)"/m);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('\n端口 ' + config.port + ' 已被占用，正在确认是否为本程序…');
    const req = http.get({ host: '127.0.0.1', port: config.port, path: '/api/hello', timeout: 2500 }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let info = null;
        try { info = JSON.parse(raw); } catch (err) {}
        if (info && info.id === APP_ID) {
          console.log('已有实例在运行（v' + (info.version || '?') + '），已为你打开浏览器。');
          if (!process.argv.includes('--no-open')) openBrowser(URL_BASE);
          setTimeout(() => process.exit(0), 300);
          return;
        }
        const pid = findPidOnPort(config.port);
        const name = pid ? processName(pid) : null;
        const detail = pid ? ('占用进程：' + (name || '未知') + ' (PID ' + pid + ')') : '无法识别占用进程。';
        showDialog('端口 ' + config.port + ' 已被其它程序占用。\n' + detail + '\n\n请关闭该程序，或修改 config.json 里的 port 后重试。', '技能开关启动失败');
        setTimeout(() => process.exit(1), 1500);
      });
    });
    req.on('error', () => {
      const pid = findPidOnPort(config.port);
      const name = pid ? processName(pid) : null;
      if (pid && name && /^skillswitch/i.test(name) && !healTried) {
        healTried = true;
        console.log('清理残留实例 PID ' + pid + '…');
        killPid(pid);
        setTimeout(() => {
          try { server.listen(config.port, config.host, onListening); }
          catch (err) { showDialog('重启失败：' + err.message, '技能开关启动失败'); }
        }, 1200);
      } else {
        showDialog('端口 ' + config.port + ' 被占用。\n' + (pid ? '进程：' + name + ' (PID ' + pid + ')' : '无法识别进程') + '\n\n请关闭它，或修改 config.json 里的 port。', '技能开关启动失败');
        setTimeout(() => process.exit(1), 1500);
      }
    });
    req.on('timeout', () => req.destroy());
    return;
  }
  console.error('[错误] 服务器启动失败: ' + e.message);
  showDialog('启动失败：' + (e.message || e), '技能开关启动失败');
  setTimeout(() => process.exit(1), 1500);
});

process.on('uncaughtException', (e) => { try { log('未捕获异常: ' + (e && e.stack ? e.stack : String(e))); } catch (_) {} });
process.on('SIGINT', () => { try { log('服务器停止'); } catch (_) {} process.exit(0); });
server.listen(config.port, config.host, onListening);
