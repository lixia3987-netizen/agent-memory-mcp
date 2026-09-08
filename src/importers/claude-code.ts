import { MarkdownImporter } from './markdown.ts';

// The adapter recognizes Markdown/frontmatter only. It does not read chats,
// credentials or undocumented client databases.
export class ClaudeCodeImporter extends MarkdownImporter { override readonly id = 'claude-code'; }
