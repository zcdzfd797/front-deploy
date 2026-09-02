const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const { execSync, exec, spawn, spawnSync } = require('child_process');
const archiver = require('archiver');
const { Client } = require('ssh2');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

const app = express();
const REQUESTED_HOST = process.env.HOST || '127.0.0.1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const HOST = LOOPBACK_HOSTS.has(REQUESTED_HOST) ? REQUESTED_HOST : '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const APP_INSTANCE_ID = process.env.APP_INSTANCE_ID || "";
const DATA_FILE = path.join(__dirname, 'projects.json');
const BUILD_OUTPUT_DIRS = [
  'dist', 'build', 'out', 'release', 'output', 'www', 'web-build',
  '.output', '.next', '.nuxt', 'storybook-static'
];
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/_health', (req, res) => {
  res.json({ ok: true, instanceId: APP_INSTANCE_ID });
});

const upload = multer({ dest: path.join(__dirname, 'temp') });

const DATA_VERSION = 2;
const DATA_BACKUP_FILE = path.join(__dirname, 'projects.json.v1.bak');

function createEmptyData() {
  return { version: DATA_VERSION, servers: [], projects: [] };
}

function getServerMatchKey(host, port, username) {
  return `${String(host || '').trim().toLowerCase()}|${Number(port) || 22}|${String(username || '').trim().toLowerCase()}`;
}

// v1（项目数组，deploy 内嵌）→ v2（servers + projects.targetIds 多对多）。
function migrateV1Projects(rawProjects) {
  const data = createEmptyData();
  const serverByKey = new Map();

  rawProjects.forEach((project) => {
    if (!project || typeof project !== 'object') return;
    const deploy = project.deploy;
    delete project.deploy;

    project.targetIds = Array.isArray(project.targetIds) ? project.targetIds : [];
    project.deployStates = project.deployStates && typeof project.deployStates === 'object'
      ? project.deployStates
      : {};

    if (!deploy || !deploy.host || !deploy.username || !deploy.deployPath) {
      data.projects.push(project);
      return;
    }

    const port = Number(deploy.port) || 22;
    const serverKey = getServerMatchKey(deploy.host, port, deploy.username);
    let server = serverByKey.get(serverKey);
    if (!server) {
      server = {
        id: uuidv4(),
        name: String(deploy.host),
        host: String(deploy.host),
        port,
        username: String(deploy.username),
        password: deploy.password || '',
        privateKey: deploy.privateKey || '',
        createdAt: new Date().toISOString(),
        paths: []
      };
      serverByKey.set(serverKey, server);
      data.servers.push(server);
    } else if (!server.privateKey && deploy.privateKey) {
      server.privateKey = deploy.privateKey;
    } else if (!server.password && deploy.password) {
      server.password = deploy.password;
    }

    const deployPath = String(deploy.deployPath);
    let pathEntry = server.paths.find((item) => item.deployPath === deployPath);
    if (!pathEntry) {
      pathEntry = {
        id: uuidv4(),
        label: '',
        deployPath,
        backupPath: String(deploy.backupPath || ''),
        createdAt: new Date().toISOString()
      };
      server.paths.push(pathEntry);
    }

    project.targetIds.push(pathEntry.id);
    project.deployStates[pathEntry.id] = {
      lastDeployTime: project.lastDeployTime || null,
      deployStatus: project.deployStatus || '未部署'
    };
    data.projects.push(project);
  });

  return data;
}

// v2 → v2.1：为按目标的构建命令/打包产物字段做一次性种子迁移（幂等）。
// 旧的单 zip 产物会平摊到当前已关联的每个目标上，保证“已打包”状态不丢失。
function normalizeProjectTargetFields(data) {
  let changed = false;
  data.projects.forEach((project) => {
    if (!project || typeof project !== 'object') return;
    if (!project.buildCmds || typeof project.buildCmds !== 'object') {
      project.buildCmds = {};
      changed = true;
    }
    if (!project.packs || typeof project.packs !== 'object') {
      project.packs = {};
      changed = true;
    }

    const linkedTargetIds = sanitizeTargetIds(data.servers, project.targetIds);
    if (project.zipPath && linkedTargetIds.length && Object.keys(project.packs).length === 0) {
      const seed = {
        zipPath: project.zipPath,
        zipName: project.zipName || '',
        packDirName: project.packDirName || '',
        packTime: project.packTime || ''
      };
      linkedTargetIds.forEach((pathId) => {
        project.packs[pathId] = { ...seed };
      });
      changed = true;
    }

    if (project.zipPath !== undefined) {
      delete project.zipPath;
      delete project.zipName;
      delete project.packDirName;
      delete project.packTime;
      changed = true;
    }
  });
  return changed;
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return createEmptyData();
  const raw = fs.readJsonSync(DATA_FILE);

  if (Array.isArray(raw)) {
    const data = migrateV1Projects(raw);
    if (!fs.existsSync(DATA_BACKUP_FILE)) {
      fs.copySync(DATA_FILE, DATA_BACKUP_FILE);
    }
    normalizeProjectTargetFields(data);
    saveData(data);
    return data;
  }

  if (raw && raw.version === DATA_VERSION && Array.isArray(raw.servers) && Array.isArray(raw.projects)) {
    if (normalizeProjectTargetFields(raw)) saveData(raw);
    return raw;
  }

  throw new Error('projects.json 格式无法识别，请检查或删除该文件后重试');
}

function saveData(data) {
  fs.writeJsonSync(DATA_FILE, data, { spaces: 2 });
}

function loadProjects() {
  return loadData().projects;
}

function findPathById(servers, pathId) {
  for (const server of servers) {
    const pathIndex = (server.paths || []).findIndex((item) => item.id === pathId);
    if (pathIndex !== -1) {
      return { server, path: server.paths[pathIndex], pathIndex };
    }
  }
  return null;
}

function collectKnownPathIds(servers) {
  const ids = new Set();
  servers.forEach((server) => {
    (server.paths || []).forEach((pathEntry) => ids.add(pathEntry.id));
  });
  return ids;
}

function sanitizeTargetIds(servers, targetIds) {
  if (!Array.isArray(targetIds)) return [];
  const knownIds = collectKnownPathIds(servers);
  const result = [];
  targetIds.forEach((id) => {
    const normalized = String(id || '').trim();
    if (normalized && knownIds.has(normalized) && !result.includes(normalized)) {
      result.push(normalized);
    }
  });
  return result;
}

function getCurrentGitBranch(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) {
    throw new Error('项目路径不存在');
  }
  if (!fs.existsSync(path.join(dirPath, '.git'))) {
    throw new Error('项目路径不是 Git 仓库');
  }
  return execSync('git rev-parse --abbrev-ref HEAD', { cwd: dirPath, encoding: 'utf-8' }).trim();
}

function checkProjectBranch(project) {
  const recordedBranch = String(project?.branch || '').trim();
  if (!recordedBranch) {
    return {
      ok: false,
      currentBranch: '',
      recordedBranch: '',
      message: '未记录分支，请先在项目配置中填写分支后再操作'
    };
  }

  try {
    const currentBranch = getCurrentGitBranch(project.dirPath);
    if (currentBranch !== recordedBranch) {
      return {
        ok: false,
        currentBranch,
        recordedBranch,
        message: `当前分支(${currentBranch})与记录分支(${recordedBranch})不一致，已禁止操作`
      };
    }
    return {
      ok: true,
      currentBranch,
      recordedBranch,
      message: '分支校验通过'
    };
  } catch (err) {
    return {
      ok: false,
      currentBranch: '',
      recordedBranch,
      message: `分支校验失败: ${err.message}`
    };
  }
}

