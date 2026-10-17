import { useEffect, useState } from 'react';
import { CodeSnippet, InlineNotification, Stack, Tile, Toggle } from '@carbon/react';
import { invoke } from '@tauri-apps/api/core';

// Settings → AI agents: the switch that lets agent apps connect (agent.rs) and
// how to add Wave to each of them. They all launch the same command,
// `<this app's executable> mcp` (mcp.rs), a local MCP server over stdio.

interface AgentStatus {
  enabled: boolean;
  /** This app's executable: agent apps run it with `mcp`. */
  command: string;
}

export function AgentAccess() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<AgentStatus>('agent_status').then(setStatus).catch((e) => setError(String(e)));
  }, []);

  async function toggle(enabled: boolean) {
    setError(null);
    try {
      setStatus(await invoke<AgentStatus>('set_agent_access', { enabled }));
    } catch (e) {
      setError(String(e));
    }
  }

  const command = status?.command ?? '';
  const shell = /[\s"'$`\\]/.test(command) ? `"${command.replace(/(["$`\\])/g, '\\$1')}"` : command;
  const desktopConfig = [
    '{',
    '  "mcpServers": {',
    '    "wave": {',
    `      "command": ${JSON.stringify(command)},`,
    '      "args": ["mcp"]',
    '    }',
    '  }',
    '}',
  ].join('\n');
  const devBuild = command.includes('/target/debug/');

  return (
    <Tile className="wave-agents">
      <Stack gap={6}>
        <Toggle
          id="wave-agent-access"
          labelText="Let AI agents work in Wave"
          labelA="Off"
          labelB="On"
          toggled={status?.enabled ?? false}
          disabled={status === null}
          onToggle={(on: boolean) => void toggle(on)}
        />
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Couldn't change agent access" subtitle={error} />}

        {status?.enabled && (
          <Stack gap={6}>
            <p className="wave-agents__note">
              Add Wave to your agent app once, using the steps below. Keep Wave open while an agent works: a project opens in
              the editor when the agent starts on it.
            </p>

            <section className="wave-agents__client">
              <h3 className="wave-agents__title">Claude Desktop</h3>
              <p className="wave-agents__note">
                Claude → Settings → Developer → Edit Config. Add <code>wave</code> to <code>mcpServers</code> in that
                file (or paste this if the file is empty), then quit and reopen Claude.
              </p>
              <CodeSnippet type="multi" feedback="Copied" wrapText>{desktopConfig}</CodeSnippet>
            </section>

            <section className="wave-agents__client">
              <h3 className="wave-agents__title">Claude Code</h3>
              <CodeSnippet type="multi" feedback="Copied" wrapText>{`claude mcp add --scope user wave -- ${shell} mcp`}</CodeSnippet>
            </section>

            <section className="wave-agents__client">
              <h3 className="wave-agents__title">ChatGPT desktop app and Codex</h3>
              <p className="wave-agents__note">
                In ChatGPT: Settings → MCP servers → Add server. Choose STDIO, use the command below with the
                argument <code>mcp</code>, save and restart. It works in ChatGPT&apos;s Codex and Work modes. Or run
                this in a terminal:
              </p>
              <CodeSnippet type="multi" feedback="Copied" wrapText>{`codex mcp add wave -- ${shell} mcp`}</CodeSnippet>
              <p className="wave-agents__note">
                ChatGPT in the browser, and the desktop app&apos;s plain chat, only reach servers on the internet, so
                they can&apos;t connect to Wave.
              </p>
            </section>

            <section className="wave-agents__client">
              <h3 className="wave-agents__title">Then ask, for example</h3>
              <CodeSnippet type="multi" feedback="Copied" wrapText>{
                'In my Wave project "Episode 12", remove the filler words and false starts, tighten the pauses, ' +
                'fix any misspelled names, enhance the audio with the Clearer EQ, and tell me what you changed.'
              }</CodeSnippet>
            </section>

            {devBuild && (
              <p className="wave-agents__note">
                This is the development build, so the command points into <code>src-tauri/target/debug</code>. A
                packaged Wave has its own path; this page shows it there.
              </p>
            )}
          </Stack>
        )}
      </Stack>
    </Tile>
  );
}
