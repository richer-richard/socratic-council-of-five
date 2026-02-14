import { create } from "zustand";
import type {
  AgentId as CouncilAgentId,
  BiddingRound,
  ConflictDetection,
  CostTracker,
  DuoLogue,
  Message as SharedMessage,
  PairwiseConflict,
} from "@socratic-council/shared";
import type { Provider } from "./config";

export type SidePanelView = "default" | "logs" | "search" | "export";

export type ReactionBar = Partial<Record<string, { count: number; by: string[] }>>;

export interface ChatMessage extends SharedMessage {
  isStreaming?: boolean;
  error?: string;
  quotedMessageIds?: string[];
  reactions?: ReactionBar;
  displayName?: string;
  displayProvider?: Provider;
}

export interface CouncilSessionState {
  messages: ChatMessage[];
  typingAgents: CouncilAgentId[];
  currentTurn: number;
  isRunning: boolean;
  isPaused: boolean;
  showBidding: boolean;
  currentBidding: BiddingRound | null;
  totalTokens: { input: number; output: number; reasoning?: number };
  errors: string[];
  sidePanelView: SidePanelView;
  costState: CostTracker | null;
  conflictState: ConflictDetection | null;
  allConflicts: PairwiseConflict[];
  duoLogue: DuoLogue | null;
  reactionPickerTarget: string | null;
  recentlyCopiedQuote: string | null;
  highlightedMessageId: string | null;

  reset: () => void;
  setIsRunning: (value: boolean) => void;
  setIsPaused: (value: boolean) => void;
  setCurrentTurn: (value: number) => void;
  setTypingAgents: (value: CouncilAgentId[]) => void;
  setSidePanelView: (value: SidePanelView) => void;
  setShowBidding: (value: boolean) => void;
  setCurrentBidding: (value: BiddingRound | null) => void;
  setCostState: (value: CostTracker | null) => void;
  setConflictState: (value: ConflictDetection | null) => void;
  setAllConflicts: (value: PairwiseConflict[]) => void;
  setDuoLogue: (value: DuoLogue | null) => void;
  pushError: (message: string) => void;
  setReactionPickerTarget: (value: string | null) => void;
  setRecentlyCopiedQuote: (value: string | null) => void;
  setHighlightedMessageId: (value: string | null) => void;
  setMessages: (messages: ChatMessage[]) => void;
  addMessage: (message: ChatMessage) => void;
  upsertMessage: (message: ChatMessage) => void;
  updateMessage: (id: string, updater: (message: ChatMessage) => ChatMessage) => void;
  removeStreamingMessages: () => void;
  addTokens: (tokens: { input: number; output: number; reasoning?: number }) => void;
  toggleUserReaction: (targetId: string, emoji: string) => void;
}

const initialState = {
  messages: [] as ChatMessage[],
  typingAgents: [] as CouncilAgentId[],
  currentTurn: 0,
  isRunning: false,
  isPaused: false,
  showBidding: false,
  currentBidding: null as BiddingRound | null,
  totalTokens: { input: 0, output: 0 } as { input: number; output: number; reasoning?: number },
  errors: [] as string[],
  sidePanelView: "default" as SidePanelView,
  costState: null as CostTracker | null,
  conflictState: null as ConflictDetection | null,
  allConflicts: [] as PairwiseConflict[],
  duoLogue: null as DuoLogue | null,
  reactionPickerTarget: null as string | null,
  recentlyCopiedQuote: null as string | null,
  highlightedMessageId: null as string | null,
};

export const useCouncilSessionStore = create<CouncilSessionState>((set) => ({
  ...initialState,

  reset: () => set({ ...initialState }),
  setIsRunning: (value) => set({ isRunning: value }),
  setIsPaused: (value) => set({ isPaused: value }),
  setCurrentTurn: (value) => set({ currentTurn: value }),
  setTypingAgents: (value) => set({ typingAgents: value }),
  setSidePanelView: (value) => set({ sidePanelView: value }),
  setShowBidding: (value) => set({ showBidding: value }),
  setCurrentBidding: (value) => set({ currentBidding: value }),
  setCostState: (value) => set({ costState: value }),
  setConflictState: (value) => set({ conflictState: value }),
  setAllConflicts: (value) => set({ allConflicts: value }),
  setDuoLogue: (value) => set({ duoLogue: value }),
  pushError: (message) => set((state) => ({ errors: [...state.errors, message].slice(-50) })),
  setReactionPickerTarget: (value) => set({ reactionPickerTarget: value }),
  setRecentlyCopiedQuote: (value) => set({ recentlyCopiedQuote: value }),
  setHighlightedMessageId: (value) => set({ highlightedMessageId: value }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
  upsertMessage: (message) =>
    set((state) => {
      const index = state.messages.findIndex((m) => m.id === message.id);
      if (index === -1) return { messages: [...state.messages, message] };
      const next = state.messages.slice();
      next[index] = message;
      return { messages: next };
    }),
  updateMessage: (id, updater) =>
    set((state) => {
      const index = state.messages.findIndex((m) => m.id === id);
      if (index === -1) return state;
      const next = state.messages.slice();
      next[index] = updater(next[index]!);
      return { messages: next };
    }),
  removeStreamingMessages: () =>
    set((state) => ({ messages: state.messages.filter((m) => !m.isStreaming) })),
  addTokens: (tokens) =>
    set((state) => ({
      totalTokens: {
        input: state.totalTokens.input + (tokens.input ?? 0),
        output: state.totalTokens.output + (tokens.output ?? 0),
        reasoning:
          (state.totalTokens.reasoning ?? 0) + (tokens.reasoning ?? 0) || undefined,
      },
    })),
  toggleUserReaction: (targetId, emoji) =>
    set((state) => ({
      messages: state.messages.map((message) => {
        if (message.id !== targetId) return message;

        const existingBar = (message.reactions ?? {}) as ReactionBar;
        const nextBar: ReactionBar = { ...existingBar };

        const existing = nextBar[emoji] ?? { count: 0, by: [] };
        const alreadyReacted = existing.by.includes("user");

        if (alreadyReacted) {
          const nextBy = existing.by.filter((id) => id !== "user");
          const nextCount = Math.max(0, existing.count - 1);
          if (nextCount === 0) {
            delete nextBar[emoji];
          } else {
            nextBar[emoji] = { count: nextCount, by: nextBy };
          }
        } else {
          nextBar[emoji] = { count: existing.count + 1, by: [...existing.by, "user"] };
        }

        return { ...message, reactions: nextBar };
      }),
    })),
}));

export function getCouncilMessageIndexById(messages: ChatMessage[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < messages.length; i += 1) {
    map.set(messages[i]!.id, i);
  }
  return map;
}

export function getCouncilMessageById(messages: ChatMessage[]): Map<string, ChatMessage> {
  const map = new Map<string, ChatMessage>();
  for (const message of messages) {
    map.set(message.id, message);
  }
  return map;
}
