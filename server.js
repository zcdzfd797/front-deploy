const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const { execSync, exec, spawn, spawnSync } = require('child_process');
const archiver = require('archiver');
const { Client } = require('ssh2');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

const app = express();
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;
const APP_INSTANCE_ID = process.env.APP_INSTANCE_ID || "";
const DATA_FILE = path.join(__dirname, 'projects.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/_health', (req, res) => {
  res.json({ ok: true, instanceId: APP_INSTANCE_ID });
});

const upload = multer({ dest: path.join(__dirname, 'temp') });

function loadProjects() {
  if (!fs.existsSync(DATA_FILE)) return [];
  return fs.readJsonSync(DATA_FILE);
}

function saveProjects(projects) {
  fs.writeJsonSync(DATA_FILE, projects, { spaces: 2 });
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
    shell: false
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

function getGitSyncInfo(project) {
  const dirPath = project?.dirPath;
  if (!dirPath || !fs.existsSync(dirPath)) {
    throw new Error('项目路径不存在');
  }
  if (!fs.existsSync(path.join(dirPath, '.git'))) {
    throw new Error('项目路径不是 Git 仓库');
  }

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
      return res.status(400).json({ error: '璺緞涓嶅瓨鍦ㄦ垨涓嶆槸Git浠撳簱' });
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

app.post('/api/projects', (req, res) => {
  try {
    const projects = loadProjects();
    const project = {
      id: uuidv4(),
      ...req.body,
      createdAt: new Date().toISOString(),
      lastDeployTime: null,
      deployStatus: '未部署'
    };
    projects.push(project);
    saveProjects(projects);
    res.json(project);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/projects/:id', (req, res) => {
  try {
    const projects = loadProjects();
    const idx = projects.findIndex(p => p.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: '项目不存在' });
    projects[idx] = { ...projects[idx], ...req.body };
    saveProjects(projects);
    res.json(projects[idx]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/projects/:id', (req, res) => {
  try {
    let projects = loadProjects();
    projects = projects.filter(p => p.id !== req.params.id);
    saveProjects(projects);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/projects', (req, res) => {
  const projects = loadProjects();
  projects.forEach(p => {
    if (p.zipPath) {
      p.zipExists = fs.existsSync(p.zipPath);
      if (p.zipExists) {
        const stat = fs.statSync(p.zipPath);
        p.zipSize = (stat.size / 1024 / 1024).toFixed(2) + ' MB';
      } else {
        p.zipSize = null;
      }
    } else {
      p.zipExists = false;
      p.zipSize = null;
    }
  });
  res.json(projects);
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

app.get('/api/pack/:id', (req, res) => {
  const projects = loadProjects();
  const project = projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: '项目不存在' });
  if (!project.dirPath || !fs.existsSync(project.dirPath)) return res.status(400).json({ error: '项目路径不存在' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  const branchCheck = checkProjectBranch(project);
  if (!branchCheck.ok) {
    send('error', { text: branchCheck.message });
    return res.end();
  }
  send('log', { text: `分支校验通过: ${branchCheck.currentBranch}` });

  const buildCmd = project.buildCmd || 'npm run build';
  if (project.zipPath && fs.existsSync(project.zipPath)) {
    fs.removeSync(project.zipPath);
  }

  send('log', { text: `$ ${buildCmd}` });
  const parts = buildCmd.split(' ');
  const child = spawn(parts[0], parts.slice(1), { cwd: project.dirPath, shell: true });

  child.stdout.on('data', (data) => {
    data.toString().split('\n').filter(Boolean).forEach(line => send('log', { text: line }));
  });
  child.stderr.on('data', (data) => {
    data.toString().split('\n').filter(Boolean).forEach(line => send('log', { text: line }));
  });

  child.on('close', async (code) => {
    if (code !== 0) {
      send('error', { text: `构建失败 (exit code ${code})` });
      return res.end();
    }

    send('log', { text: '构建完成，检测输出目录...' });

    const startTime = Date.now() - 3600000;
    const ignoreDirs = new Set(['node_modules', '.git', '.vscode', '.idea']);
    const preferredOutputDirs = ['dist', 'build', 'out', 'release', 'output', 'www', 'web-build', '.output', '.next', '.nuxt', 'storybook-static'];
    const nonOutputLikelyDirs = new Set(['src', 'public', 'docs', 'doc', 'scripts', 'script', 'config', 'configs', 'test', 'tests', '__tests__', 'coverage']);

    const dirEntries = fs.readdirSync(project.dirPath)
      .map((name) => {
        if (ignoreDirs.has(name)) return null;
        const absPath = path.join(project.dirPath, name);
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

    if (!pickedDir) {
      send('error', { text: '未检测到可打包的构建输出目录' });
      return res.end();
    }

    const packDir = pickedDir.absPath;
    const packDirName = pickedDir.name;

    send('log', { text: `打包目录: ${packDirName}` });

    const zipName = `${packDirName || project.projectName}.zip`;
    const zipPath = path.join(project.dirPath, zipName);

    try {
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);
        archive.directory(packDir, packDirName, (entry) => {
          if (entry.name.endsWith('.zip') || entry.name === 'node_modules') return false;
          return entry;
        });
        archive.finalize();
      });

      const stat = fs.statSync(zipPath);
      const idx = projects.findIndex(p => p.id === project.id);
      projects[idx].zipPath = zipPath;
      projects[idx].zipName = zipName;
      projects[idx].packDirName = packDirName;
      projects[idx].packTime = new Date().toLocaleString('zh-CN');
      saveProjects(projects);

      send('log', { text: `打包完成: ${zipName} (${(stat.size / 1024 / 1024).toFixed(2)} MB)` });
      send('done', { success: true });
    } catch (err) {
      send('error', { text: '打包失败: ' + err.message });
    }
    res.end();
  });
});

app.get('/api/deploy/:id', (req, res) => {
  const projects = loadProjects();
  const project = projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: '项目不存在' });

  const { deploy } = project;
  if (!deploy || !deploy.host || !deploy.username || !deploy.deployPath) {
    return res.status(400).json({ error: '部署信息不完整' });
  }
  if (!project.zipPath || !fs.existsSync(project.zipPath)) {
    return res.status(400).json({ error: '请先打包项目' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  const branchCheck = checkProjectBranch(project);
  if (!branchCheck.ok) {
    send('error', { text: branchCheck.message });
    return res.end();
  }
  send('log', { text: `分支校验通过: ${branchCheck.currentBranch}` });

  let responded = false;
  const done = (err, data) => {
    if (responded) return;
    responded = true;
    try { conn.end(); } catch {}
    if (err) send('error', { text: err });
    else send('done', data);
    res.end();
  };

  const zipPath = project.zipPath;
  const deployZipName = project.zipName || path.basename(zipPath);
  send('log', { text: `连接服务器 ${deploy.host}:${deploy.port || 22} ...` });

  const conn = new Client();
  conn.on('ready', () => {
    send('log', { text: 'SSH 连接成功' });
    conn.sftp((err, sftp) => {
      if (err) return done('SFTP 连接失败: ' + err.message);

      const remoteZipPath = `${deploy.deployPath}/${deployZipName}`;
      send('log', { text: `上传 ${deployZipName} -> ${remoteZipPath}` });

      const localStream = fs.createReadStream(zipPath);
      const remoteStream = sftp.createWriteStream(remoteZipPath);

      remoteStream.on('close', () => {
        send('log', { text: '上传完成' });

        const now = new Date();
        const ts = now.getFullYear().toString() +
          String(now.getMonth() + 1).padStart(2, '0') +
          String(now.getDate()).padStart(2, '0') +
          '_' +
          String(now.getHours()).padStart(2, '0') +
          String(now.getMinutes()).padStart(2, '0') +
          String(now.getSeconds()).padStart(2, '0');

        const zipFolderName = project.packDirName || path.basename(project.zipPath, '.zip');
        const commands = [
          { cmd: `cd "${deploy.deployPath}" && if [ -d "${zipFolderName}" ]; then mv "${zipFolderName}" "${zipFolderName}_${ts}"; fi`, desc: `备份 ${zipFolderName} -> ${zipFolderName}_${ts}` },
          { cmd: `unzip -o "${remoteZipPath}" -d "${deploy.deployPath}"`, desc: `解压 ${deployZipName}` }
        ];

        let cmdIdx = 0;
        const runNext = () => {
          if (cmdIdx >= commands.length) {
            const deployTime = new Date().toLocaleString('zh-CN');
            const idx = projects.findIndex(p => p.id === project.id);
            if (idx !== -1) {
              projects[idx].lastDeployTime = deployTime;
              projects[idx].deployStatus = '已部署';
              saveProjects(projects);
            }
            return done(null, { success: true, deployTime });
          }

          const { cmd, desc } = commands[cmdIdx];
          send('log', { text: `$ ${desc}` });
          conn.exec(cmd, (err, stream) => {
            if (err) return done('远程命令执行失败: ' + err.message);
            let stderr = '';
            stream.on('data', (data) => {
              data.toString().split('\n').filter(Boolean).forEach(line => send('log', { text: line }));
            });
            stream.stderr.on('data', (data) => { stderr += data; });
            stream.on('close', (code) => {
              if (code !== 0) return done(`命令执行失败(code ${code}): ${stderr}`);
              cmdIdx++;
              runNext();
            });
          });
        };
        runNext();
      });

      remoteStream.on('error', (err) => done('上传失败: ' + err.message));
      localStream.pipe(remoteStream);
    });
  });

  conn.on('error', (err) => done('SSH 连接失败: ' + err.message));

  const connConfig = { host: deploy.host, port: deploy.port || 22, username: deploy.username };
  if (deploy.privateKey) connConfig.privateKey = deploy.privateKey;
  else if (deploy.password) connConfig.password = deploy.password;

  conn.connect(connConfig);
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

const server = app.listen(PORT, HOST, () => {
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : PORT;
  console.log(`服务已启动: http://${HOST}:${actualPort}`);
});

server.on('error', (err) => {
  console.error('服务启动失败:', err.message);
  process.exit(1);
});

