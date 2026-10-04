#!/usr/bin/env python3
"""
dsh-flp-studio Python bridge.

Reads and analyzes FL Studio .flp project files, and edits notes, using the
PyFLP library. The Node host spawns this script (one-shot, JSON-in / JSON-out)
so the plugin itself never needs to embed Python: it shells out to the local
Python that already has pyflp installed.

Modes (argv[1]):
  analyze <path>       -> full project structure + music feature analysis
  listdir <dir>        -> list *.flp (and .fsc/.fst) under a directory (non-recursive)
  editnote <path> <json> -> apply note edits to a COPY (host handles backup)
                             json: { "pattern": <name>, "notes": [
                               { "op":"set", "index":0, "field":"key", "value":60 }
                             ] }

Never mutates the source file: 'editnote' writes to a temp sibling and prints
the temp path, leaving the host responsible for backup + atomic replace.
"""
import sys, os, json, tempfile, shutil, traceback

# Ensure pyflp patch (Python 3.12 enum fix) is applied at import time.
# The patch lives in the installed pyflp; if it's absent we fail gracefully.

def _load_flp(path):
    import pyflp
    return pyflp.parse(path)


def _midi_to_note(midi):
    """Convert a MIDI note number to a note name like 'C4' (FL uses 0-based)."""
    names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    return names[midi % 12] + str((midi // 12) - 1)


def _note_to_midi(note):
    """Convert a note name like 'C4' or 'D#6' to MIDI number."""
    if isinstance(note, int):
        return note
    s = note.strip()
    name = ''
    octave = 0
    for ch in s:
        if ch.isalpha():
            name += ch
        elif ch == '#':
            name += '#'
        elif ch.isdigit():
            octave = octave * 10 + int(ch)
    names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    return names.index(name) + (octave + 1) * 12


def _snapshot_channels(project):
    out = []
    for i, ch in enumerate(project.channels):
        out.append({
            'index': i,
            'name': ch.name,
            'type': type(ch).__name__,
            'volume': getattr(ch, 'volume', None),
            'pan': getattr(ch, 'pan', None),
            'insert': getattr(ch, 'insert', None),
            'enabled': getattr(ch, 'enabled', True),
        })
    return out


def _snapshot_patterns(project):
    out = []
    for i, pat in enumerate(project.patterns):
        try:
            notes = list(pat.notes)
            ncount = len(notes)
            nkeys = [n.key for n in notes]
        except Exception:
            ncount = 0
            nkeys = []
        out.append({
            'index': i,
            'name': getattr(pat, 'name', None),
            'notes': ncount,
            'sample_keys': nkeys[:8],
            'length': getattr(pat, 'length', None),
            'looped': getattr(pat, 'looped', False),
        })
    return out


def _note_key_analysis(project):
    """Music-feature analysis: pitch classes, key detection (Krumhansl-
    Schmuckler), note range, density, average length/velocity."""
    from collections import Counter
    NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
    KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

    pc = Counter()
    count = 0
    positions = []
    lengths = []
    vels = []

    def base_name(note):
        if isinstance(note, str):
            base = ''
            for ch in note:
                if ch.isalpha() or ch == '#':
                    base += ch
                else:
                    break
            return base if base in NOTE_NAMES else None
        if isinstance(note, int):
            return NOTE_NAMES[note % 12]
        return None

    for pat in project.patterns:
        try:
            for n in pat.notes:
                base = base_name(n.key)
                if base:
                    pc[base] += 1
                count += 1
                positions.append(getattr(n, 'position', 0) or 0)
                lengths.append(getattr(n, 'length', 0) or 0)
                vels.append(getattr(n, 'velocity', 0) or 0)
        except Exception:
            continue

    total = sum(pc.values()) or 1

    # Key detection: correlate normalized pitch-class vector with KS profiles
    def correlate(profile):
        vec = [pc.get(NOTE_NAMES[i], 0) / total for i in range(12)]
        return sum(a * b for a, b in zip(vec, profile))

    best_key, best_score = None, -1.0
    for i in range(12):
        maj = correlate(KS_MAJOR[i:] + KS_MAJOR[:i])
        mnr = correlate(KS_MINOR[i:] + KS_MINOR[:i])
        if maj > best_score:
            best_score, best_key = maj, f'{NOTE_NAMES[i]} major'
        if mnr > best_score:
            best_score, best_key = mnr, f'{NOTE_NAMES[i]} minor'

    ppq = getattr(project, 'ppq', 96) or 96
    notes_per_bar = None
    if positions:
        maxpos = max(positions)
        bars = max(maxpos / (ppq * 4), 1)
        notes_per_bar = round(count / bars, 2)

    return {
        'total_notes': count,
        'pitch_classes': {k: v for k, v in pc.most_common()},
        'key': best_key,
        'key_score': round(best_score, 4),
        'notes_per_bar': notes_per_bar,
        'avg_length_ppq': round(sum(lengths) / len(lengths), 1) if lengths else None,
        'avg_velocity': round(sum(vels) / len(vels), 1) if vels else None,
    }


def _b64(s):
    """UTF-8 base64 of a string — pure ASCII, survives any JSON encoding
    (the DSH gateway corrupts non-ASCII in responses on zh-CN Windows)."""
    import base64
    return base64.b64encode(s.encode('utf-8')).decode('ascii')


def _pattern_name(project, index):
    """Pattern display name by index."""
    try:
        pat = next((x for i, x in enumerate(project.patterns) if i == index), None)
        if pat is not None:
            return getattr(pat, 'name', None) or f'#{index}'
    except Exception:
        pass
    return f'#{index}'


def _snapshot_arrangement(project):
    """Extract the playlist (arrangement) structure: which pattern/audio plays
    at which position on which track, with FULL tick precision. Every clip is
    listed; non-pattern clips are audio/sample placements. The agent reads the
    raw timeline to judge the song structure itself."""
    ppq = getattr(project, 'ppq', 96) or 96
    out = {'ppq': ppq, 'tracks': []}
    try:
        import pyflp.arrangement as arr_mod
        for arr in project.arrangements:
            pl = arr.events.first(arr_mod.ArrangementID.Playlist)
            pat_count = len(list(project.patterns))
            rows = []
            for i in range(len(pl)):
                it = pl[i]
                idx = it['item_index']
                pi = idx - 20480 if idx >= 20480 else idx
                rows.append({
                    'track': it['track_rvidx'],
                    'position': it['position'] or 0,          # ticks
                    'length': it['length'] or 0,              # ticks
                    'patternIndex': pi,
                    'isPattern': 0 <= pi < pat_count,
                })
            # group by track, sorted by position
            from collections import defaultdict
            by_track = defaultdict(list)
            for r in rows:
                by_track[r['track']].append(r)
            tracks = []
            for t in sorted(by_track):
                clips = sorted(by_track[t], key=lambda r: (r['position'], r['patternIndex']))
                tracks.append({
                    'track': t,
                    'clips': [{
                        'position': c['position'],
                        'length': c['length'],
                        'patternIndex': c['patternIndex'],
                        'name': _pattern_name(project, c['patternIndex']) if c['isPattern'] else '(audio)',
                        'isPattern': c['isPattern'],
                    } for c in clips],
                })
            out = {'ppq': ppq, 'tracks': tracks}
            break  # first arrangement only
    except Exception:
        pass
    return out


def _snapshot_pattern_notes(project):
    """Complete note-sequence per pattern: ALL notes with full ppq-tick
    precision (positions/lengths in ticks; divide by ppq for beats/quarters).
    No sampling — the agent should get the entire score to judge for itself."""
    ppq = getattr(project, 'ppq', 96) or 96
    out = []
    for i, pat in enumerate(project.patterns):
        try:
            notes = list(pat.notes)
            seq = [{
                'key': n.key,
                'pos': getattr(n, 'position', 0) or 0,       # ticks
                'len': getattr(n, 'length', 0) or 0,          # ticks
                'vel': getattr(n, 'velocity', 0) or 0,
                'pan': getattr(n, 'pan', 64) or 64,
                'rack': getattr(n, 'rack_channel', 0) or 0,
            } for n in notes]
            out.append({
                'index': i,
                'name': getattr(pat, 'name', None),
                'notes': len(notes),
                'sequence': seq,
            })
        except Exception:
            out.append({'index': i, 'name': getattr(pat, 'name', None), 'notes': 0, 'sequence': []})
    return out


def _time_signature(p):
    """Read the project time signature (e.g. 3/4) from the arrangement events."""
    try:
        import pyflp.arrangement as arr_mod
        num = p.events.first(arr_mod.ArrangementsID.TimeSigNum)
        beat = p.events.first(arr_mod.ArrangementsID.TimeSigBeat)
        n = getattr(num, 'value', None)
        b = getattr(beat, 'value', None)
        if n is not None and b:
            return {'num': n, 'beat': b, 'label': f'{n}/{b}'}
    except Exception:
        pass
    return None


def _snapshot_timemarkers(project):
    """Time markers: time-signature changes along the timeline (position in ticks).
    e.g. [{position:0, num:3, beat:4}, {position:5760, num:4, beat:4}] = 3/4 then 4/4."""
    out = []
    try:
        for arr in project.arrangements:
            for tm in arr.timemarkers:
                out.append({
                    'position': getattr(tm, 'position', 0) or 0,
                    'num': getattr(tm, 'numerator', None),
                    'beat': getattr(tm, 'denominator', None),
                    'name': getattr(tm, 'name', None),
                })
            break
    except Exception:
        pass
    return out


def _snapshot_fx(project):
    """Per-mixer-track effect chains: list of plugin names in slot order."""
    out = []
    try:
        from pyflp.plugin import PluginID
        mixer = getattr(project, 'mixer', None)
        for mt in mixer:
            names = []
            try:
                for e in mt.events:
                    if getattr(e, 'id', None) == PluginID.InternalName:
                        v = getattr(e, 'string', None) or getattr(e, 'value', None)
                        if v:
                            names.append(v)
            except Exception:
                pass
            if names:
                out.append({
                    'track': getattr(mt, 'iid', None),
                    'name': getattr(mt, 'name', None),
                    'fx': names,
                })
    except Exception:
        pass
    return out


def _analyze(path):
    p = _load_flp(path)
    ts = _time_signature(p)
    return {
        'ok': True,
        'file': path,
        'file_b64': _b64(path),
        'format': getattr(p, 'format', None),
        'version': str(getattr(p, 'version', '')),
        'ppq': getattr(p, 'ppq', None),
        'tempo': getattr(p, 'tempo', None),
        'time_signature': ts,
        'timemarkers': _snapshot_timemarkers(p),
        'fx_chains': _snapshot_fx(p),
        'title': getattr(p, 'title', ''),
        'genre': getattr(p, 'genre', ''),
        'channel_count': getattr(p, 'channel_count', len(p.channels)),
        'patterns': _snapshot_patterns(p),
        'pattern_notes': _snapshot_pattern_notes(p),
        'channels': _snapshot_channels(p),
        'arrangement': _snapshot_arrangement(p),
        'mixer_tracks': len(getattr(p, 'mixer', [])),
        'features': _note_key_analysis(p),
    }


def _listdir(directory):
    # Friendly: if the caller passed a FILE path, list its containing directory.
    if not os.path.isdir(directory):
        parent = os.path.dirname(directory)
        if parent and os.path.isdir(parent):
            directory = parent
        else:
            return {'ok': False, 'message': f'not a directory: {directory}', 'files': []}
    exts = ('.flp', '.fsc', '.fst')
    files = []
    try:
        for entry in sorted(os.listdir(directory)):
            full = os.path.join(directory, entry)
            if os.path.isfile(full) and entry.lower().endswith(exts):
                files.append({
                    'name': entry,
                    'path': full,
                    'path_b64': _b64(full),
                    'size': os.path.getsize(full),
                    'mtime': os.path.getmtime(full),
                })
    except Exception as e:
        return {'ok': False, 'message': str(e), 'files': []}
    return {'ok': True, 'directory': directory, 'directory_b64': _b64(directory), 'files': files}


def _get_pattern(p, pattern_name):
    for pat in p.patterns:
        if getattr(pat, 'name', None) == pattern_name:
            return pat
    return None


def _get_notes_event(pat):
    import pyflp.pattern as ptn
    if ptn.PatternID.Notes not in pat.events.ids:
        return None
    return pat.events.first(ptn.PatternID.Notes)


def _find_pattern_by_index(p, index):
    for i, pat in enumerate(p.patterns):
        if i == index:
            return pat
    return None


def _editnotes(path, spec):
    """Apply note edits (set/add/delete/newpattern) to a temp copy.
    spec: {pattern?, pattern_index?, notes:[{op, ...}]}
      op 'set'        : {op:'set', index, field, value}        -> modify existing note
      op 'add'        : {op:'add', key, position, length, velocity, pan, rack_channel}
      op 'delete'     : {op:'delete', index}                   -> remove note at index
      op 'newpattern' : {op:'newpattern', name?, notes:[...], playlist_position?,
                         playlist_track?, rack_channel?}        -> CREATE a new pattern
                         (writes notes, optionally places it in the playlist after
                         existing content; returns the new pattern's index)
    Writes to a temp sibling; host backs up + atomically replaces.
    """
    import struct
    import pyflp.pattern as ptn
    import pyflp.arrangement as am
    from pyflp._events import U16Event, IndexedEvent

    p = _load_flp(path)
    edits = spec.get('notes', [])
    applied = []

    # --- op 'newpattern': create a fresh pattern (before any per-pattern ops) ---
    newpat_op = next((ed for ed in edits if ed.get('op') == 'newpattern'), None)
    if newpat_op is not None:
        # 1. Build the new pattern's note data
        template = None
        for pat in p.patterns:
            nl = list(pat.notes)
            if nl:
                template = dict(nl[0]._item)
                break
        if template is None:
            template = {
                'position': 0, 'flags': 0, 'rack_channel': 0, 'length': 96,
                'key': 60, 'group': 0, 'fine_pitch': 120, '_u1': 0,
                'release': 0, 'midi_channel': 0, 'pan': 64, 'velocity': 100,
                'mod_x': 128, 'mod_y': 128,
            }
        rc = newpat_op.get('rack_channel', newpat_op.get('rackChannel', template['rack_channel']))
        payloads = []
        for n in newpat_op.get('notes', []):
            item = dict(template)
            item['position'] = int(n.get('position', 0))
            item['length'] = int(n.get('length', 96))
            item['key'] = int(n.get('key', 60))
            item['velocity'] = int(n.get('velocity', 100))
            item['pan'] = int(n.get('pan', 64))
            # Per-note rack channel wins; fall back to the pattern-level one.
            item['rack_channel'] = int(n.get('rack_channel', n.get('rackChannel', rc)))
            payloads.append(ptn.NotesEvent.STRUCT.build(item))
        notes_data = b''.join(payloads)

        # 2. Find next New value + max root index, append New + NotesEvent
        last_new_val = 0
        max_r = 0
        for ie in p.events.lst:
            if ie.r > max_r:
                max_r = ie.r
            if getattr(ie.e, 'id', None) == ptn.PatternID.New:
                last_new_val = getattr(ie.e, 'value', 0) or 0
        new_val = last_new_val + 1
        notes_evt = ptn.NotesEvent(ptn.PatternID.Notes, notes_data)
        new_evt = U16Event(ptn.PatternID.New, struct.pack('<H', new_val))
        p.events.lst.add(IndexedEvent(max_r + 1, new_evt))
        p.events.lst.add(IndexedEvent(max_r + 2, notes_evt))

        # 3. Optionally set a pattern name (UnicodeEvent Name, UTF-16LE + null term)
        pname = newpat_op.get('name')
        if pname:
            from pyflp._events import UnicodeEvent
            name_evt = UnicodeEvent(ptn.PatternID.Name, pname.encode('utf-16-le') + b'\x00\x00')
            p.events.lst.add(IndexedEvent(max_r + 3, name_evt))

        new_idx = len(list(p.patterns)) - 1  # index of the appended (last) pattern
        new_pat = _find_pattern_by_index(p, new_idx)

        # 4. Optionally place in playlist after existing content
        placed = False
        pl_pos = newpat_op.get('playlist_position', newpat_op.get('playlistPosition'))
        pl_track = newpat_op.get('playlist_track', newpat_op.get('playlistTrack'))
        if pl_pos is not None:
            try:
                # playlist length: explicit, else span of the written notes (max end)
                span = 0
                for n in newpat_op.get('notes', []):
                    span = max(span, int(n.get('position', 0)) + int(n.get('length', 0)))
                pl_len = newpat_op.get('playlist_length', newpat_op.get('playlistLength', span or 96))
                for arr in p.arrangements:
                    pl = arr.events.first(am.ArrangementID.Playlist)
                    if len(pl) > 0:
                        it0 = pl[0]
                    else:
                        # Empty playlist: synthesize a default clip template
                        # (field layout mirrors am.PlaylistEvent.STRUCT).
                        it0 = {
                            'position': 0, 'pattern_base': 20480, 'item_index': 0,
                            'length': 96, 'track_rvidx': 0, 'group': 0,
                            '_u1': b'\x78\x00', 'item_flags': 64,
                            '_u2': b'\x40\x64\x80\x80',
                            'start_offset': -1.0, 'end_offset': -1.0,
                            '_u3': b'\x00' * 28,
                        }
                    # FL references patterns by 20480 + pattern's New value (1-based),
                    # NOT by list index. Audio clips have their own object ids and must
                    # never be renumbered.
                    new_ref = (it0['pattern_base'] or 20480) + new_val
                    item = dict(it0)
                    item['position'] = int(pl_pos)
                    item['length'] = int(pl_len)
                    item['item_index'] = new_ref
                    item['track_rvidx'] = int(pl_track) if pl_track is not None else it0['track_rvidx']
                    item['group'] = 0
                    item['start_offset'] = -1.0
                    item['end_offset'] = -1.0
                    payload = am.PlaylistEvent.STRUCT.build(item, new=False)
                    pl._data = pl._data + payload
                    placed = True
                    break
            except Exception as e:
                return {'ok': False, 'message': f'newpattern playlist placement failed: {type(e).__name__}: {e}', 'applied': applied}

        applied.append({
            'op': 'newpattern',
            'patternIndex': new_idx,
            'name': pname or None,
            'notes': len(payloads),
            'playlistPlaced': placed,
        })

        # Continue processing any per-pattern ops against the NEW pattern
        pattern_index = new_idx
        target = new_pat
        pattern_ref = None
    else:
        pattern_ref = spec.get('pattern')
        pattern_index = spec.get('pattern_index', spec.get('patternIndex'))
        target = None
        if pattern_index is not None:
            target = _find_pattern_by_index(p, pattern_index)
        elif pattern_ref is not None:
            target = _get_pattern(p, pattern_ref)
        if target is None:
            return {'ok': False, 'message': f'pattern not found: {pattern_ref or pattern_index}'}

    notes_event = _get_notes_event(target)
    if notes_event is None:
        notes_event = ptn.NotesEvent(ptn.PatternID.Notes, b'')
        target.events.append(notes_event)

    notes = list(target.notes)
    for ed in spec.get('notes', []):
        op = ed.get('op')
        if op == 'newpattern':
            continue  # already handled above
        try:
            if op == 'set':
                idx = ed.get('index')
                if idx is None or idx >= len(notes):
                    continue
                note = notes[idx]
                field = ed.get('field')
                if hasattr(note, field):
                    old = getattr(note, field)
                    setattr(note, field, ed.get('value'))
                    applied.append({'op': 'set', 'index': idx, 'field': field, 'old': str(old), 'new': str(ed.get('value'))})
            elif op == 'add':
                # Clone the first existing note's container for correct field
                # types, else build a default container.
                if notes:
                    item = dict(notes[0]._item)
                else:
                    item = {
                        'position': 0, 'flags': 0, 'rack_channel': 0, 'length': 96,
                        'key': 60, 'group': 0, 'fine_pitch': 120, '_u1': 0,
                        'release': 0, 'midi_channel': 0, 'pan': 64, 'velocity': 100,
                        'mod_x': 128, 'mod_y': 128,
                    }
                item['position'] = int(ed.get('position', item['position']))
                item['length'] = int(ed.get('length', item['length']))
                item['key'] = int(ed.get('key', item['key']))
                item['velocity'] = int(ed.get('velocity', item['velocity']))
                item['pan'] = int(ed.get('pan', item['pan']))
                rc = ed.get('rack_channel', ed.get('rackChannel', item['rack_channel']))
                item['rack_channel'] = int(rc)
                payload = ptn.NotesEvent.STRUCT.build(item)
                # Append at the end of the note data.
                notes_event._data = notes_event._data + payload
                applied.append({'op': 'add', 'key': item['key'], 'position': item['position'],
                                'length': item['length'], 'velocity': item['velocity']})
                notes = list(target.notes)
            elif op == 'delete':
                idx = ed.get('index')
                if idx is None or idx >= len(notes):
                    continue
                size = notes_event._struct_size
                start = size * idx
                notes_event._data = notes_event._data[:start] + notes_event._data[start + size:]
                applied.append({'op': 'delete', 'index': idx})
                notes = list(target.notes)
        except Exception as e:
            return {'ok': False, 'message': f'op {op} failed: {type(e).__name__}: {e}', 'applied': applied}

    d = os.path.dirname(os.path.abspath(path)) or '.'
    tmp = os.path.join(d, '.' + os.path.basename(path) + '.dsh-flp-studio.tmp.flp')
    try:
        import pyflp
        pyflp.save(p, tmp)
    except Exception as e:
        return {'ok': False, 'message': f'save failed: {e}', 'applied': applied}
    return {'ok': True, 'tmp': tmp, 'applied': applied, 'message': 'saved to temp; host must backup + replace'}


def _read_stdin():
    """Read the optional JSON spec from stdin (robust for spaces/unicode)."""
    data = sys.stdin.read()
    if not data.strip():
        return {}
    try:
        return json.loads(data)
    except Exception:
        return {}


def main():
    if len(sys.argv) < 3:
        print(json.dumps({'ok': False, 'message': 'usage: bridge.py <mode> <path>  (spec via stdin for editnote)'}))
        return 1
    mode = sys.argv[1]
    target = sys.argv[2]
    try:
        if mode == 'analyze':
            print(json.dumps(_analyze(target), ensure_ascii=False))
        elif mode == 'listdir':
            print(json.dumps(_listdir(target), ensure_ascii=False))
        elif mode == 'editnote':
            spec = _read_stdin()
            print(json.dumps(_editnotes(target, spec), ensure_ascii=False))
        else:
            print(json.dumps({'ok': False, 'message': f'unknown mode: {mode}'}))
            return 1
        return 0
    except Exception as e:
        print(json.dumps({'ok': False, 'message': f'{type(e).__name__}: {e}', 'trace': traceback.format_exc()[-800:]}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
