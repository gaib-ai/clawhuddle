import { describe, expect, it } from 'vitest';
import { renderPlatformInstructions } from './platform-instructions.js';

describe('renderPlatformInstructions', () => {
  it('tells the agent Notion is connected and not to log in or ask for a token', () => {
    const text = renderPlatformInstructions({ notion: true, google: false });
    expect(text).toContain('## Notion');
    expect(text).toContain('Do not run `ntn login`');
    expect(text).toContain('NOTION_API_TOKEN');
    expect(text).not.toContain('## Google');
  });

  it('sends the member to the Home card when no Google account is connected', () => {
    const text = renderPlatformInstructions({ notion: false, google: true });
    expect(text).toContain('`gog auth list`');
    expect(text).toContain('Home page');
    expect(text).not.toContain('## Notion');
  });

  it('says nothing is set up rather than promising an integration', () => {
    const text = renderPlatformInstructions({ notion: false, google: false });
    expect(text).not.toContain('## Notion');
    expect(text).not.toContain('## Google');
    expect(text).toContain('No platform integrations');
  });
});
