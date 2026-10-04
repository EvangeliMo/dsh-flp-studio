/**
 * dsh-flp-studio host service.
 *
 * Three Typert Remotes over the api gateway (browser-origin trust fence):
 *  - flp/listdir(directory)  : list *.flp/.fsc/.fst under a directory
 *  - flp/analyze(path)       : full project structure + music feature analysis
 *  - flp/editNote(path, spec): apply note edits to a COPY (auto-backup first),
 *                              then atomically replace the original.
 *
 * All heavy lifting happens in a local Python process running PyFLP
 * (python/bridge.py, one-shot JSON-in/JSON-out). The plugin never embeds
 * Python; it shells out to the user's Python that has pyflp installed.
 */
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { existsSync, copyFileSync, renameSync, mkdirSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runBridge, defaultDir, ok, err } from './bridge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Open a native Win32 OpenFileDialog (via a temp PowerShell script) filtered
 *  to FL files. Brings the dialog to the FRONT of the browser window using:
 *   1. keybd_event ALT trick — unlocks Windows' foreground-lock so a
 *      background-spawned process may take the foreground;
 *   2. a Timer that repeatedly calls SetForegroundWindow once the dialog is up.
 *  The script runs from a temp .ps1 file (UTF-8 BOM) to avoid `-Command`
 *  quoting/encoding pitfalls with non-ASCII paths. */
function pickFileDialog(initialDir = '') {
  return new Promise((resolve) => {
    const init = (initialDir || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = [
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type @"',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public class FgWin {',
      '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
      '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
      '  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);',
      '}',
      '"@',
      // Unlock Windows foreground lock (classic trick): simulate ALT press/release.
      '[FgWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)',
      '[FgWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)',
      '$dlg = New-Object System.Windows.Forms.OpenFileDialog',
      '$dlg.Title = "Pick FL Studio project file"',
      '$dlg.Filter = "FL Studio Project (*.flp)|*.flp|FL Preset (*.fst)|*.fst|FL Score (*.fsc)|*.fsc|All files (*.*)|*.*"',
      `$dlg.InitialDirectory = "${init}"`,
      '$dlg.Multiselect = $false',
      // After the dialog opens, yank it to the foreground several times.
      '$script:attempts = 0',
      '$timer = New-Object System.Windows.Forms.Timer',
      '$timer.Interval = 500',
      '$timer.Add_Tick({',
      '  $script:attempts++',
      '  try {',
      '    $h = $dlg.Handle',
      '    [FgWin]::ShowWindow($h, 9) | Out-Null',
      '    [FgWin]::SetForegroundWindow($h) | Out-Null',
      '  } catch {}',
      '  if ($script:attempts -ge 4) { $timer.Stop() }',
      '})',
      '$timer.Start()',
      'if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dlg.FileName } else { "" }',
    ].join('\n');

    const tmpFile = join(tmpdir(), `dsh-flp-pick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
    try {
      // UTF-8 BOM so Windows PowerShell 5.1 reads the file as UTF-8.
      writeFileSync(tmpFile, '\ufeff' + script, 'utf8');
    } catch (e) {
      resolve(err(`无法写入选择器脚本: ${e.message}`));
      return;
    }

    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmpFile], {
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* noop */ } }, 120000);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      try { unlinkSync(tmpFile); } catch { /* noop */ }
      resolve(err(`无法打开文件选择器: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try { unlinkSync(tmpFile); } catch { /* noop */ }
      const picked = stdout.trim();
      if (picked) resolve(ok({ path: picked, cancelled: false }));
      else resolve(ok({ path: null, cancelled: true }));
    });
  });
}

