/**
 * dsh-flp-studio shared wire contracts (zod v4).
 * Compiled twice: host via ./typert, client bundled via ctx.remote.$mount.
 */
import { z } from 'zod';

export const flpFile = z.object({
  name: z.string(),
  path: z.string(),
  pathB64: z.string().optional(),
  size: z.number(),
  mtime: z.number(),
}).readonly();

export const listDirResult = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  directory: z.string().optional(),
  directoryB64: z.string().optional(),
  default: z.boolean().optional(),
  files: z.array(flpFile).default([]).readonly(),
}).readonly();

export const channelInfo = z.object({
  index: z.number(),
  name: z.string(),
  type: z.string(),
  volume: z.number().nullable().optional(),
  pan: z.number().nullable().optional(),
  insert: z.number().nullable().optional(),
  enabled: z.boolean().optional(),
}).readonly();

export const patternInfo = z.object({
  index: z.number(),
  name: z.string().nullable(),
  notes: z.number(),
  sampleKeys: z.array(z.string()).optional(),
  length: z.number().nullable().optional(),
  looped: z.boolean().optional(),
}).readonly();

export const featureInfo = z.object({
  totalNotes: z.number().optional(),
  pitchClasses: z.record(z.string(), z.number()).optional(),
  key: z.string().optional(),
  keyScore: z.number().optional(),
  notesPerBar: z.number().nullable().optional(),
  avgLengthPpq: z.number().nullable().optional(),
  avgVelocity: z.number().nullable().optional(),
}).readonly();

export const analyzeResult = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  file: z.string().optional(),
  fileB64: z.string().optional(),
  format: z.number().nullable().optional(),
  version: z.string().optional(),
  ppq: z.number().nullable().optional(),
  tempo: z.number().nullable().optional(),
  title: z.string().optional(),
  genre: z.string().optional(),
  channelCount: z.number().optional(),
  mixerTracks: z.number().optional(),
  channels: z.array(channelInfo).default([]).readonly(),
  channelRoles: z.array(z.record(z.string(), z.unknown())).default([]).readonly(),
  patterns: z.array(patternInfo).default([]).readonly(),
  patternNotes: z.array(z.record(z.string(), z.unknown())).default([]).readonly(),
  arrangement: z.record(z.string(), z.unknown()).optional(),
  features: featureInfo.optional(),
}).readonly();

export const noteEditSpec = z.object({
  pattern: z.string().optional(),
  patternIndex: z.number().int().nonnegative().optional(),
  notes: z.array(z.object({
    op: z.enum(['set', 'add', 'delete']),
    index: z.number().int().nonnegative().optional(),
    field: z.string().optional(),
    value: z.union([z.number(), z.string(), z.boolean()]).optional(),
    key: z.number().optional(),
    position: z.number().optional(),
    length: z.number().optional(),
    velocity: z.number().optional(),
    pan: z.number().optional(),
    rackChannel: z.number().optional(),
  })).default([]).readonly(),
}).readonly();

export const editNoteResult = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  backup: z.string().optional(),
  applied: z.array(z.record(z.string(), z.unknown())).optional(),
  size: z.number().optional(),
}).readonly();

export const pickFileResult = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  path: z.string().nullable().optional(),
  pathB64: z.string().optional(),
  cancelled: z.boolean().optional(),
}).readonly();

// dsh >= 0.2.0 requires every strict codec to expose a create() factory; the
// runtime only validates its presence, so it returns an equivalent codec.
const strict = (typeSymbol, schema) => {
  const codec = { mode: 'strict', typeSymbol, schema };
  codec.create = () => strict(typeSymbol, schema);
  return codec;
};
const parameter = (name, schema) => ({ name, wire: name, source: 'json', codec: strict(`dsh-flp-studio/types#${name}`, schema) });

const descriptor = (method, parameters, result, resultSymbol) => ({
  id: `dsh-flp-studio#flp/${method}`,
  service: 'flp',
  namespace: 'flp',
  method,
  invocation: { kind: 'direct' },
  parameters,
  result: strict(`dsh-flp-studio/types#${resultSymbol}`, result),
});

export const descriptors = [
  descriptor('listdir', [parameter('directory', z.string().optional())], listDirResult, 'ListDirResult'),
  descriptor('analyze', [parameter('path', z.string())], analyzeResult, 'AnalyzeResult'),
  descriptor('editNote', [parameter('path', z.string()), parameter('spec', noteEditSpec)], editNoteResult, 'EditNoteResult'),
  descriptor('pickFile', [], pickFileResult, 'PickFileResult'),
];

/** Client Typert artifact mounted via ctx.remote.$mount. */
export const TYPERT_REMOTE = { package: 'dsh-flp-studio', descriptors };

/** Host Typert artifact loaded from the package's `./typert` export. */
export const TYPERT = {
  package: 'dsh-flp-studio',
  face: 'host',
  schemas: [],
  invocations: descriptors,
  model: { services: [], events: [], objects: [] },
};

export default TYPERT_REMOTE;
