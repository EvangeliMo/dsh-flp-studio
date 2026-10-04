/**
 * dsh-flp-studio browser half.
 *
 * Surfaces:
 *  - `conversation.view` tab (order 8, between Trajectory and others): an
 *    "FLP 工程" tab in the conversation header list (same seam gal-view uses).
 *    Clicking the tab opens a full-panel FLP browser:
 *      - directory input (default: user FL Studio Projects)
 *      - .flp file list (from the host listdir remote)
 *      - project analysis: tempo / ppq / channel count / pattern count,
 *        channel list, pattern + note counts, and a music-feature summary.
 *
 * Deliberately NOT registered in sidebar.footer.action: that slot is shared
 * with dsh-balance-context-meter's absolute-positioned bars — co-registering
 * there overlaps the two UIs. The tab seam avoids the clash entirely.
 *
 * Data: host remote flp/listdir + flp/analyze (+ flp/editNote for future).
 */
const React = require('react');
const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
const { Button, IconRefreshOutline16 } = primitives;
const { TYPERT_REMOTE } = require('../../lib/contracts.js');

export const name = 'dsh-flp-studio';
export const inject = ['slots', 'locale', 'remote'];

const NS = 'dsh-flp-studio';

const zh = {
  tab: 'FLP 工程',
  refresh: '刷新',
  dir: '目录',
  defaultDir: '默认工程目录',
  noFiles: '此目录没有 .flp 工程',
  loadErr: '加载失败',
  analyze: '分析',
  tempo: 'BPM',
  channels: '通道',
  patterns: 'Pattern',
  notes: '音符',
  mixer: '混音台',
  version: '版本',
  features: '音乐特征',
  totalNotes: '总音符数',
  pitchClasses: '音高分布',
  key: '调性',
  notesPerBar: '音符/小节',
  avgVelocity: '平均力度',
  edit: '编辑音符',
  backup: '已备份',
  pickFile: '选择文件',
  title: 'FLP 工程浏览',
  subtitle: 'FL Studio 工程分析器',
};
const en = {
  tab: 'FLP Projects',
  refresh: 'Refresh',
  dir: 'Directory',
  defaultDir: 'Default projects dir',
  noFiles: 'No .flp projects in this directory',
  loadErr: 'Load failed',
  analyze: 'Analyze',
  tempo: 'BPM',
  channels: 'Channels',
  patterns: 'Patterns',
  notes: 'Notes',
  mixer: 'Mixer',
  version: 'Version',
  features: 'Music features',
  totalNotes: 'Total notes',
  pitchClasses: 'Pitch classes',
  key: 'Key',
  notesPerBar: 'Notes/bar',
  avgVelocity: 'Avg velocity',
  edit: 'Edit notes',
  backup: 'Backed up',
  pickFile: 'Pick file',
  title: 'FLP Projects',
  subtitle: 'FL Studio project analyzer',
};

function fmtBytes(n) {
  if (n === null || n === undefined) return '--';
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

// Decode a UTF-8 base64 string (paths travel b64 because the DSH gateway
// corrupts non-ASCII in responses on zh-CN Windows).
function b64ToStr(b64) {
  if (!b64) return '';
  try {
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch { return ''; }
}

function fmtTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } catch { return ''; }
}

// ---- error boundary ----
class SafePanel extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('[dsh-flp-studio] render error:', error, info); }
  render() {
    if (this.state.error !== null) {
      return React.createElement('div', { className: 'dshflp-err' }, `flp error: ${String(this.state.error.message ?? this.state.error).slice(0, 120)}`);
    }
    return this.props.children;
  }
}

function makeApi(remote) {
  const r = remote.flp;
  const unwrap = async (p) => {
    const res = await p;
    if (!res.ok) throw new Error(res.error?.message ?? 'rpc failed');
    return res.value;
  };
  return {
    listdir: async (directory) => unwrap(r.listdir(directory)),
    analyze: async (path) => unwrap(r.analyze(path)),
    editNote: async (path, spec) => unwrap(r.editNote(path, spec)),
    pickFile: async () => unwrap(r.pickFile()),
  };
}

