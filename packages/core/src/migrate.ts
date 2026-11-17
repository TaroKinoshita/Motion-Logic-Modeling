import { SceneV1Schema } from './schema-v1.ts';
import { SceneSchema } from './schema.ts';
import type { Scene } from './schema.ts';

/** Read-only migration; persistence is owned by the server's next explicit commit. */
export function migrateScene(input: unknown): Scene {
  const version = (input as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (version === 1) return SceneSchema.parse({ ...SceneV1Schema.parse(input), schemaVersion: 2 });
  return SceneSchema.parse(input);
}