let FlpStudioService = (() => {
    let _classSuper = TypertRemoteService;
    let _instanceExtraInitializers = [];
    let _listdir_decorators;
    let _analyze_decorators;
    let _editNote_decorators;
    let _pickFile_decorators;
    return class FlpStudioService extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _listdir_decorators = [Remote('listdir')];
            _analyze_decorators = [Remote('analyze')];
            _editNote_decorators = [Remote('editNote')];
            _pickFile_decorators = [Remote('pickFile')];
            __esDecorate(this, null, _listdir_decorators, { kind: "method", name: "listdir", static: false, private: false, access: { has: obj => "listdir" in obj, get: obj => obj.listdir }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _analyze_decorators, { kind: "method", name: "analyze", static: false, private: false, access: { has: obj => "analyze" in obj, get: obj => obj.analyze }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _editNote_decorators, { kind: "method", name: "editNote", static: false, private: false, access: { has: obj => "editNote" in obj, get: obj => obj.editNote }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _pickFile_decorators, { kind: "method", name: "pickFile", static: false, private: false, access: { has: obj => "pickFile" in obj, get: obj => obj.pickFile }, metadata: _metadata }, null, _instanceExtraInitializers);
        }
        static inject = [];

        constructor(ctx, config = {}) {
            super(ctx, 'flp');
            __runInitializers(this, _instanceExtraInitializers);
            void config;
        }

        /** List FL project files under a directory. */
        async listdir(directory) {
            const dir = directory && directory.length ? directory : defaultDir();
            const res = await runBridge('listdir', dir);
            return res.ok
              ? ok({
                  directory: res.directory,
                  directoryB64: res.directory_b64,
                  files: res.files,
                  default: directory ? false : true,
                })
              : res;
        }

        /** Analyze a .flp project: structure + music features. */
        async analyze(path) {
            if (!path) return err('未指定工程文件路径');
            if (!existsSync(path)) return err(`文件不存在: ${path}`);
            const res = await runBridge('analyze', path);
            const f = res.features ?? {};
            return res.ok
              ? ok({
                  file: res.file,
                  fileB64: res.file_b64,
                  format: res.format,
                  version: res.version,
                  ppq: res.ppq,
                  tempo: res.tempo,
                  timeSignature: res.time_signature ?? null,
                  timemarkers: res.timemarkers ?? [],
                  fxChains: res.fx_chains ?? [],
                  title: res.title,
                  genre: res.genre,
                  channelCount: res.channel_count,
                  mixerTracks: res.mixer_tracks,
                  channels: res.channels,
                  patterns: res.patterns,
                  patternNotes: res.pattern_notes ?? [],
                  arrangement: res.arrangement ?? { ppq: res.ppq, tracks: [] },
                  features: {
                    totalNotes: f.total_notes ?? f.totalNotes,
                    pitchClasses: f.pitch_classes ?? f.pitchClasses,
                    key: f.key,
                    keyScore: f.key_score,
                    notesPerBar: f.notes_per_bar ?? f.notesPerBar,
                    avgLengthPpq: f.avg_length_ppq ?? f.avgLengthPpq,
                    avgVelocity: f.avg_velocity ?? f.avgVelocity,
                  },
                })
              : res;
        }

        /**
         * Edit notes in a project with automatic backup.
         * spec: { pattern: <name>, notes: [{ op:'set', index, field, value }] }
         * The bridge writes to a temp copy; we back up the original and
         * atomically rename the temp over it.
         */
        async editNote(path, spec) {
            if (!path) return err('未指定工程文件路径');
            if (!existsSync(path)) return err(`文件不存在: ${path}`);
            const res = await runBridge('editnote', path, spec || {});
            if (!res.ok) return res;
            const tmp = res.tmp;
            if (!tmp || !existsSync(tmp)) return err('bridge 未生成临时文件');

            // Backup original to <dir>/_dsh-flp-studio_backups/
            try {
                const dir = dirname(path);
                const backupDir = join(dir, '_dsh-flp-studio_backups');
                mkdirSync(backupDir, { recursive: true });
                const stamp = new Date().toISOString().replace(/[:.]/g, '-');
                const backupPath = join(backupDir, `${basename(path)}.${stamp}.bak.flp`);
                copyFileSync(path, backupPath);

                // Atomic replace
                renameSync(tmp, path);
                return ok({
                  message: '已备份并写入',
                  backup: backupPath,
                  applied: res.applied,
                  size: statSync(path).size,
                });
            } catch (e) {
                // Restore safety: if replace failed, keep the original intact.
                try { if (existsSync(tmp)) renameSync(tmp, path); } catch { /* noop */ }
                return err(`写入失败（原文件未改动）: ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        /** Open a native file chooser filtered to FL project files. */
        async pickFile() {
            const res = await pickFileDialog(defaultDir());
            if (res.ok && res.path) {
                res.pathB64 = Buffer.from(res.path, 'utf8').toString('base64');
            }
            return res;
        }
    };
})();
export { FlpStudioService };
export default FlpStudioService;