// ---- module-level panel state ----
// The conversation.view tab renders only the active tab, so FlpPanel is
// unmounted when the user switches away and remounted on return. Keep the last
// view state here (same bundle module instance) so the selection survives tab
// switches; also persist the directory to localStorage for refresh survival.
const LS_DIR = 'dsh-flp-studio:last-dir';
let panelMemory = {
  dirInput: '',
  files: null,
  selected: null,
  analysis: null,
};

function loadLastDir() {
  try { return window.localStorage.getItem(LS_DIR) || ''; } catch { return ''; }
}
function saveLastDir(d) {
  try { if (d) window.localStorage.setItem(LS_DIR, d); } catch { /* ignore */ }
}

// ---- the tab view ----
function FlpPanel({ api, t }) {
  const s = (key) => (typeof t === 'function' ? t(key) : zh[key]);
  // dirInput = what the user typed; appliedDir = what was actually loaded.
  // They are kept separate so typing never gets clobbered by a load cycle.
  const [dirInput, setDirInput] = React.useState(panelMemory.dirInput || loadLastDir());
  const [files, setFiles] = React.useState(panelMemory.files);
  const [dirError, setDirError] = React.useState(null);
  const [selected, setSelected] = React.useState(panelMemory.selected);
  const [analysis, setAnalysis] = React.useState(panelMemory.analysis);
  const [analyzing, setAnalyzing] = React.useState(false);
  const [expandedChannel, setExpandedChannel] = React.useState(null);

  // Keep module memory in sync so tab switches preserve the view.
  React.useEffect(() => {
    panelMemory.dirInput = dirInput;
    panelMemory.files = files;
    panelMemory.selected = selected;
    panelMemory.analysis = analysis;
    saveLastDir(dirInput);
  }, [dirInput, files, selected, analysis]);

  // Stable locale helper: `s` must be referentially stable or it will retrigger
  // loadDir (and its effect) on every render, resetting the dir input.
  const sRef = React.useRef(s);
  sRef.current = s;
  const stableS = React.useCallback((key) => sRef.current(key), []);

  // Strip surrounding quotes from a pasted path (e.g. "D:\桌面\angel.flp").
  const cleanPath = (raw) => {
    if (!raw) return '';
    let s = String(raw).trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      s = s.slice(1, -1);
    }
    return s;
  };

  // Load happens ONLY on explicit action (Enter / button / picker), never on
  // blur — blur-triggered loads wiped the list while the user was mid-edit.
  const loadDir = React.useCallback(async (d) => {
    const target = cleanPath(d);
    setDirError(null);
    setFiles(null);
    setSelected(null);
    setAnalysis(null);
    try {
      const res = await api.listdir(target || '');
      // Paths arrive b64-encoded (gateway corrupts non-ASCII in responses);
      // decode for display and for subsequent requests.
      const dirDisplay = res.directoryB64 ? b64ToStr(res.directoryB64) : (res.directory ?? target ?? '');
      const decodedFiles = (res.files ?? []).map((f) => ({
        ...f,
        path: f.pathB64 ? b64ToStr(f.pathB64) : f.path,
        name: f.pathB64 ? (b64ToStr(f.pathB64).split(/[\\/]/).pop() || f.name) : f.name,
      }));
      setFiles(decodedFiles);
      setDirInput(dirDisplay);
      if (res.default) setDirError(stableS('defaultDir'));
    } catch (e) {
      setDirError(e instanceof Error ? e.message : String(e));
      setFiles([]);
    }
  }, [api, stableS]);

  // Initial load: only on the FIRST mount of a session (no remembered state).
  // On later mounts (tab switch back) the remembered files/selection restore
  // the view instead of resetting to the default directory.
  const firstMount = React.useRef(panelMemory.files === null);
  React.useEffect(() => {
    if (firstMount.current && panelMemory.files === null) {
      firstMount.current = false;
      loadDir(loadLastDir());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On (re)mount — e.g. switching back to this tab — the conversation scroll
  // container keeps its old scroll offset, which clamps to the bottom of this
  // (shorter) panel. Reset the nearest scrollable ancestor to the top so the
  // panel starts at its beginning.
  const viewRef = React.useRef(null);
  React.useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    let node = el.parentElement;
    while (node) {
      if (node.scrollHeight > node.clientHeight + 1) {
        node.scrollTop = 0;
        break;
      }
      node = node.parentElement;
    }
  }, []);

  const doAnalyze = React.useCallback(async (path) => {
    setAnalyzing(true);
    setAnalysis(null);
    try {
      const res = await api.analyze(path);
      setAnalysis(res);
    } catch (e) {
      setAnalysis({ ok: false, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setAnalyzing(false);
    }
  }, [api]);

  const pick = (f) => {
    setSelected(f);
    doAnalyze(f.path);
  };

  // Native file chooser: pick a .flp directly, then load its directory and
  // analyze the file. The response path is b64-encoded (gateway corrupts
  // non-ASCII in responses), so decode it first.
  const pickFile = React.useCallback(async () => {
    try {
      const res = await api.pickFile();
      if (res.cancelled) return;
      const path = res.pathB64 ? b64ToStr(res.pathB64) : res.path;
      if (!path) return;
      // Load the containing directory so the file appears in the list.
      const idx = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
      const dir = idx >= 0 ? path.slice(0, idx) : '';
      loadDir(dir);
      // Analyze the picked file directly.
      setSelected({ path, name: idx >= 0 ? path.slice(idx + 1) : path });
      doAnalyze(path);
    } catch (e) {
      setDirError(e instanceof Error ? e.message : String(e));
    }
  }, [api, loadDir, doAnalyze]);

  return React.createElement('div', { ref: viewRef, className: 'dshflp-view' },
    React.createElement('div', { className: 'dshflp-head' },
      React.createElement('div', { className: 'dshflp-head-title' }, s('title')),
      React.createElement('div', { className: 'dshflp-head-sub' }, s('subtitle')),
    ),

    React.createElement('div', { className: 'dshflp-dirrow' },
      React.createElement('input', {
        className: 'dshflp-dir', value: dirInput,
        onChange: (e) => setDirInput(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter') loadDir(dirInput); },
        placeholder: s('dir'), 'aria-label': s('dir'),
      }),
      React.createElement(Button, {
        type: 'button', variant: 'ghost', size: 'md', className: 'dshflp-go',
        title: s('refresh'), 'aria-label': s('refresh'),
        onClick: () => loadDir(dirInput),
        children: React.createElement(IconRefreshOutline16, { size: 14 }),
      }),
      React.createElement(Button, {
        type: 'button', variant: 'primary', size: 'md', className: 'dshflp-pick',
        title: s('pickFile'), 'aria-label': s('pickFile'),
        onClick: () => pickFile(),
        children: s('pickFile'),
      }),
    ),
    dirError ? React.createElement('div', { className: 'dshflp-hint' }, dirError) : null,

    React.createElement('div', { className: 'dshflp-body' },
      React.createElement('div', { className: 'dshflp-col dshflp-filescol' },
        React.createElement('div', { className: 'dshflp-feat-title' }, s('dir')),
        React.createElement('div', { className: 'dshflp-files' },
          files === null ? React.createElement('div', { className: 'dshflp-hint' }, '…')
          : files.length === 0 ? React.createElement('div', { className: 'dshflp-hint' }, s('noFiles'))
          : files.map((f) => React.createElement('div', {
              key: f.path,
              className: 'dshflp-file' + (selected && selected.path === f.path ? ' dshflp-selected' : ''),
              onClick: () => pick(f),
            },
            React.createElement('div', { className: 'dshflp-file-name' }, f.name),
            React.createElement('div', { className: 'dshflp-file-meta' }, `${fmtBytes(f.size)} · ${fmtTime(f.mtime)}`),
          )),
        ),
      ),

      React.createElement('div', { className: 'dshflp-col dshflp-analycol' },
        analyzing ? React.createElement('div', { className: 'dshflp-hint' }, '…')
        : !analysis ? React.createElement('div', { className: 'dshflp-hint' }, s('analyze'))
        : !analysis.ok ? React.createElement('div', { className: 'dshflp-err' }, String(analysis.message ?? s('loadErr')))
        : React.createElement(React.Fragment, null,
            React.createElement('div', { className: 'dshflp-title' }, selected ? selected.name : ''),
            React.createElement('div', { className: 'dshflp-stats' },
              React.createElement('div', { className: 'dshflp-stat' }, React.createElement('div', { className: 'dshflp-stat-v' }, String(analysis.tempo ?? '--')), React.createElement('div', { className: 'dshflp-stat-k' }, s('tempo'))),
              React.createElement('div', { className: 'dshflp-stat' }, React.createElement('div', { className: 'dshflp-stat-v' }, String(analysis.channelCount ?? '--')), React.createElement('div', { className: 'dshflp-stat-k' }, s('channels'))),
              React.createElement('div', { className: 'dshflp-stat' }, React.createElement('div', { className: 'dshflp-stat-v' }, String(analysis.patterns?.length ?? '--')), React.createElement('div', { className: 'dshflp-stat-k' }, s('patterns'))),
              React.createElement('div', { className: 'dshflp-stat' }, React.createElement('div', { className: 'dshflp-stat-v' }, String(analysis.mixerTracks ?? '--')), React.createElement('div', { className: 'dshflp-stat-k' }, s('mixer'))),
            ),
            analysis.features ? React.createElement('div', { className: 'dshflp-features' },
              React.createElement('div', { className: 'dshflp-feat-title' }, s('features')),
              analysis.features.key ? React.createElement('div', { className: 'dshflp-feat-line' }, `${s('key')}: ${analysis.features.key}`) : null,
              React.createElement('div', { className: 'dshflp-feat-line' }, `${s('totalNotes')}: ${analysis.features.totalNotes ?? '--'}`),
              analysis.features.notesPerBar ? React.createElement('div', { className: 'dshflp-feat-line' }, `${s('notesPerBar')}: ${analysis.features.notesPerBar}`) : null,
              analysis.features.avgVelocity ? React.createElement('div', { className: 'dshflp-feat-line' }, `${s('avgVelocity')}: ${analysis.features.avgVelocity}`) : null,
              analysis.features.pitchClasses ? React.createElement('div', { className: 'dshflp-pcs' },
                Object.entries(analysis.features.pitchClasses).slice(0, 12).map(([k, v]) =>
                  React.createElement('span', { key: k, className: 'dshflp-pc' }, `${k} ${v}`)),
              ) : null,
            ) : null,
            analysis.channels && analysis.channels.length ? React.createElement('div', { className: 'dshflp-chlist' },
              React.createElement('div', { className: 'dshflp-feat-title' }, s('channels')),
              analysis.channels.slice(0, 20).map((ch) =>
                React.createElement('div', {
                  key: ch.index,
                  className: 'dshflp-ch' + (expandedChannel === ch.index ? ' dshflp-ch-open' : ''),
                  onClick: () => setExpandedChannel(expandedChannel === ch.index ? null : ch.index),
                },
                React.createElement('span', { className: 'dshflp-ch-name' }, ch.name),
                React.createElement('span', { className: 'dshflp-ch-type' }, ch.type),
                expandedChannel === ch.index ? React.createElement('div', { className: 'dshflp-ch-detail' },
                  `vol=${ch.volume ?? '--'} pan=${ch.pan ?? '--'} insert=${ch.insert ?? '--'}`) : null,
              )),
            ) : null,
          ),
      ),
    ),
  );
}

// ---- css ----
const CSS = `
.dshflp-view{display:flex;flex-direction:column;gap:10px;box-sizing:border-box;padding:16px;height:100%;min-height:0;
  font-size:12px;color:var(--dsw-alias-label-primary,#fff)}
.dshflp-head{display:flex;flex-direction:column;gap:2px}
.dshflp-head-title{font-size:15px;font-weight:700;letter-spacing:.02em}
.dshflp-head-sub{font-size:11px;color:var(--dsw-alias-label-tertiary, rgba(255,255,255,.55))}
.dshflp-dirrow{display:flex;gap:6px;align-items:center}
.dshflp-dir{flex:1;min-width:0;min-height:28px;padding:3px 8px;box-sizing:border-box;border-radius:7px;
  border:1px solid var(--dsw-alias-line-secondary, rgba(255,255,255,.16));
  background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12));
  color:var(--dsw-alias-label-primary,#fff);font-size:12px}
.dshflp-go{flex:0 0 auto;width:28px;min-height:28px;padding:0}
.dshflp-pick{flex:0 0 auto;min-height:28px;padding:0 10px;font-size:12px}
.dshflp-body{flex:1;min-height:0;display:flex;gap:14px;overflow:hidden}
.dshflp-col{display:flex;flex-direction:column;gap:6px;min-height:0;overflow:auto}
.dshflp-filescol{flex:0 0 300px;border-right:1px solid var(--dsw-alias-line-secondary, rgba(255,255,255,.1));padding-right:12px}
.dshflp-analycol{flex:1;min-width:0}
.dshflp-files{display:flex;flex-direction:column;gap:2px;overflow:auto;min-height:0}
.dshflp-file{display:flex;flex-direction:column;gap:1px;padding:6px 8px;border-radius:7px;cursor:pointer;
  border:1px solid transparent}
.dshflp-file:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1))}
.dshflp-selected{background:color-mix(in srgb, var(--dsw-alias-state-info, #0a84ff) 16%, transparent);border-color:color-mix(in srgb, var(--dsw-alias-state-info, #0a84ff) 45%, transparent)}
.dshflp-file-name{color:var(--dsw-alias-label-primary,#fff);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshflp-file-meta{color:var(--dsw-alias-label-tertiary, rgba(255,255,255,.55));font-size:11px}
.dshflp-hint{color:var(--dsw-alias-label-secondary, rgba(255,255,255,.7));font-size:11px;padding:2px 0}
.dshflp-err{color:var(--dsw-alias-state-danger, #ff3b30);font-size:11px;padding:2px 0}
.dshflp-title{font-size:13px;font-weight:700;color:var(--dsw-alias-label-primary,#fff)}
.dshflp-stats{display:flex;gap:6px;flex-wrap:wrap}
.dshflp-stat{flex:1;min-width:70px;display:flex;flex-direction:column;align-items:center;gap:1px;padding:6px 4px;border-radius:8px;
  background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1))}
.dshflp-stat-v{font-size:14px;font-weight:700;color:var(--dsw-alias-label-primary,#fff)}
.dshflp-stat-k{font-size:10px;color:var(--dsw-alias-label-tertiary, rgba(255,255,255,.55))}
.dshflp-features{display:flex;flex-direction:column;gap:3px}
.dshflp-feat-title{font-size:11px;font-weight:700;color:var(--dsw-alias-label-secondary, rgba(255,255,255,.8));text-transform:uppercase;letter-spacing:.4px}
.dshflp-feat-line{color:var(--dsw-alias-label-secondary, rgba(255,255,255,.75))}
.dshflp-pcs{display:flex;flex-wrap:wrap;gap:3px}
.dshflp-pc{padding:1px 6px;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14));color:var(--dsw-alias-label-primary,#fff);font-size:11px}
.dshflp-chlist{display:flex;flex-direction:column;gap:2px}
.dshflp-ch{display:flex;gap:6px;align-items:center;padding:4px 6px;border-radius:6px;cursor:pointer}
.dshflp-ch:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1))}
.dshflp-ch-name{flex:1;color:var(--dsw-alias-label-primary,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshflp-ch-type{font-size:10px;color:var(--dsw-alias-label-tertiary, rgba(255,255,255,.55))}
.dshflp-ch-detail{flex-basis:100%;font-size:11px;color:var(--dsw-alias-label-secondary, rgba(255,255,255,.7))}
`;

function installCss() {
  if (document.getElementById('dshflp-css')) return () => {};
  const style = document.createElement('style');
  style.id = 'dshflp-css';
  style.textContent = CSS;
  document.head.appendChild(style);
  return () => { style.remove(); };
}

async function apply(ctx) {
  const removeCss = installCss();
  const disposeRemote = await ctx.remote.$mount(TYPERT_REMOTE);
  const disposeLocale = ctx.locale.register(NS, { zh, en });
  // conversation.view tab (same seam as gal-view). No sidebar.footer.action
  // registration — that slot is shared with dsh-balance-context-meter and
  // co-registering there overlaps the two UIs.
  const feature = ctx.inject(['remote.flp'], (scope) => {
    const api = makeApi(scope.remote);
    scope.slots.inject('conversation.view', () => scope.slots.register({
      name: 'conversation.view',
      id: 'flp-studio',
      order: 8,
      label: () => zh.tab,
      inject: () => ({ api }),
    }, (props) => React.createElement(SafePanel, null, React.createElement(FlpPanel, props))));
    return () => {};
  });
  return async () => {
    await feature.dispose();
    disposeLocale();
    await disposeRemote();
    removeCss();
  };
}

export default { apply, inject };
