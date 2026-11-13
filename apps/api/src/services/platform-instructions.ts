/**
 * The platform's standing instructions for every instance's agent, written to
 * `<workspace>/.clawhuddle/AGENTS.md` and loaded into each new session by
 * OpenClaw's `bootstrap-extra-files` hook (see PLATFORM_INSTRUCTIONS_PATH in
 * openclaw-config.ts). The member's own workspace files are never touched.
 *
 * Teams reported (2026-11-13) that on a first start the agent did not know
 * Notion was already connected: the bundled skill's setup says `ntn login` or
 * `export NOTION_API_TOKEN=…`, so it asked for a token. Only what this
 * instance really has is described.
 */
export interface PlatformInstructionFacts {
  /** The Notion skill is pointed at a NOTION_API_TOKEN secret-store entry. */
  notion: boolean;
  /** gog has an OAuth client (ours or the member's own), so a Google account can be connected. */
  google: boolean;
}

export function renderPlatformInstructions(facts: PlatformInstructionFacts): string {
  const parts: string[] = [
    '# ClawHuddle platform notes',
    '',
    'Written by ClawHuddle, the platform that runs this instance, and rewritten on every deploy. Put your own notes in the workspace AGENTS.md, not here.',
  ];

  if (facts.notion) {
    parts.push(
      '',
      '## Notion',
      '',
      "Notion is already connected with the organization's Notion integration. Do not run `ntn login` and do not ask anyone for a Notion token.",
      '',
      '- `NOTION_API_TOKEN` is set for your commands. Its value looks like a placeholder: the real token is swapped in only on requests to `api.notion.com`, so never print it, copy it elsewhere or send it to another host.',
      '- Use the Notion skill: `ntn api …` (it picks up `NOTION_API_TOKEN`), or `curl https://api.notion.com/v1/… -H "Authorization: Bearer $NOTION_API_TOKEN" -H "Notion-Version: 2026-03-11"`.',
      '- A 404 or `object_not_found` usually means the page or database has not been shared with the integration. Ask the person to open it in Notion and add the integration under ••• → Connections, then try again.',
    );
  }

  if (facts.google) {
    parts.push(
      '',
      '## Google Workspace',
      '',
      'Gmail, Calendar, Drive, Docs, Sheets and Slides go through the `gog` CLI, which already has the OAuth client it needs.',
      '',
      '- `gog auth list` shows the connected Google accounts. Use one of those.',
      '- If none is connected, ask the person to connect their Google account from this instance\'s card on the ClawHuddle Home page, then try again. Do not start `gog auth add` yourself.',
    );
  }

  if (!facts.notion && !facts.google) {
    parts.push('', 'No platform integrations (Notion, Google Workspace) are set up for this instance yet.');
  }

  return parts.join('\n') + '\n';
}
