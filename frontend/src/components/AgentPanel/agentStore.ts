import { useSyncExternalStore } from 'react';

export type ToolCall = {
  id: string;
  name: string;
  input: string;
  output: string;
  state: 'running' | 'done' | 'error';
};

export type PendingApproval = {
  callId: string;
  tool: string;
  input: string;
  command: string;
  sessionId: string;
  prompt: string;
};

export type Status = 'idle' | 'running' | 'pending';

export type Block =
  | { kind: 'user'; text: string }
  | { kind: 'system'; text: string; collapsed: boolean }
  | { kind: 'thinking'; text: string; streaming: boolean; collapsed: boolean }
  | { kind: 'tool'; call: ToolCall; collapsed: boolean }
  | { kind: 'assistant'; text: string; streaming: boolean }
  | { kind: 'error'; text: string };

export type AgentState = {
  blocks: Block[];
  pending: PendingApproval | null;
  status: Status;
  configured: boolean | null;
};

// Module-level store: the conversation lives outside the component so a dockview
// remount (the cause of tool cards vanishing mid-turn) never wipes it.
let state: AgentState = {
  blocks: [],
  pending: null,
  status: 'idle',
  configured: null,
};

const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getAgentState(): AgentState {
  return state;
}

export function useAgentStore(): AgentState {
  return useSyncExternalStore(subscribe, () => state);
}

export function updateBlocks(updater: (prev: Block[]) => Block[]) {
  state = { ...state, blocks: updater(state.blocks) };
  notify();
}

export function setPending(pending: PendingApproval | null) {
  state = { ...state, pending };
  notify();
}

export function setStatus(status: Status) {
  state = { ...state, status };
  notify();
}

export function setConfigured(configured: boolean) {
  state = { ...state, configured };
  notify();
}
