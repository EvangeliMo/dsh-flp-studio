/**
 * dsh-flp-studio agent tools (Cordis plugin entry).
 *
 * Registers model-facing tools so an agent can inspect and edit FL Studio
 * projects directly from the conversation — the plugin's real purpose is a
 * programming interface for the model, not a manual editor.
 *
 * Loaded as a regular profile plugin (`dsh-flp-studio/tools`): tools are
 * created with the standard `defineTool` from @deepseek-ai/dsh-tools and
 * registered via `ctx.tools.register`. Execution delegates to the plugin's
 * host service (`ctx.flp`, injected below), which runs the Python bridge —
 * keeping all Python/child-process work in the service layer.
 *
 * Tools:
 *  - flp_analyze(path)     : full project structure + music feature analysis
 *  - flp_edit_notes(path, pattern|patternIndex, notes) : add/delete/set notes
 *    (backup first, atomic replace).
 */
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'flp-studio-tools';
export const inject = ['tools', 'flp'];

const DESCRIPTION_ANALYZE =
  'Analyze an FL Studio project file (.flp): tempo, key (detected key), channels, patterns, note counts and music features. Use this to inspect what a project contains before editing it.';
const DESCRIPTION_EDIT =
  'Edit MIDI notes in an FL Studio project file (.flp): add new notes, delete notes, or modify note properties (key/pitch, position, length, velocity). The file is automatically backed up before writing; the edit is atomic. Use flp_analyze first to learn the pattern names and channel info.';