function runGitCommand(dirPath, args) {
  const result = spawnSync('git', args, {
    cwd: dirPath,
    encoding: 'utf-8',
    shell: false,
    maxBuffer: 10 * 1024 * 1024
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const message = String(result.stderr || result.stdout || '').trim();
    throw new Error(message || `git ${args.join(' ')} 执行失败`);
  }
  return String(result.stdout || '').trim();
}

function ensureGitProjectDir(dirPath) {
  if (!dirPath || !fs.existsSync(dirPath)) {
    throw new Error('项目路径不存在');
  }
  if (!fs.existsSync(path.join(dirPath, '.git'))) {
    throw new Error('项目路径不是 Git 仓库');
  }
}

function parseGitStatusLine(line) {
  const raw = String(line || '');
  return {
    code: raw.slice(0, 2).trim() || '??',
    path: raw.slice(3).trim(),
    raw
  };
}

function toGitRelativePath(baseDir, targetPath) {
  const relativePath = path.relative(baseDir, targetPath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return '';
  }
  return relativePath.replace(/\\/g, '/');
}

function getKnownPackZipPaths(project) {
  const dirPath = project?.dirPath;
  const names = new Set();

  Object.values(project?.packs || {}).forEach((pack) => {
    const zipPath = String(pack?.zipPath || '').trim();
    if (dirPath && zipPath) {
      const relativeZipPath = toGitRelativePath(dirPath, zipPath);
      if (relativeZipPath) names.add(relativeZipPath);
    }

    const zipName = String(pack?.zipName || '').trim();
    if (zipName && !zipName.includes('/') && !zipName.includes('\\')) {
      names.add(zipName);
    }

    const packDirName = String(pack?.packDirName || '').trim();
    if (packDirName && !packDirName.includes('/') && !packDirName.includes('\\')) {
      names.add(`${packDirName}.zip`);
    }
  });

  return names;
}

function normalizeGitPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function normalizeGitPathSet(items = []) {
  return new Set(Array.from(items).map(normalizeGitPath).filter(Boolean));
}

function normalizeGitTopLevelDirSet(items = []) {
  return new Set(Array.from(items).map((item) => normalizeGitPath(item).toLowerCase()).filter(Boolean));
}

function isIgnoredUntrackedGitPath(entryPath, ignoredPaths = new Set(), ignoredTopLevelDirs = new Set()) {
  const normalizedPath = normalizeGitPath(entryPath);
  if (!normalizedPath) return false;
  if (ignoredPaths.has(normalizedPath)) return true;

  const topLevelName = normalizedPath.split('/')[0].toLowerCase();
  return ignoredTopLevelDirs.has(topLevelName);
}

function listGitWorktreeEntries(dirPath) {
  ensureGitProjectDir(dirPath);
  const output = runGitCommand(dirPath, ['status', '--porcelain=v1', '-uall']);
  return output
    ? output.split(/\r?\n/).filter(Boolean).map(parseGitStatusLine)
    : [];
}

function filterGitWorktreeEntries(entries, options = {}) {
  const ignoredUntrackedPaths = options.ignoredUntrackedPaths instanceof Set
    ? normalizeGitPathSet(options.ignoredUntrackedPaths)
    : normalizeGitPathSet(options.ignoredUntrackedPaths || []);
  const ignoredUntrackedTopLevelDirs = options.ignoredUntrackedTopLevelDirs instanceof Set
    ? normalizeGitTopLevelDirSet(options.ignoredUntrackedTopLevelDirs)
    : normalizeGitTopLevelDirSet(options.ignoredUntrackedTopLevelDirs || []);
  return entries.filter((entry) => !(
    entry.code === '??'
    && isIgnoredUntrackedGitPath(entry.path, ignoredUntrackedPaths, ignoredUntrackedTopLevelDirs)
  ));
}

function buildGitWorktreeStatus(entries) {
  return {
    hasChanges: entries.length > 0,
    count: entries.length,
    entries
  };
}

function getGitWorktreeStatus(dirPath, options = {}) {
  return buildGitWorktreeStatus(filterGitWorktreeEntries(listGitWorktreeEntries(dirPath), options));
}

function getIgnoredUntrackedPaths(entries, ignoredPaths = new Set()) {
  const normalizedIgnoredPaths = normalizeGitPathSet(ignoredPaths);
  return new Set(entries
    .filter((entry) => entry.code === '??' && normalizedIgnoredPaths.has(normalizeGitPath(entry.path)))
    .map((entry) => normalizeGitPath(entry.path)));
}

function getIgnoredUntrackedTopLevelDirs(entries, ignoredTopLevelDirs = new Set()) {
  const normalizedIgnoredDirs = normalizeGitTopLevelDirSet(ignoredTopLevelDirs);
  const trackedTopLevelDirs = new Set(entries
    .filter((entry) => entry.code !== '??')
    .map((entry) => normalizeGitPath(entry.path).split('/')[0].toLowerCase())
    .filter(Boolean));

  return new Set(entries
    .filter((entry) => entry.code === '??')
    .map((entry) => normalizeGitPath(entry.path).split('/')[0].toLowerCase())
    .filter((topLevelName) => (
      topLevelName
      && normalizedIgnoredDirs.has(topLevelName)
      && !trackedTopLevelDirs.has(topLevelName)
    )));
}

function listGitStashes(dirPath) {
  ensureGitProjectDir(dirPath);
  const output = runGitCommand(dirPath, ['stash', 'list', '--format=%gd%x09%H%x09%s']);
  if (!output) return [];
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [ref = '', hash = '', ...subjectParts] = line.split('\t');
    return {
      ref: ref.trim(),
      hash: hash.trim(),
      subject: subjectParts.join('\t').trim()
    };
  });
}

function findGitStashByToken(dirPath, token, fallbackHash = '') {
  const stashes = listGitStashes(dirPath);
  return stashes.find((item) => item.subject.includes(token))
    || stashes.find((item) => fallbackHash && item.hash === fallbackHash)
    || null;
}

function shouldRetryStashApplyWithoutIndex(message) {
  return /Try without --index|conflicts in index|Index was not unstashed/i.test(String(message || ''));
}

function buildPackStashPushArgs(message, excludedPaths = new Set(), excludedTopLevelDirs = new Set()) {
  const args = ['stash', 'push', '-u', '-m', message];
  const paths = [
    ...Array.from(excludedPaths).filter(Boolean),
    ...Array.from(excludedTopLevelDirs).filter(Boolean).map((item) => `${item}/**`)
  ];
  if (paths.length) {
    args.push('--', '.', ...paths.map((item) => `:(exclude)${item}`));
  }
  return args;
}

function createPackGitStash(project) {
  const dirPath = project?.dirPath;
  const knownPackZipPaths = getKnownPackZipPaths(project);
  const buildOutputDirs = new Set(BUILD_OUTPUT_DIRS);
  const rawEntries = listGitWorktreeEntries(dirPath);
  const status = buildGitWorktreeStatus(filterGitWorktreeEntries(rawEntries, {
    ignoredUntrackedPaths: knownPackZipPaths,
    ignoredUntrackedTopLevelDirs: buildOutputDirs
  }));
  const token = `front-deploy-pack-${Date.now()}-${uuidv4().slice(0, 8)}`;
  const projectName = project?.projectName;
  const safeProjectName = String(projectName || path.basename(dirPath) || 'project').trim();
  const message = `front-deploy auto stash before pack ${safeProjectName} ${token}`;

  if (!status.hasChanges) {
    return { created: false, token, message, status };
  }

  const output = runGitCommand(dirPath, buildPackStashPushArgs(
    message,
    getIgnoredUntrackedPaths(rawEntries, knownPackZipPaths),
    getIgnoredUntrackedTopLevelDirs(rawEntries, buildOutputDirs)
  ));
  const stash = findGitStashByToken(dirPath, token);
  if (!stash) {
    throw new Error('已执行 git stash，但未能定位本次创建的储藏记录');
  }

  return {
    created: true,
    token,
    message,
    status,
    output,
    ref: stash.ref,
    hash: stash.hash,
    subject: stash.subject
  };
}

function restorePackGitStash(dirPath, stashState) {
  if (!stashState?.created) return { restored: false };

  const stash = findGitStashByToken(dirPath, stashState.token, stashState.hash);
  if (!stash?.ref) {
    throw new Error('未找到需要还原的储藏记录，请手动检查 git stash list');
  }

  let restoreMode = 'index';
  try {
    runGitCommand(dirPath, ['stash', 'apply', '--index', stash.ref]);
  } catch (err) {
    if (!shouldRetryStashApplyWithoutIndex(err.message)) {
      throw err;
    }
    runGitCommand(dirPath, ['stash', 'apply', stash.ref]);
    restoreMode = 'worktree';
  }
  runGitCommand(dirPath, ['stash', 'drop', stash.ref]);
  return {
    restored: true,
    restoreMode,
    ref: stash.ref,
    hash: stash.hash,
    subject: stash.subject
  };
}

