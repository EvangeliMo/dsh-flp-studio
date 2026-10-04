/**
 * Shared host helpers for dsh-flp-studio: the Python-bridge runner and small
 * utilities. Used by both the TypertRemoteService (lib/index.js) and the
 * agent-tool plugin (lib/tools.js).
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BRIDGE = join(__dirname, '..', 'python', 'bridge.py');

export const PYTHON = process.env.FLP_STUDIO_PYTHON
  || process.env.PYTHON
  || 'python';

export function ok(payload) { return { ok: true, ...payload }; }
export function err(message, detail = null) { return { ok: false, message, detail }; }

/** Run the python bridge: `python bridge.py <mode> <path>` with spec via stdin. */
export function runBridge(mode, target, spec = null, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const args = [BRIDGE, mode, target];
    const child = spawn(PYTHON, args, {
      cwd: dirname(BRIDGE),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Python's stdout defaults to the local codepage (GBK on zh-CN Windows),
      // which corrupts Chinese paths when Node decodes as UTF-8. Force UTF-8.
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* noop */ } }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve(err(`无法启动 Python: ${e.message}。请确认已安装 Python 并执行 pip install pyflp`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const trimmed = stdout.trim();
      if (code !== 0 || !trimmed) {
        resolve(err(`bridge 退出码 ${code}${stderr ? '：' + stderr.slice(0, 300) : ''}`));
        return;
      }
      try {
        const data = JSON.parse(trimmed);
        resolve(data.ok ? ok(data) : err(data.message || 'bridge 返回错误', data));
      } catch {
        resolve(err('bridge 输出无法解析: ' + trimmed.slice(0, 200)));
      }
    });
    if (spec !== null) child.stdin.write(JSON.stringify(spec));
    child.stdin.end();
  });
}

/** Resolve a default browsable directory (user Documents FL Studio projects). */
export function defaultDir() {
  const home = process.env.USERPROFILE || process.env.HOME || '.';
  const docs = process.env.USERPROFILE
    ? join(process.env.USERPROFILE, 'Documents', 'Image-Line', 'FL Studio', 'Projects')
    : join(home, 'Documents');
  return docs;
}
