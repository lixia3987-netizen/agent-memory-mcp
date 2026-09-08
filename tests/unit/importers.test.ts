import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frontmatter, splitHeadings, MarkdownImporter } from '../../src/importers/markdown.ts';
import { JsonImporter } from '../../src/importers/json.ts';
import { ClaudeCodeImporter } from '../../src/importers/claude-code.ts';

test('Markdown parser keeps frontmatter, code fences, title sections and provenance', () => {
  const text = '---\ntype: decision\ntags:\n  - yjs\ndescription: custom\n---\n# Project\n\n## Choice\nUse SQLite.\n```md\n## Not a section\n```\n### Constraint\nWindows native.';
  const records = new MarkdownImporter().parse({ text, path: 'memory.md', hash: 'abc', mtime: 123 });
  assert.equal(records.length, 3); assert.equal(records[1]!.record.title, 'Choice');
  assert.ok(records[1]!.record.content.includes('Not a section'));
  assert.deepEqual(records[1]!.record.tags, ['yjs']);
  assert.deepEqual(records[1]!.record.metadata?.frontmatter, { description: 'custom' });
});
test('malformed frontmatter and unsupported JSON versions fail clearly', () => {
  assert.throws(() => frontmatter('---\na: [\n---\nbody'));
  assert.throws(() => frontmatter('---\na: x\nbody'));
  assert.throws(() => new JsonImporter().parse({ text: '{"schemaVersion":2,"memories":[]}', path: 'x', hash: '', mtime: null }));
});
test('Claude adapter preserves custom fields and explicitly marks its source', () => {
  const records = new ClaudeCodeImporter().parse({ text: '---\nname: My preference\ntype: feedback\n---\nUse TypeScript.', path: 'preference.md', hash: 'hash', mtime: 1 });
  assert.equal(records[0]!.record.source, 'claude-code'); assert.equal(records[0]!.record.type, 'feedback');
  assert.equal(records[0]!.record.title, 'My preference');
});
test('heading keys stay stable when a different heading is inserted', () => {
  const before = splitHeadings('## A\nalpha\n## B\nbeta');
  const after = splitHeadings('## X\nextra\n## A\nalpha\n## B\nbeta');
  assert.equal(before[1]!.key, after[2]!.key);
});