function getGitSyncInfo(project) {
  const dirPath = project?.dirPath;
  ensureGitProjectDir(dirPath);

  const localBranch = runGitCommand(dirPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const localHash = runGitCommand(dirPath, ['rev-parse', 'HEAD']);
  const localCommitMsg = runGitCommand(dirPath, ['log', '-1', '--pretty=%B']);
  const localCommitTime = runGitCommand(dirPath, ['log', '-1', '--pretty=%ci']);

  const remoteLine = runGitCommand(dirPath, ['ls-remote', '--heads', 'origin', localBranch]);
  const [remoteHashRaw = '', remoteRefRaw = ''] = remoteLine.split(/\s+/);
  if (!remoteHashRaw) {
    throw new Error(`未找到远程分支 origin/${localBranch}`);
  }

  const remoteHash = remoteHashRaw.trim();
  const remoteRef = remoteRefRaw.trim() || `refs/heads/${localBranch}`;
  return {
    localBranch,
    localHash,
    localHashShort: localHash.slice(0, 8),
    localCommitMsg: localCommitMsg.trim(),
    localCommitTime: localCommitTime.trim(),
    remoteBranch: localBranch,
    remoteRef,
    remoteHash,
    remoteHashShort: remoteHash.slice(0, 8),
    same: localHash === remoteHash
  };
}

app.post('/api/parse-git', (req, res) => {
  try {
    const { dirPath } = req.body;
    if (!dirPath || !fs.existsSync(path.join(dirPath, '.git'))) {
      return res.status(400).json({ error: '路径不存在或不是 Git 仓库' });
    }

    const projectName = path.basename(dirPath);
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: dirPath, encoding: 'utf-8' }).trim();
    const commitHash = execSync('git rev-parse --short HEAD', { cwd: dirPath, encoding: 'utf-8' }).trim();
    const commitMsg = execSync('git log -1 --pretty=%B', { cwd: dirPath, encoding: 'utf-8' }).trim();
    const commitTime = execSync('git log -1 --pretty=%ci', { cwd: dirPath, encoding: 'utf-8' }).trim();

    const recentLogs = execSync('git log --oneline -10', { cwd: dirPath, encoding: 'utf-8' }).trim();

    res.json({
      projectName,
      branch,
      commitHash,
      commitMsg,
      commitTime,
      recentLogs,
      dirPath
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/pick-folder', (req, res) => {
  const startDir = typeof req.query.startDir === 'string' ? req.query.startDir.trim() : '';
  const escapedStartDir = startDir.replace(/'/g, "''");
  const ps = `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '选择项目文件夹'; $d.ShowNewFolderButton = $false; $start = '${escapedStartDir}'; if ($start -and (Test-Path -LiteralPath $start -PathType Container)) { $d.SelectedPath = $start }; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { '' }`;
  exec(`powershell -NoProfile -Command "${ps}"`, { timeout: 60000 }, (err, stdout) => {
    if (err) return res.status(500).json({ error: '打开文件夹选择器失败: ' + err.message });
    const selected = stdout.trim();
    if (!selected) return res.json({ canceled: true });
    res.json({ path: selected });
  });
});

const crypto = require('crypto');

function decryptFinalShellPassword(encPwd) {
  try {
    const key = Buffer.from([0x13, 0x22, 0x35, 0x46, 0x59, 0x6A, 0x73, 0x84]);
    const data = Buffer.from(encPwd, 'base64');
    const decipher = crypto.createDecipheriv('des-ecb', key, null);
    let decrypted = decipher.update(data, null, 'utf8');
    decrypted += decipher.final('utf8');
    const result = decrypted.replace(/\0+$/, '').trim();
    if (/^[\x20-\x7e]+$/.test(result)) return result;
    return null;
  } catch {
    return null;
  }
}

function normalizeSshConfig(raw) {
  const result = {};
  if (raw.host) result.host = raw.host;
  if (raw.port) result.port = raw.port;
  if (raw.user_name) result.username = raw.user_name;
  else if (raw.username) result.username = raw.username;
  if (raw.password) {
    const decrypted = decryptFinalShellPassword(raw.password);
    if (decrypted) {
      result.password = decrypted;
    } else {
      result.password = raw.password;
      result.encryptedPassword = true;
    }
  }
  if (raw.privateKey) result.privateKey = raw.privateKey;
  if (raw.secret_key_id) result.secretKeyId = raw.secret_key_id;
  if (raw.name) result.connectionName = raw.name;
  if (raw.authentication_type !== undefined) result.authenticationType = raw.authentication_type;
  if (raw.description) result.description = raw.description;
  if (raw.deployPath) result.deployPath = raw.deployPath;
  if (raw.backupPath) result.backupPath = raw.backupPath;
  return result;
}

app.post('/api/test-connection', (req, res) => {
  const { host, port, username, password, privateKey } = req.body;
  if (!host || !username) return res.status(400).json({ error: '缺少主机地址或用户名' });

  if (!privateKey && !password) return res.status(400).json({ error: '请提供密码或私钥' });

  let responded = false;
  const done = (err, data) => {
    if (responded) return;
    responded = true;
    clearTimeout(timer);
    conn.end();
    if (err) res.status(500).json({ error: err });
    else res.json(data);
  };

  const conn = new Client();
  const timer = setTimeout(() => done('连接超时（10秒）'), 10000);

  conn.on('ready', () => done(null, { success: true, message: '连接成功' }));
  conn.on('error', (err) => done('连接失败: ' + err.message));

  conn.connect({ host, port: port || 22, username, ...(privateKey ? { privateKey } : { password }) });
});

app.post('/api/decrypt-password', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: '缺少密码' });
  const decrypted = decryptFinalShellPassword(password);
  if (decrypted) {
    res.json({ password: decrypted });
  } else {
    res.status(400).json({ error: '无法自动解密此密码，请手动输入明文密码' });
  }
});

app.post('/api/import-json', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未上传文件' });
    const content = fs.readFileSync(req.file.path, 'utf-8');
    fs.removeSync(req.file.path);
    const raw = JSON.parse(content);
    const data = normalizeSshConfig(raw);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: 'JSON 解析失败: ' + err.message });
  }
});

function decorateProjectZipInfo(project) {
  const decorated = { ...project };
  let packedCount = 0;
  let latest = null;
  decorated.packs = {};
  Object.entries(project.packs || {}).forEach(([targetId, pack]) => {
    const exists = Boolean(pack?.zipPath && fs.existsSync(pack.zipPath));
    decorated.packs[targetId] = { ...pack, zipExists: exists };
    if (exists) {
      packedCount += 1;
      if (!latest || String(pack.packTime || '') > String(latest.packTime || '')) {
        latest = {
          zipPath: pack.zipPath,
          zipSize: (fs.statSync(pack.zipPath).size / 1024 / 1024).toFixed(2) + ' MB',
          packTime: pack.packTime || ''
        };
      }
    }
  });
  decorated.zipExists = packedCount > 0;
  decorated.packedCount = packedCount;
  decorated.zipPath = latest ? latest.zipPath : null;
  decorated.zipSize = latest ? latest.zipSize : null;
  decorated.packTime = latest ? latest.packTime : null;
  return decorated;
}

// 校验并清理 body 中按目标的字段：buildCmds 仅保留有效路径 id 与非空命令；同时清理未关联目标的孤儿产物
function sanitizeProjectBodyTargetFields(data, body) {
  if (body.buildCmds && typeof body.buildCmds === 'object' && !Array.isArray(body.buildCmds)) {
    const knownIds = collectKnownPathIds(data.servers);
    const cleaned = {};
    Object.entries(body.buildCmds).forEach(([targetId, cmd]) => {
      const command = String(cmd || '').trim();
      if (knownIds.has(targetId) && command) cleaned[targetId] = command;
    });
    body.buildCmds = cleaned;
  } else {
    delete body.buildCmds;
  }
  delete body.packs;
  delete body.deployStates;
  return body;
}

