import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { agentName } from '../lib/agent';
import { runTool, type AgentContext } from '../lib/agentTools';

// AI agents: answers the tool calls `wave mcp` passes through the app
// (src-tauri/src/agent.rs emits them as `agent:request`). Runs once, in App,
// which supplies the project list and the ability to open and import projects.

interface Request {
  id:        number;
  tool:      string;
  arguments: Record<string, unknown> | null;
  client:    string | null;
}

export function useAgentBridge(context: Omit<AgentContext, 'agent'>) {
  const contextRef = useRef(context);
  contextRef.current = context;

  useEffect(() => {
    const unlisten = listen<Request>('agent:request', async ({ payload }) => {
      let ok = true;
      let text: string;
      try {
        text = await runTool(payload.tool, payload.arguments ?? {}, { ...contextRef.current, agent: agentName(payload.client) });
      } catch (e) {
        ok = false;
        text = e instanceof Error ? e.message : String(e);
      }
      invoke('agent_reply', { id: payload.id, ok, text }).catch((e) => console.warn('Could not answer the agent:', e));
    });
    return () => { void unlisten.then((fn) => fn()); };
  }, []);
}