function apply(ctx) {
  const disposers = [];

  const analyzeTool = defineTool({
    name: 'flp_analyze',
    description: DESCRIPTION_ANALYZE,
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path to a .flp project file (e.g. D:\\桌面\\angel.flp).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', required: true },
          tempo: { type: 'number' },
          ppq: { type: 'number' },
          timeSignature: {
            type: 'object',
            additionalProperties: false,
            properties: {
              num: { type: 'number' },
              beat: { type: 'number' },
              label: { type: 'string' },
            },
          },
          timemarkers: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                position: { type: 'number' },
                num: { type: 'number' },
                beat: { type: 'number' },
                name: { type: 'string' },
              },
            },
          },
          fxChains: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                track: { type: 'number' },
                name: { type: 'string' },
                fx: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          channelCount: { type: 'number' },
          mixerTracks: { type: 'number' },
          key: { type: 'string' },
          totalNotes: { type: 'number' },
          notesPerBar: { type: 'number' },
          avgVelocity: { type: 'number' },
          pitchClasses: {
            type: 'object',
            additionalProperties: true,
          },
          channels: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'number' }, name: { type: 'string' }, type: { type: 'string' },
                volume: { type: 'number' }, pan: { type: 'number' }, insert: { type: 'number' },
              },
            },
          },
          patterns: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'number' }, name: { type: 'string' }, notes: { type: 'number' },
                sampleKeys: { type: 'array', items: { type: 'string' } },
                length: { type: 'number' }, looped: { type: 'boolean' },
              },
            },
          },
          patternNotes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                index: { type: 'number' }, name: { type: 'string' }, notes: { type: 'number' },
                sequence: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      key: { type: 'string' }, pos: { type: 'number' },
                      len: { type: 'number' }, vel: { type: 'number' },
                      pan: { type: 'number' }, rack: { type: 'number' },
                    },
                  },
                },
              },
            },
          },
          arrangement: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ppq: { type: 'number' },
              tracks: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    track: { type: 'number' },
                    clips: {
                      type: 'array',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          position: { type: 'number' }, length: { type: 'number' },
                          patternIndex: { type: 'number' }, name: { type: 'string' },
                          isPattern: { type: 'boolean' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const ppq = value.arrangement?.ppq || value.ppq || 96;
        const q = (t) => Math.round((t ?? 0) / ppq * 4) / 4; // ticks -> quarters
        // Build a tick->bar mapper that honours time-signature changes.
        // Timemarkers give {position(ticks), num, beat}: bar length = num quarters.
        const mkBarOf = () => {
          const tms = (value.timemarkers ?? [])
            .filter((m) => m && m.num && m.beat)
            .sort((a, b) => a.position - b.position);
          const segs = [];
          let bar = 0;
          for (let i = 0; i < tms.length; i++) {
            const start = tms[i].position;
            const end = i + 1 < tms.length ? tms[i + 1].position : Infinity;
            const qPerBar = tms[i].num; // numerator = quarters per bar (beat is the unit)
            segs.push({ start, end, qPerBar, startBar: bar });
            if (end !== Infinity) bar += Math.max(1, Math.round((end - start) / ppq / qPerBar));
          }
          return (ticks) => {
            if (segs.length === 0) return Math.floor(ticks / ppq / 4);
            const seg = segs.find((s) => ticks >= s.start && ticks < s.end) || segs[segs.length - 1];
            if (!seg) return Math.floor(ticks / ppq / 4);
            return seg.startBar + Math.floor((ticks - seg.start) / ppq / seg.qPerBar);
          };
        };
        const barOf = mkBarOf();
        // 1. FULL arrangement: every track, every clip, dense.
        const arrLines = (value.arrangement?.tracks ?? [])
          .filter((t) => (t.clips ?? []).length > 0)
          .map((t) => {
            const clips = (t.clips ?? []).map((c) =>
              `${c.name ?? '#' + c.patternIndex}@${q(c.position)}q(+${q(c.length)})`
            );
            return `  track${t.track}: ${clips.join(' ')}`;
          });
        // 2. FULL notes per pattern, grouped per bar (honours time-sig changes).
        //    Each note: key@inBarQuarter lenTicks
        const qpbFor = (pos) => {
          const tms = (value.timemarkers ?? []).filter((m) => m && m.num).sort((a, b) => a.position - b.position);
          let qpb = 4;
          for (let i = 0; i < tms.length; i++) {
            const end = i + 1 < tms.length ? tms[i + 1].position : Infinity;
            if (pos >= tms[i].position && pos < end) { qpb = tms[i].num; break; }
          }
          return qpb;
        };
        const noteLines = (value.patternNotes ?? []).map((p) => {
          const seq = p.sequence ?? [];
          if (seq.length === 0) return `  ${p.name || '#' + p.index}(0n): (empty)`;
          const byBar = new Map();
          for (const s of seq) {
            const b = barOf(s.pos);
            if (!byBar.has(b)) byBar.set(b, []);
            byBar.get(b).push(s);
          }
          const bars = [...byBar.keys()].sort((a, b) => a - b);
          const lines = bars.map((b) => {
            const notes = byBar.get(b);
            notes.sort((x, y) => x.pos - y.pos || String(x.key).localeCompare(String(y.key)));
            const body = notes.map((s) => {
              const qpb = qpbFor(s.pos);
              const inBar = s.pos % (ppq * qpb);
              return `${s.key}@${q(inBar)}:${s.len}`;
            }).join(' ');
            return `    bar${b}: ${body}`;
          });
          return `  ${p.name || '#' + p.index}(${p.notes}n):\n${lines.join('\n')}`;
        });
        const channelsLine = (value.channels ?? [])
          .map((c) => `${c.name}(${c.type}${c.insert != null ? ',ins' + c.insert : ''})`)
          .join(' ');
        const patternsLine = (value.patterns ?? [])
          .map((p) => `${p.name || '#' + p.index}(${p.notes}n)`)
          .join(' ');
        const tsLines = (value.timemarkers ?? []).map((m) =>
          `${m.name || (m.num + '/' + m.beat)}@${m.position}ticks`
        );
        const fxLines = (value.fxChains ?? []).map((c) =>
          `  track${c.track}: ${(c.fx ?? []).join(' -> ')}`
        );
        return [{
          type: 'text',
          text: [
            `FLP: ${value.file}`,
            `tempo=${value.tempo} ppq=${value.ppq} timeSig=${value.timeSignature?.label || '--'} key=${value.key || '--'} channels=${value.channelCount} mixer=${value.mixerTracks}`,
            `totalNotes=${value.totalNotes} notesPerBar=${value.notesPerBar || '--'} avgVelocity=${value.avgVelocity || '--'}`,
            `pitchClasses: ${Object.entries(value.pitchClasses || {}).map(([k, v]) => `${k}:${v}`).join(' ')}`,
            `timeSigChanges: ${tsLines.join(', ') || 'none'}`,
            `fxChains (${value.fxChains?.length || 0} tracks):\n${fxLines.join('\n')}`,
            `channels: ${channelsLine}`,
            `patterns: ${patternsLine}`,
            `arrangement (${arrLines.length} tracks, position=quarter, +len=quarters):`,
            ...arrLines,
            `notes (${value.patternNotes?.length || 0} patterns, full sequence grouped by bar as key@inBarQuarter:lenTicks):`,
            ...noteLines,
          ].join('\n'),
        }];
      },
    },
    timeoutMs: 60000,
    async execute(args, exec) {
      const res = await ctx.flp.analyze(args.path, exec?.signal);
      if (!res.ok) throw new Error(res.message || 'analysis failed');
      const f = res.features ?? {};
      const num = (v) => (typeof v === 'number' ? v : 0);
      const str = (v) => (typeof v === 'string' ? v : '');
      // Normalize every field to the declared output schema exactly: drop
      // undeclared props, convert null → safe values, align snake_case names.
      const channels = (res.channels ?? []).map((c) => ({
        index: c.index,
        name: str(c.name),
        type: str(c.type),
        volume: num(c.volume),
        pan: num(c.pan),
        insert: num(c.insert),
      }));
      const patterns = (res.patterns ?? []).map((p) => ({
        index: p.index,
        name: str(p.name),
        notes: num(p.notes),
        sampleKeys: Array.isArray(p.sample_keys ?? p.sampleKeys) ? (p.sample_keys ?? p.sampleKeys).map(str) : [],
        length: num(p.length),
        looped: p.looped === true,
      }));
      const patternNotes = (res.patternNotes ?? []).map((p) => ({
        index: p.index,
        name: str(p.name),
        notes: num(p.notes),
        sequence: Array.isArray(p.sequence)
          ? p.sequence.map((s) => ({
              key: str(s.key),
              pos: num(s.pos),
              len: num(s.len),
              vel: num(s.vel),
              pan: num(s.pan),
              rack: num(s.rack),
            }))
          : [],
      }));
      const arrangement = {
        ppq: num(res.arrangement?.ppq),
        tracks: (res.arrangement?.tracks ?? []).map((t) => ({
          track: num(t.track),
          clips: Array.isArray(t.clips)
            ? t.clips.map((c) => ({
                position: num(c.position),
                length: num(c.length),
                patternIndex: num(c.patternIndex),
                name: str(c.name),
                isPattern: c.isPattern === true,
              }))
            : [],
        })),
      };
      return {
        file: str(res.fileB64 ? (function () { try { return atob(res.fileB64); } catch { return ''; } })() : res.file),
        tempo: num(res.tempo),
        ppq: num(res.ppq),
        timeSignature: res.timeSignature && res.timeSignature.num
          ? { num: num(res.timeSignature.num), beat: num(res.timeSignature.beat), label: str(res.timeSignature.label) }
          : { num: 0, beat: 0, label: '' },
        timemarkers: (res.timemarkers ?? []).map((m) => ({
          position: num(m.position),
          num: num(m.num),
          beat: num(m.beat),
          name: str(m.name),
        })),
        fxChains: (res.fxChains ?? []).map((c) => ({
          track: num(c.track),
          name: str(c.name),
          fx: Array.isArray(c.fx) ? c.fx.map(str) : [],
        })),
        channelCount: num(res.channelCount),
        mixerTracks: num(res.mixerTracks),
        key: str(f.key),
        totalNotes: num(f.totalNotes ?? f.total_notes),
        notesPerBar: num(f.notesPerBar ?? f.notes_per_bar),
        avgVelocity: num(f.avgVelocity ?? f.avg_velocity),
        pitchClasses: (f.pitchClasses ?? f.pitch_classes) ?? {},
        channels,
        patterns,
        patternNotes,
        arrangement,
      };
    },
    presentCall(args) {
      return { card: 'generic', title: `Analyze FLP ${args.path}`, kind: 'read', rawInput: args.path };
    },
  });

  const editTool = defineTool({
    name: 'flp_edit_notes',
    description: DESCRIPTION_EDIT,
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path to a .flp project file.',
      },
    pattern: {
      type: 'string',
      description: 'Pattern name to edit (e.g. "School Piano"). Use either this or patternIndex.',
    },
    patternIndex: {
      type: 'number',
      description: 'Pattern index to edit (0-based). Use either this or pattern.',
    },
      notes: {
        type: 'array',
        required: true,
        description: 'Edit operations. Each: {op:"add", key, position, length, velocity?, pan?} | {op:"delete", index} | {op:"set", index, field, value} | {op:"newpattern", name?, rackChannel?, notes:[{key,position,length,velocity}], playlistPosition?, playlistTrack?, playlistLength?} (create a NEW pattern; optionally place in playlist). key is a MIDI note number (60=C5); position/length in ppq ticks (ppq from flp_analyze; 96 = quarter note).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            op: { type: 'string', required: true },
            index: { type: 'number' },
            field: { type: 'string' },
            value: { oneOf: [{ type: 'number' }, { type: 'string' }, { type: 'boolean' }] },
            key: { type: 'number' },
            position: { type: 'number' },
            length: { type: 'number' },
            velocity: { type: 'number' },
            pan: { type: 'number' },
            rackChannel: { type: 'number' },
            name: { type: 'string' },
            playlistPosition: { type: 'number' },
            playlistTrack: { type: 'number' },
            playlistLength: { type: 'number' },
            notes: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  key: { type: 'number' },
                  position: { type: 'number' },
                  length: { type: 'number' },
                  velocity: { type: 'number' },
                  pan: { type: 'number' },
                  rackChannel: { type: 'number' },
                },
              },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string' },
          backup: { type: 'string' },
          applied: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
            },
          },
          size: { type: 'number' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `已备份并写入: ${value.applied?.length ?? 0} 处编辑生效 (backup: ${value.backup})`
          : `编辑失败: ${value.message ?? 'unknown'}`,
      }],
    },
    timeoutMs: 60000,
    async execute(args, exec) {
      const res = await ctx.flp.editNote(args.path, {
        pattern: args.pattern,
        patternIndex: args.patternIndex,
        notes: args.notes,
      }, exec?.signal);
      if (!res.ok) throw new Error(res.message || 'edit failed');
      return {
        ok: true,
        message: res.message,
        backup: res.backup,
        applied: res.applied ?? [],
        size: res.size,
      };
    },
    presentCall(args) {
      return { card: 'generic', title: `Edit FLP notes ${args.path}`, kind: 'write', rawInput: `${args.pattern ?? '#' + args.patternIndex}` };
    },
  });

  try {
    disposers.push(ctx.tools.register(analyzeTool));
    disposers.push(ctx.tools.register(editTool));
  } catch (e) {
    // A second load of the same tools plugin would collide; first wins.
    console.warn('[dsh-flp-studio] tools registration issue:', e?.message ?? e);
  }
  return () => { for (const d of disposers) { try { d(); } catch { /* noop */ } } };
}

export default { name, inject, apply };