function pruneProjectOrphanTargetFields(project) {
  const linked = new Set(Array.isArray(project.targetIds) ? project.targetIds : []);
  ['packs', 'buildCmds'].forEach((field) => {
    if (project[field] && typeof project[field] === 'object') {
      Object.keys(project[field]).forEach((targetId) => {
        if (!linked.has(targetId)) delete project[field][targetId];
      });
    }
  });
}

app.post('/api/projects', (req, res) => {
  try {
    const data = loadData();
    const body = sanitizeProjectBodyTargetFields(data, { ...req.body });
    body.targetIds = sanitizeTargetIds(data.servers, body.targetIds);
    const project = {
      id: uuidv4(),
      ...body,
      buildCmds: body.buildCmds || {},
      packs: {},
      deployStates: {},
      createdAt: new Date().toISOString(),
      lastDeployTime: null,
      deployStatus: '未部署'
    };
    data.projects.push(project);
    saveData(data);
    res.json(decorateProjectZipInfo(project));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/projects/:id', (req, res) => {
  try {
    const data = loadData();
    const idx = data.projects.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '项目不存在' });
    const body = sanitizeProjectBodyTargetFields(data, { ...req.body });
    if (Array.isArray(body.targetIds)) {
      body.targetIds = sanitizeTargetIds(data.servers, body.targetIds);
    }
    const existing = data.projects[idx];
    const merged = { ...existing, ...body };
    if (body.buildCmds) {
      merged.buildCmds = { ...(existing.buildCmds || {}), ...body.buildCmds };
      Object.keys(merged.buildCmds).forEach((targetId) => {
        if (!merged.buildCmds[targetId]) delete merged.buildCmds[targetId];
      });
    }
    data.projects[idx] = merged;
    pruneProjectOrphanTargetFields(data.projects[idx]);
    saveData(data);
    res.json(decorateProjectZipInfo(data.projects[idx]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/projects/:id', (req, res) => {
  try {
    const data = loadData();
    data.projects = data.projects.filter(p => p.id !== req.params.id);
    saveData(data);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function decorateServersWithUsage(data) {
  const pathUsage = new Map();
  data.projects.forEach((project) => {
    (sanitizeTargetIds(data.servers, project.targetIds) || []).forEach((pathId) => {
      const usage = pathUsage.get(pathId) || { count: 0, projectNames: [] };
      usage.count += 1;
      usage.projectNames.push(project.projectName || project.id);
      pathUsage.set(pathId, usage);
    });
  });

  return data.servers.map((server) => {
    const paths = (server.paths || []).map((pathEntry) => ({
      ...pathEntry,
      usedCount: (pathUsage.get(pathEntry.id) || { count: 0 }).count
    }));
    const projectCount = new Set(
      data.projects
        .filter((project) => (project.targetIds || []).some((id) => server.paths?.some((p) => p.id === id)))
        .map((project) => project.id)
    ).size;
    return { ...server, paths, projectCount };
  });
}

function normalizeServerPayload(body) {
  const name = String(body?.name || '').trim();
  const host = String(body?.host || '').trim();
  const username = String(body?.username || '').trim();
  if (!name) return { error: '请填写服务器名称' };
  if (!host) return { error: '请填写服务器地址' };
  if (!username) return { error: '请填写用户名' };

  const password = String(body?.password || '');
  const privateKey = String(body?.privateKey || '').trim();
  if (!password && !privateKey) return { error: '请填写密码或私钥' };

  return {
    value: {
      name,
      host,
      port: Number.parseInt(body?.port, 10) || 22,
      username,
      ...(privateKey ? { privateKey } : { password })
    }
  };
}

function normalizePathPayload(body) {
  const label = String(body?.label || '').trim();
  const deployPath = String(body?.deployPath || '').trim();
  const backupPath = String(body?.backupPath || '').trim();
  if (!deployPath) return { error: '请填写部署路径' };
  if (!deployPath.startsWith('/')) return { error: '部署路径需以 / 开头的绝对路径' };
  if (backupPath && !backupPath.startsWith('/')) return { error: '备份路径需以 / 开头的绝对路径' };
  return { value: { label, deployPath, backupPath } };
}

app.get('/api/servers', (req, res) => {
  try {
    res.json(decorateServersWithUsage(loadData()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/servers', (req, res) => {
  try {
    const parsed = normalizeServerPayload(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const data = loadData();
    const server = {
      id: uuidv4(),
      ...parsed.value,
      createdAt: new Date().toISOString(),
      paths: []
    };
    data.servers.push(server);
    saveData(data);
    res.json(server);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/servers/:id', (req, res) => {
  try {
    const data = loadData();
    const idx = data.servers.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '服务器不存在' });

    const parsed = normalizeServerPayload({ ...data.servers[idx], ...req.body });
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    data.servers[idx] = { ...data.servers[idx], ...parsed.value };
    saveData(data);
    res.json(data.servers[idx]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function moveArrayItem(items, id, direction) {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return { error: '条目不存在', status: 404 };
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= items.length) {
    return { error: direction === 'up' ? '已经在最顶部，无法上移' : '已经在最底部，无法下移', status: 400 };
  }
  const [item] = items.splice(index, 1);
  items.splice(targetIndex, 0, item);
  return { moved: true };
}

app.post('/api/servers/:id/move', (req, res) => {
  try {
    const data = loadData();
    const server = data.servers.find(s => s.id === req.params.id);
    if (!server) return res.status(404).json({ error: '服务器不存在' });
    const direction = req.body?.direction === 'up' ? 'up' : 'down';
    const result = moveArrayItem(data.servers, server.id, direction);
    if (result.error) return res.status(result.status).json({ error: result.error });
    saveData(data);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/servers/:id/paths/:pathId/move', (req, res) => {
  try {
    const data = loadData();
    const server = data.servers.find(s => s.id === req.params.id);
    if (!server) return res.status(404).json({ error: '服务器不存在' });
    const direction = req.body?.direction === 'up' ? 'up' : 'down';
    const result = moveArrayItem(server.paths || [], req.params.pathId, direction);
    if (result.error) return res.status(result.status).json({ error: result.error });
    saveData(data);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/servers/:id', (req, res) => {
  try {
    const data = loadData();
    const idx = data.servers.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '服务器不存在' });

    const referencedPaths = (data.servers[idx].paths || []).filter((pathEntry) =>
      data.projects.some((project) => (project.targetIds || []).includes(pathEntry.id))
    );
    if (referencedPaths.length) {
      return res.status(400).json({
        error: `该服务器下有 ${referencedPaths.length} 个部署路径仍被项目引用，请先在项目中解除关联后再删除`
      });
    }

    data.servers.splice(idx, 1);
    saveData(data);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/servers/:id/paths', (req, res) => {
  try {
    const data = loadData();
    const server = data.servers.find(s => s.id === req.params.id);
    if (!server) return res.status(404).json({ error: '服务器不存在' });

    const parsed = normalizePathPayload(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    if ((server.paths || []).some((item) => item.deployPath === parsed.value.deployPath)) {
      return res.status(400).json({ error: '该服务器下已存在相同部署路径' });
    }

    const pathEntry = {
      id: uuidv4(),
      ...parsed.value,
      createdAt: new Date().toISOString()
    };
    server.paths = server.paths || [];
    server.paths.push(pathEntry);
    saveData(data);
    res.json(pathEntry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/servers/:id/paths/:pathId', (req, res) => {
  try {
    const data = loadData();
    const server = data.servers.find(s => s.id === req.params.id);
    if (!server) return res.status(404).json({ error: '服务器不存在' });

    const pathIdx = (server.paths || []).findIndex((item) => item.id === req.params.pathId);
    if (pathIdx === -1) return res.status(404).json({ error: '部署路径不存在' });

    const parsed = normalizePathPayload({ ...server.paths[pathIdx], ...req.body });
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    if ((server.paths || []).some((item, index) => index !== pathIdx && item.deployPath === parsed.value.deployPath)) {
      return res.status(400).json({ error: '该服务器下已存在相同部署路径' });
    }

    server.paths[pathIdx] = { ...server.paths[pathIdx], ...parsed.value };
    saveData(data);
    res.json(server.paths[pathIdx]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/servers/:id/paths/:pathId', (req, res) => {
  try {
    const data = loadData();
    const server = data.servers.find(s => s.id === req.params.id);
    if (!server) return res.status(404).json({ error: '服务器不存在' });

    const pathIdx = (server.paths || []).findIndex((item) => item.id === req.params.pathId);
    if (pathIdx === -1) return res.status(404).json({ error: '部署路径不存在' });

    const referencingProjects = data.projects.filter((project) =>
      (project.targetIds || []).includes(req.params.pathId)
    );
    if (referencingProjects.length) {
      const names = referencingProjects.map((p) => p.projectName || p.id).slice(0, 5).join('、');
      return res.status(400).json({
        error: `该部署路径正被 ${referencingProjects.length} 个项目引用（${names}），请先解除关联`
      });
    }

    server.paths.splice(pathIdx, 1);
    saveData(data);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/projects', (req, res) => {
  try {
    const projects = loadProjects();
    res.json(projects.map(decorateProjectZipInfo));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/branch-check/:id', (req, res) => {
  const projects = loadProjects();
  const project = projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  const result = checkProjectBranch(project);
  res.json(result);
});

app.get('/api/git-sync-check/:id', (req, res) => {
  try {
    const projects = loadProjects();
    const project = projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: '项目不存在' });

    const info = getGitSyncInfo(project);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: `Git 同步校验失败: ${err.message}` });
  }
});

app.get('/api/git-worktree-status/:id', (req, res) => {
  try {
    const projects = loadProjects();
    const project = projects.find(p => p.id === req.params.id);
    if (!project) return res.status(404).json({ error: '项目不存在' });

    const status = getGitWorktreeStatus(project.dirPath, {
      ignoredUntrackedPaths: getKnownPackZipPaths(project),
      ignoredUntrackedTopLevelDirs: new Set(BUILD_OUTPUT_DIRS)
    });
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: `Git 工作区检查失败: ${err.message}` });
  }
});

function buildSshConnConfig(deploy) {
  const connConfig = { host: deploy.host, port: deploy.port || 22, username: deploy.username };
  if (deploy.privateKey) connConfig.privateKey = deploy.privateKey;
  else if (deploy.password) connConfig.password = deploy.password;
  return connConfig;
}

// 线上目录名 = 该目标最近一次打包的产物目录名（决定备份/回滚匹配的目录）
function resolveProjectDeployFolderName(project, targetId) {
  const pack = project?.packs?.[targetId];
  const packDirName = String(pack?.packDirName || '').trim();
  if (packDirName) return packDirName;

  const zipName = String(pack?.zipName || '').trim();
  if (zipName) return path.basename(zipName, path.extname(zipName));

  const zipPath = String(pack?.zipPath || '').trim();
  if (zipPath) return path.basename(zipPath, path.extname(zipPath));

  return String(project?.projectName || '').trim();
}

// 某目标的构建命令：目标级覆盖优先，缺省回落项目默认
function resolveProjectBuildCmd(project, targetId) {
  const override = String(project?.buildCmds?.[targetId] || '').trim();
  if (override) return override;
  return String(project?.buildCmd || '').trim() || 'npm run build';
}

function escapePosixExtendedRegex(value) {
  return String(value || '').replace(/[.[\]{}()*+?^$|\\]/g, '\\$&');
}

function quoteShellArg(value) {
  return `'${String(value || '').replace(/'/g, `'\"'\"'`)}'`;
}

function buildBackupDirectoryFindCommand(rootPath, folderName) {
  const safeRoot = quoteShellArg(rootPath);
  const safeRegex = quoteShellArg(`./${escapePosixExtendedRegex(folderName)}_[0-9]{8}_[0-9]{6}`);
  return `cd ${safeRoot} && find . -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex ${safeRegex} -print`;
}

function parseBackupDirectoryListOutput(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\.\//, ''))
    .filter(Boolean)
    .sort((a, b) => b.localeCompare(a, 'zh-Hans-CN'));
}

function buildBackupDirectoryNamePattern(folderName) {
  return new RegExp(`^${escapePosixExtendedRegex(folderName)}_\\d{8}_\\d{6}$`);
}

function normalizeRequestedBackupDirectories(queryValue) {
  const values = Array.isArray(queryValue) ? queryValue : [queryValue];
  return Array.from(new Set(values
    .map((item) => String(item || '').trim().replace(/^\.\//, ''))
    .filter(Boolean)));
}

function buildDeleteBackupDirectoriesCommand(rootPath, directoryNames) {
  const safeRoot = quoteShellArg(rootPath);
  const targets = directoryNames.map((name) => quoteShellArg(`./${name}`)).join(' ');
  return `cd ${safeRoot} && rm -rf -- ${targets}`;
}

function chunkItems(items, size) {
  const result = [];
  const chunkSize = Math.max(1, Number(size) || 1);
  for (let index = 0; index < items.length; index += chunkSize) {
    result.push(items.slice(index, index + chunkSize));
  }
  return result;
}

function execRemoteCommand(conn, command, onLine) {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) {
        reject(new Error('远程命令执行失败: ' + err.message));
        return;
      }

      let stdout = '';
      let stderr = '';

      stream.on('data', (data) => {
        const text = data.toString();
        stdout += text;
        text.split(/\r?\n/).filter(Boolean).forEach((line) => onLine?.(line));
      });

      stream.stderr.on('data', (data) => {
        const text = data.toString();
        stderr += text;
        text.split(/\r?\n/).filter(Boolean).forEach((line) => onLine?.(line));
      });

      stream.on('close', (code) => {
        if (code !== 0) {
          const message = String(stderr || stdout || '').trim();
          reject(new Error(message || `命令执行失败(code ${code})`));
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  });
}

app.post('/api/pack/:id', async (req, res) => {
  const data = loadData();
  const project = data.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  if (!project.dirPath || !fs.existsSync(project.dirPath)) return res.status(400).json({ error: '项目路径不存在' });

  const packOptions = req.body && typeof req.body === 'object' ? req.body : {};
  const useAutoStash = Boolean(packOptions.autoStash);
  const linkedTargetIds = sanitizeTargetIds(data.servers, project.targetIds);
  const targetIds = Array.isArray(packOptions.targetIds)
    ? sanitizeTargetIds(data.servers, packOptions.targetIds).filter((id) => linkedTargetIds.includes(id))
    : linkedTargetIds;
  if (!targetIds.length) {
    return res.status(400).json({ error: '该项目尚未关联有效的部署目标，无法打包' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, payload) => {
    res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
  };

  const branchCheck = checkProjectBranch(project);
  if (!branchCheck.ok) {
    send('error', { text: branchCheck.message });
    return res.end();
  }
  send('log', { text: `分支校验通过: ${branchCheck.currentBranch}` });

  let stashState = null;
  if (useAutoStash) {
    try {
      send('log', { text: '检测到用户选择自动储藏，正在保存未提交代码...' });
      stashState = createPackGitStash(project);
      if (stashState.created) {
        send('log', { text: `已创建临时储藏: ${stashState.ref}（${stashState.status.count} 项变更）` });
      } else {
        send('log', { text: '当前工作区已无未提交代码，无需创建储藏。' });
      }
    } catch (err) {
      send('error', { text: `创建 Git 储藏失败: ${err.message}` });
      return res.end();
    }
  }

  let ended = false;
  const finishPack = (payload) => {
    if (ended) return;
    ended = true;

    if (stashState?.created) {
      try {
        const restored = restorePackGitStash(project.dirPath, stashState);
        if (restored.restored) {
          send('log', { text: `已还原临时储藏: ${restored.ref}` });
        }
      } catch (err) {
        send('error', {
          text: `打包流程结束，但自动还原储藏失败: ${err.message}`
        });
        return res.end();
      }
    }

    send('done', payload);
    res.end();
  };

  const results = [];
  for (let index = 0; index < targetIds.length; index++) {
    const pathId = targetIds[index];
    const found = findPathById(data.servers, pathId);
    if (!found) continue;

    const targetLabel = `${found.server.name} ${found.path.deployPath}`;
    const buildCmd = resolveProjectBuildCmd(project, pathId);
    send('log', { text: `── 打包目标 ${index + 1}/${targetIds.length}: ${targetLabel} ──` });
    send('log', { text: `构建命令: ${buildCmd}` });

    const result = await packProjectForTarget(project, pathId, buildCmd, send);
    if (result.success) {
      const current = data.projects.find(p => p.id === project.id);
      if (current) {
        current.packs = current.packs && typeof current.packs === 'object' ? current.packs : {};
        current.packs[pathId] = result.pack;
        saveData(data);
      }
      send('log', { text: `目标打包完成: ${result.pack.zipName}` });
      results.push({ targetId: pathId, label: targetLabel, success: true, zipName: result.pack.zipName, packTime: result.pack.packTime });
    } else {
      send('log', { text: `目标打包失败: ${targetLabel}` });
      send('log', { text: `失败原因: ${result.error}` });
      results.push({ targetId: pathId, label: targetLabel, success: false, error: result.error });
    }
  }

  const successCount = results.filter(item => item.success).length;
  const failedCount = results.length - successCount;
  send('log', { text: `打包结束: 成功 ${successCount} 个 / 失败 ${failedCount} 个` });
  finishPack({ success: failedCount === 0, results, successCount, failedCount });
});

// 构建输出目录探测：优先最近修改的常见产物目录，其次唯一修改目录
function detectBuildOutputDir(dirPath) {
  const startTime = Date.now() - 3600000;
  const ignoreDirs = new Set(['node_modules', '.git', '.vscode', '.idea']);
  const preferredOutputDirs = BUILD_OUTPUT_DIRS;
  const nonOutputLikelyDirs = new Set(['src', 'public', 'docs', 'doc', 'scripts', 'script', 'config', 'configs', 'test', 'tests', '__tests__', 'coverage']);

  const dirEntries = fs.readdirSync(dirPath)
    .map((name) => {
      if (ignoreDirs.has(name)) return null;
      const absPath = path.join(dirPath, name);
      try {
        const stat = fs.statSync(absPath);
        if (!stat.isDirectory()) return null;
        return { name, absPath, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const modifiedDirs = dirEntries.filter((item) => item.mtimeMs >= startTime);
  const byNewest = (a, b) => b.mtimeMs - a.mtimeMs;
  const findPreferred = (list) => list
    .filter((item) => preferredOutputDirs.includes(item.name.toLowerCase()))
    .sort(byNewest);

  let pickedDir = null;

  const preferredModified = findPreferred(modifiedDirs);
  if (preferredModified.length) {
    pickedDir = preferredModified[0];
  } else if (modifiedDirs.length === 1) {
    pickedDir = modifiedDirs[0];
  } else if (modifiedDirs.length > 1) {
    const likelyOutputDirs = modifiedDirs
      .filter((item) => !nonOutputLikelyDirs.has(item.name.toLowerCase()))
      .sort(byNewest);
    pickedDir = (likelyOutputDirs[0] || modifiedDirs.sort(byNewest)[0]);
  }

  if (!pickedDir) {
    const preferredAny = findPreferred(dirEntries);
    if (preferredAny.length) pickedDir = preferredAny[0];
  }

  return pickedDir;
}

// 单目标打包：执行该目标的构建命令 → 探测输出目录 → 生成该目标专属 zip。结果以 Promise 返回，不抛出。
async function packProjectForTarget(project, targetId, buildCmd, send) {
  const oldPack = project.packs?.[targetId];
  if (oldPack?.zipPath && fs.existsSync(oldPack.zipPath)) {
    fs.removeSync(oldPack.zipPath);
  }

  const exitCode = await new Promise((resolve) => {
    const child = spawn(buildCmd, { cwd: project.dirPath, shell: true });
    child.stdout.on('data', (chunk) => {
      chunk.toString().split('\n').filter(Boolean).forEach(line => send('log', { text: line }));
    });
    child.stderr.on('data', (chunk) => {
      chunk.toString().split('\n').filter(Boolean).forEach(line => send('log', { text: line }));
    });
    child.on('error', (err) => {
      send('log', { text: `构建命令启动失败: ${err.message}` });
      resolve(-1);
    });
    child.on('close', (code) => resolve(code));
  });
  if (exitCode !== 0) {
    return { success: false, error: `构建失败 (exit code ${exitCode})` };
  }

  send('log', { text: '构建完成，检测输出目录...' });
  const pickedDir = detectBuildOutputDir(project.dirPath);
  if (!pickedDir) {
    return { success: false, error: '未检测到可打包的构建输出目录' };
  }

  const packDirName = pickedDir.name;
  const shortId = String(targetId).replace(/-/g, '').slice(0, 6);
  const zipName = `${packDirName || project.projectName}_${shortId}.zip`;
  const zipPath = path.join(project.dirPath, zipName);
  send('log', { text: `打包目录: ${packDirName}` });

  try {
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      archive.directory(pickedDir.absPath, packDirName, (entry) => {
        if (entry.name.endsWith('.zip') || entry.name === 'node_modules') return false;
        return entry;
      });
      archive.finalize();
    });

    const stat = fs.statSync(zipPath);
    send('log', { text: `压缩完成: ${zipName} (${(stat.size / 1024 / 1024).toFixed(2)} MB)` });
    return {
      success: true,
      pack: {
        zipPath,
        zipName,
        packDirName,
        packTime: new Date().toLocaleString('zh-CN')
      }
    };
  } catch (err) {
    return { success: false, error: '打包失败: ' + err.message };
  }
}

function formatRemoteTimestamp(now = new Date()) {
  return now.getFullYear().toString() +
    String(now.getMonth() + 1).padStart(2, '0') +
    String(now.getDate()).padStart(2, '0') +
    '_' +
    String(now.getHours()).padStart(2, '0') +
    String(now.getMinutes()).padStart(2, '0') +
    String(now.getSeconds()).padStart(2, '0');
}

// 单目标部署：连接 → SFTP 上传 → 远程备份旧目录 → 解压。结果以 Promise 返回，不抛出。
function deployProjectToTarget(project, server, pathEntry, send) {
  return new Promise((resolve) => {
    const finish = (result) => {
      try { conn.end(); } catch {}
      resolve(result);
    };

    const deployPath = pathEntry.deployPath;
    const pack = project.packs?.[pathEntry.id];
    const zipPath = pack?.zipPath || '';
    const deployZipName = pack?.zipName || path.basename(zipPath);
    const remoteZipPath = `${deployPath}/${deployZipName}`;
    const zipFolderName = resolveProjectDeployFolderName(project, pathEntry.id);

    if (!zipPath || !fs.existsSync(zipPath)) {
      resolve({ success: false, error: '该目标尚未打包（请先在“打包”中选择此目标执行构建）' });
      return;
    }

    const conn = new Client();
    send('log', { text: `连接服务器 ${server.name}（${server.host}:${server.port || 22}）...` });

    conn.on('ready', () => {
      send('log', { text: 'SSH 连接成功' });
      conn.sftp((err, sftp) => {
        if (err) return finish({ success: false, error: 'SFTP 连接失败: ' + err.message });

        send('log', { text: `上传 ${deployZipName} -> ${remoteZipPath}` });
        const localStream = fs.createReadStream(zipPath);
        const remoteStream = sftp.createWriteStream(remoteZipPath);

        remoteStream.on('close', () => {
          send('log', { text: '上传完成' });

          if (!zipFolderName) {
            return finish({ success: false, error: '缺少部署目录名称，请先至少打包一次项目' });
          }

          const ts = formatRemoteTimestamp();
          const backupRootPath = String(pathEntry.backupPath || '').trim() || deployPath;
          const commands = [
            { cmd: `mkdir -p ${quoteShellArg(backupRootPath)} && cd ${quoteShellArg(deployPath)} && if [ -d ${quoteShellArg(zipFolderName)} ]; then mv ${quoteShellArg(zipFolderName)} ${quoteShellArg(`${backupRootPath}/${zipFolderName}_${ts}`)}; fi`, desc: `备份 ${zipFolderName} -> ${backupRootPath}/${zipFolderName}_${ts}` },
            { cmd: `unzip -o ${quoteShellArg(remoteZipPath)} -d ${quoteShellArg(deployPath)}`, desc: `解压 ${deployZipName}` }
          ];

          let cmdIdx = 0;
          const runNext = () => {
            if (cmdIdx >= commands.length) {
              return finish({ success: true, deployTime: new Date().toLocaleString('zh-CN') });
            }

            const { cmd, desc } = commands[cmdIdx];
            send('log', { text: `$ ${desc}` });
            conn.exec(cmd, (err, stream) => {
              if (err) return finish({ success: false, error: '远程命令执行失败: ' + err.message });
              let stderr = '';
              stream.on('data', (data) => {
                data.toString().split('\n').filter(Boolean).forEach(line => send('log', { text: line }));
              });
              stream.stderr.on('data', (data) => { stderr += data; });
              stream.on('close', (code) => {
                if (code !== 0) return finish({ success: false, error: `命令执行失败(code ${code}): ${stderr}` });
                cmdIdx++;
                runNext();
              });
            });
          };
          runNext();
        });

        remoteStream.on('error', (err) => finish({ success: false, error: '上传失败: ' + err.message }));
        localStream.pipe(remoteStream);
      });
    });

    conn.on('error', (err) => finish({ success: false, error: 'SSH 连接失败: ' + err.message }));
    conn.connect(buildSshConnConfig(server));
  });
}

app.post('/api/deploy/:id', async (req, res) => {
  let data;
  try {
    data = loadData();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  const project = data.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: '项目不存在' });

  const linkedTargetIds = sanitizeTargetIds(data.servers, project.targetIds);
  const requestedTargetIds = Array.isArray(req.body?.targetIds)
    ? sanitizeTargetIds(data.servers, req.body.targetIds)
    : linkedTargetIds;
  const targetIds = requestedTargetIds.filter((id) => linkedTargetIds.includes(id));
  if (!targetIds.length) {
    return res.status(400).json({ error: '该项目尚未关联有效的部署目标' });
  }

  const unpackedTargets = targetIds.filter((id) => {
    const zipPath = project.packs?.[id]?.zipPath;
    return !zipPath || !fs.existsSync(zipPath);
  });
  if (unpackedTargets.length === targetIds.length) {
    return res.status(400).json({ error: '所选目标均未打包，请先在“打包”中选择目标执行构建' });
  }
  if (unpackedTargets.length) {
    const names = unpackedTargets.map((id) => {
      const found = findPathById(data.servers, id);
      return found ? `${found.server.name} ${found.path.deployPath}` : id;
    }).join('； ');
    return res.status(400).json({ error: `以下目标尚未打包，请先打包后再部署：${names}` });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, payload) => {
    res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
  };

  const branchCheck = checkProjectBranch(project);
  if (!branchCheck.ok) {
    send('error', { text: branchCheck.message });
    return res.end();
  }
  send('log', { text: `分支校验通过: ${branchCheck.currentBranch}` });

  const results = [];
  for (let index = 0; index < targetIds.length; index++) {
    const pathId = targetIds[index];
    const found = findPathById(data.servers, pathId);
    if (!found) continue;

    const { server, path: pathEntry } = found;
    const targetLabel = `${server.name} ${pathEntry.deployPath}`;
    send('log', { text: `── 目标 ${index + 1}/${targetIds.length}: ${targetLabel} ──` });

    const result = await deployProjectToTarget(project, server, pathEntry, send);
    if (result.success) {
      const deployTime = result.deployTime;
      send('log', { text: `目标部署成功: ${targetLabel}` });

      const current = data.projects.find(p => p.id === project.id);
      if (current) {
        current.deployStates = current.deployStates && typeof current.deployStates === 'object'
          ? current.deployStates
          : {};
        current.deployStates[pathId] = { lastDeployTime: deployTime, deployStatus: '已部署' };
        current.lastDeployTime = deployTime;
        current.deployStatus = '已部署';
        saveData(data);
      }
      results.push({ targetId: pathId, label: targetLabel, success: true, deployTime });
    } else {
      send('log', { text: `目标部署失败: ${targetLabel}` });
      send('log', { text: `失败原因: ${result.error}` });
      results.push({ targetId: pathId, label: targetLabel, success: false, error: result.error });
    }
  }

  const successCount = results.filter(item => item.success).length;
  const failedCount = results.length - successCount;
  send('log', { text: `部署结束: 成功 ${successCount} 个 / 失败 ${failedCount} 个` });
  send('done', { success: failedCount === 0, results, successCount, failedCount });
  res.end();
});

function resolveProjectTarget(data, projectId, targetId) {
  const project = data.projects.find(p => p.id === projectId);
  if (!project) return { error: '项目不存在', status: 404 };

  const linkedTargetIds = sanitizeTargetIds(data.servers, project.targetIds);
  if (!targetId || !linkedTargetIds.includes(targetId)) {
    return { error: '部署目标无效或未与该项目关联', status: 400 };
  }

  const found = findPathById(data.servers, targetId);
  if (!found) return { error: '部署目标不存在', status: 400 };
  return { project, server: found.server, pathEntry: found.path };
}

app.get('/api/list-backups/:id', (req, res) => {
  const data = loadData();
  const resolved = resolveProjectTarget(data, req.params.id, String(req.query.targetId || ''));
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  const { project, server, pathEntry } = resolved;

  const backupFolderName = resolveProjectDeployFolderName(project, pathEntry.id);
  if (!backupFolderName) {
    return res.status(400).json({ error: '缺少备份目录名称，请先至少打包一次项目后再试' });
  }

  const backupRootPath = String(pathEntry.backupPath || pathEntry.deployPath || '').trim();
  if (!backupRootPath) {
    return res.status(400).json({ error: '备份目录为空，无法读取列表' });
  }

  let responded = false;
  const conn = new Client();
  const done = (err, payload) => {
    if (responded) return;
    responded = true;
    try { conn.end(); } catch {}
    if (err) res.status(500).json({ error: err });
    else res.json(payload);
  };

  conn.on('ready', async () => {
    try {
      const listed = await execRemoteCommand(conn, buildBackupDirectoryFindCommand(backupRootPath, backupFolderName));
      const items = parseBackupDirectoryListOutput(listed.stdout);
      done(null, {
        success: true,
        backupRootPath,
        backupFolderName,
        items
      });
    } catch (err) {
      done(err.message || '读取备份目录失败');
    }
  });

  conn.on('error', (err) => done('SSH 连接失败: ' + err.message));

  conn.connect(buildSshConnConfig(server));
});

app.post('/api/delete-backups/:id', (req, res) => {
  const data = loadData();
  const resolved = resolveProjectTarget(data, req.params.id, String(req.body?.targetId || ''));
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  const { project, server, pathEntry } = resolved;

  const backupFolderName = resolveProjectDeployFolderName(project, pathEntry.id);
  if (!backupFolderName) {
    return res.status(400).json({ error: '缺少备份目录名称，请先至少打包一次项目后再试' });
  }

  const backupRootPath = String(pathEntry.backupPath || pathEntry.deployPath || '').trim();
  if (!backupRootPath) {
    return res.status(400).json({ error: '备份目录为空，无法执行删除' });
  }

  const requestedDirectories = normalizeRequestedBackupDirectories(req.body?.directories);
  if (!requestedDirectories.length) {
    return res.status(400).json({ error: '请先选择要删除的备份目录' });
  }

  const namePattern = buildBackupDirectoryNamePattern(backupFolderName);
  const invalidDirectories = requestedDirectories.filter((name) => {
    if (!namePattern.test(name)) return true;
    return name.includes('/') || name.includes('\\');
  });
  if (invalidDirectories.length) {
    return res.status(400).json({ error: `存在非法备份目录名: ${invalidDirectories.join(', ')}` });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, payload) => {
    res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
  };

  let responded = false;
  const conn = new Client();
  const done = (err, payload) => {
    if (responded) return;
    responded = true;
    try { conn.end(); } catch {}
    if (err) send('error', { text: err });
    else send('done', payload);
    res.end();
  };

  send('log', { text: `连接服务器 ${server.name}（${server.host}:${server.port || 22}）...` });

  conn.on('ready', async () => {
    send('log', { text: 'SSH 连接成功' });
    send('log', { text: `备份目录: ${backupRootPath}` });
    send('log', { text: `匹配规则: ${backupFolderName}_YYYYMMDD_HHmmss` });

    try {
      send('log', { text: '$ 复核备份目录' });
      const listed = await execRemoteCommand(conn, buildBackupDirectoryFindCommand(backupRootPath, backupFolderName));
      const existingDirectories = parseBackupDirectoryListOutput(listed.stdout);
      const existingSet = new Set(existingDirectories);
      const directoriesToDelete = requestedDirectories.filter((name) => existingSet.has(name));
      const missingDirectories = requestedDirectories.filter((name) => !existingSet.has(name));

      if (missingDirectories.length) {
        missingDirectories.forEach((name) => send('log', { text: `已跳过不存在的目录: ${name}` }));
      }

      if (!directoriesToDelete.length) {
        send('log', { text: '选中的备份目录都不存在，无需删除。' });
        return done(null, {
          success: true,
          deletedCount: 0,
          deletedDirectories: [],
          missingDirectories
        });
      }

      directoriesToDelete.forEach((name) => send('log', { text: `待删除: ${name}` }));
      const deleteBatches = chunkItems(directoriesToDelete, 20);
      for (let batchIndex = 0; batchIndex < deleteBatches.length; batchIndex += 1) {
        const currentBatch = deleteBatches[batchIndex];
        send('log', { text: `$ 执行删除批次 ${batchIndex + 1}/${deleteBatches.length}` });
        await execRemoteCommand(conn, buildDeleteBackupDirectoriesCommand(backupRootPath, currentBatch));
      }

      send('log', { text: `删除完成，共删除 ${directoriesToDelete.length} 个备份目录。` });
      done(null, {
        success: true,
        deletedCount: directoriesToDelete.length,
        deletedDirectories: directoriesToDelete,
        missingDirectories
      });
    } catch (err) {
      done(err.message || '删除备份目录失败');
    }
  });

  conn.on('error', (err) => done('SSH 连接失败: ' + err.message));

  conn.connect(buildSshConnConfig(server));
});

app.post('/api/rollback/:id', (req, res) => {
  const data = loadData();
  const resolved = resolveProjectTarget(data, req.params.id, String(req.body?.targetId || ''));
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  const { project, server, pathEntry } = resolved;

  const backupFolderName = resolveProjectDeployFolderName(project, pathEntry.id);
  if (!backupFolderName) {
    return res.status(400).json({ error: '缺少部署目录名称，请先至少打包一次项目后再试' });
  }

  const requestedDirectory = String(req.body?.directory || '').trim().replace(/^\.\//, '');
  const namePattern = buildBackupDirectoryNamePattern(backupFolderName);
  if (!requestedDirectory || !namePattern.test(requestedDirectory) || requestedDirectory.includes('/') || requestedDirectory.includes('\\')) {
    return res.status(400).json({ error: `备份目录名不合法: ${requestedDirectory || '(空)'}` });
  }

  const deployPath = String(pathEntry.deployPath || '').trim();
  const backupRootPath = String(pathEntry.backupPath || pathEntry.deployPath || '').trim();
  if (!deployPath || !backupRootPath) {
    return res.status(400).json({ error: '部署路径为空，无法回滚' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, payload) => {
    res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
  };

  let responded = false;
  const conn = new Client();
  const done = (err, payload) => {
    if (responded) return;
    responded = true;
    try { conn.end(); } catch {}
    if (err) send('error', { text: err });
    else send('done', payload);
    res.end();
  };

  send('log', { text: `连接服务器 ${server.name}（${server.host}:${server.port || 22}）...` });

  conn.on('ready', async () => {
    send('log', { text: 'SSH 连接成功' });
    send('log', { text: `目标：${deployPath}/${backupFolderName}` });
    send('log', { text: `备份目录：${backupRootPath}` });

    try {
      send('log', { text: `$ 复核备份目录 ${requestedDirectory}` });
      await execRemoteCommand(conn, `cd ${quoteShellArg(backupRootPath)} && test -d ${quoteShellArg(`./${requestedDirectory}`)}`);

      const stampName = `${backupFolderName}_${formatRemoteTimestamp()}`;
      send('log', { text: `$ 保存当前线上目录为新备份 ${stampName}` });
      await execRemoteCommand(conn, `mkdir -p ${quoteShellArg(backupRootPath)} && cd ${quoteShellArg(deployPath)} && if [ -d ${quoteShellArg(backupFolderName)} ]; then mv ${quoteShellArg(backupFolderName)} ${quoteShellArg(`${backupRootPath}/${stampName}`)}; fi`);

      send('log', { text: `$ 恢复备份 ${requestedDirectory} 为线上目录` });
      await execRemoteCommand(conn, `cd ${quoteShellArg(backupRootPath)} && cp -a ${quoteShellArg(`./${requestedDirectory}`)} ${quoteShellArg(`${deployPath}/${backupFolderName}`)}`);

      const rollbackTime = new Date().toLocaleString('zh-CN');
      const current = data.projects.find(p => p.id === project.id);
      if (current) {
        current.deployStates = current.deployStates && typeof current.deployStates === 'object'
          ? current.deployStates
          : {};
        current.deployStates[pathEntry.id] = { lastDeployTime: rollbackTime, deployStatus: '已回滚' };
        current.lastDeployTime = rollbackTime;
        current.deployStatus = '已回滚';
        saveData(data);
      }

      send('log', { text: `回滚完成: ${requestedDirectory} 已恢复为线上目录（所选备份已保留）` });
      done(null, { success: true, rollbackTime, restoredDirectory: requestedDirectory });
    } catch (err) {
      done(err.message || '回滚失败');
    }
  });

  conn.on('error', (err) => done('SSH 连接失败: ' + err.message));

  conn.connect(buildSshConnConfig(server));
});

app.post('/api/open-folder', (req, res) => {
  try {
    const { dirPath } = req.body;
    if (!dirPath || !fs.existsSync(dirPath)) return res.status(400).json({ error: '路径不存在' });
    const child = spawn('explorer.exe', [dirPath], { detached: true, stdio: 'ignore' });
    child.unref();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/open-zip-folder', (req, res) => {
  try {
    const { zipPath } = req.body;
    if (!zipPath || !fs.existsSync(zipPath)) return res.status(400).json({ error: '压缩包不存在' });
    const child = spawn('explorer.exe', [`/select,${zipPath}`], { detached: true, stdio: 'ignore' });
    child.unref();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function normalizeExternalAccessUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    return parsed.toString();
  } catch {
    return '';
  }
}

function openExternalAccessUrl(rawUrl) {
  const accessUrl = normalizeExternalAccessUrl(rawUrl);
  if (!accessUrl) {
    throw new Error('访问地址无效，仅支持 http 或 https 地址');
  }

  let command = '';
  let args = [];
  if (process.platform === 'win32') {
    command = 'explorer.exe';
    args = [accessUrl];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [accessUrl];
  } else {
    command = 'xdg-open';
    args = [accessUrl];
  }

  const result = spawnSync(command, args, {
    stdio: 'ignore',
    windowsHide: true
  });

  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(`${command} 执行失败 (exit code ${result.status})`);
  }

  return accessUrl;
}

app.post('/api/open-access-url', (req, res) => {
  try {
    const accessUrl = openExternalAccessUrl(req.body?.accessUrl);
    res.json({ success: true, accessUrl });
  } catch (err) {
    const message = err?.message || '打开访问地址失败';
    const status = message.includes('访问地址无效') ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

const server = app.listen(PORT, HOST, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : PORT;
  if (REQUESTED_HOST !== HOST) {
    console.warn(`已忽略非本机监听地址 ${REQUESTED_HOST}，改用 ${HOST}`);
  }
  console.log(`服务已启动: http://${HOST}:${actualPort}`);
});

server.on('error', (err) => {
  console.error('服务启动失败:', err.message);
  process.exit(1);
});

