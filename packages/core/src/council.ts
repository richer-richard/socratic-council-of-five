/**
 * @fileoverview Council orchestration - manages the debate flow
 * Coordinates agents, bidding, and message streaming
 */

import type {
  AgentConfig,
  AgentId,
  BiddingRound,
  CouncilConfig,
  CouncilState,
  CostTracker,
  ConflictDetection,
  DuoLogue,
  Message,
  OracleResult,
  PairwiseConflict,
  SearchResult,
  VerificationResult,
  Citation,
  ProviderCredentials,
  WhisperMessage,
} from "@socratic-council/shared";
import { DEFAULT_AGENTS, DEFAULT_COUNCIL_CONFIG } from "@socratic-council/shared";
import {
  type ChatMessage,
  type CompletionResult,
  ProviderManager,
  type StreamCallback,
  formatConversationHistory,
} from "@socratic-council/sdk";
import type { Transport } from "@socratic-council/sdk";
import { runBiddingRound } from "./bidding.js";
import { CostTrackerEngine } from "./cost.js";
import { ConflictDetector } from "./conflict.js";
import { FairnessManager } from "./fairness.js";
import { DuckDuckGoOracle } from "./oracle.js";
import { WhisperManager } from "./whisper.js";

/**
 * Generate a unique ID for messages and councils
 */
function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

type ToolName = "oracle.search" | "oracle.verify" | "oracle.cite";

type ToolCall = {
  name: ToolName;
  args: Record<string, unknown>;
};

type ToolResult = {
  name: ToolName;
  output: string;
  raw?: unknown;
  error?: string;
};

const TOOL_TIMEOUT_MS = 12_000;
const MAX_TOOL_ITERATIONS = 2;
const MAX_TOOL_CALLS_PER_ITERATION = 3;
const MAX_CONTEXT_MESSAGES = 16;
const MAX_TOOL_RESULTS = 5;

const TOOL_PATTERN = /@tool\(([^,]+),\s*([\s\S]*?)\)/g;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Tool timeout")), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function normalizeMessageText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractToolCalls(raw: string): { cleaned: string; toolCalls: ToolCall[] } {
  const toolCalls: ToolCall[] = [];

  let cleaned = raw;

  cleaned = cleaned.replace(TOOL_PATTERN, (_, name, argsText) => {
    const toolName = String(name).trim();
    try {
      const parsed = JSON.parse(String(argsText));
      if (toolName === "oracle.search" || toolName === "oracle.verify" || toolName === "oracle.cite") {
        toolCalls.push({
          name: toolName as ToolCall["name"],
          args: typeof parsed === "object" && parsed ? parsed : {},
        });
      }
    } catch {
      // Ignore malformed tool calls
    }
    return "";
  });

  return { cleaned: normalizeMessageText(cleaned), toolCalls };
}

function normalizeStringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function formatSearchResults(results: SearchResult[]): string {
  if (!results.length) return "No results found.";
  return results
    .slice(0, MAX_TOOL_RESULTS)
    .map((r, idx) => `${idx + 1}. ${r.title} — ${r.url}\n${r.snippet}`)
    .join("\n\n");
}

function formatCitations(citations: Citation[]): string {
  if (!citations.length) return "No citations found.";
  return citations
    .slice(0, MAX_TOOL_RESULTS)
    .map((c, idx) => `${idx + 1}. ${c.title} — ${c.url}\n${c.snippet}`)
    .join("\n\n");
}

function formatVerification(result: VerificationResult): string {
  const evidence = result.evidence ?? [];
  return [
    `Verdict: ${result.verdict} (confidence ${result.confidence.toFixed(2)})`,
    formatSearchResults(evidence),
  ].join("\n\n");
}

async function runOracleTool(oracle: DuckDuckGoOracle, call: ToolCall): Promise<ToolResult> {
  try {
    switch (call.name) {
      case "oracle.search": {
        const query = normalizeStringArg(call.args, "query");
        if (!query) return { name: call.name, output: "", error: "Missing or invalid 'query'." };
        const results = await withTimeout(oracle.search(query), TOOL_TIMEOUT_MS);
        return { name: call.name, output: formatSearchResults(results), raw: results };
      }
      case "oracle.verify": {
        const claim = normalizeStringArg(call.args, "claim");
        if (!claim) return { name: call.name, output: "", error: "Missing or invalid 'claim'." };
        const result = await withTimeout(oracle.verify(claim), TOOL_TIMEOUT_MS);
        return { name: call.name, output: formatVerification(result), raw: result };
      }
      case "oracle.cite": {
        const topic = normalizeStringArg(call.args, "topic");
        if (!topic) return { name: call.name, output: "", error: "Missing or invalid 'topic'." };
        const result = await withTimeout(oracle.cite(topic), TOOL_TIMEOUT_MS);
        return { name: call.name, output: formatCitations(result), raw: result };
      }
      default:
        return { name: call.name, output: "", error: `Unknown tool: ${call.name}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown tool error";
    return { name: call.name, output: "", error: message };
  }
}

function buildToolContextMessages(results: ToolResult[]): ChatMessage[] {
  const messages = results.map((result) => ({
    role: "user" as const,
    content: `Tool result (${result.name}): ${result.error ? `Error: ${result.error}` : result.output}`,
  }));
  if (messages.length > 0) {
    messages.push({
      role: "user" as const,
      content: "Use the tool results above. Only call another tool if strictly necessary.",
    });
  }
  return messages;
}

/**
 * Event types emitted by the council
 */
export type CouncilEvent =
  | { type: "council_started"; state: CouncilState }
  | { type: "turn_started"; agentId: AgentId; turnNumber: number; messageId: string }
  | { type: "message_replace"; agentId: AgentId; messageId: string; content: string }
  | { type: "message_chunk"; agentId: AgentId; messageId: string; content: string }
  | { type: "message_complete"; message: Message }
  | { type: "bidding_complete"; round: BiddingRound }
  | { type: "conflict_updated"; pairs: PairwiseConflict[]; strongestPair: ConflictDetection | null }
  | { type: "whisper_sent"; message: WhisperMessage }
  | { type: "conflict_detected"; conflict: ConflictDetection }
  | { type: "duologue_started"; duoLogue: DuoLogue }
  | { type: "duologue_ended"; duoLogue: DuoLogue }
  | { type: "cost_updated"; costTracker: CostTracker }
  | { type: "oracle_result"; result: OracleResult }
  | { type: "council_paused"; state: CouncilState }
  | { type: "council_completed"; state: CouncilState }
  | { type: "error"; error: Error; agentId?: AgentId };

export type CouncilEventCallback = (event: CouncilEvent) => void;

/**
 * Council class - orchestrates the multi-agent debate
 */
export class Council {
  private state: CouncilState;
  private providerManager: ProviderManager;
  private eventCallback?: CouncilEventCallback;
  private isRunning = false;
  private autoLoopRunning = false;
  private abortController?: AbortController;
  private whisperManager: WhisperManager;
  private conflictDetector: ConflictDetector;
  private fairnessManager: FairnessManager;
  private costTracker: CostTrackerEngine;
  private oracle: DuckDuckGoOracle;
  private topicMessageId: string | null = null;

  constructor(
    credentials: ProviderCredentials,
    config?: Partial<CouncilConfig>,
    agents?: Record<AgentId, AgentConfig>,
    options?: { transport?: Transport }
  ) {
    this.providerManager = new ProviderManager(credentials, { transport: options?.transport });

    const mergedConfig: CouncilConfig = {
      topic: config?.topic ?? "",
      maxTurns: config?.maxTurns ?? DEFAULT_COUNCIL_CONFIG.maxTurns,
      biddingTimeout: config?.biddingTimeout ?? DEFAULT_COUNCIL_CONFIG.biddingTimeout,
      budgetLimit: config?.budgetLimit ?? DEFAULT_COUNCIL_CONFIG.budgetLimit,
      autoMode: config?.autoMode ?? DEFAULT_COUNCIL_CONFIG.autoMode,
    };

    const mergedAgents = agents ?? DEFAULT_AGENTS;

    this.state = {
      id: generateId("council"),
      config: mergedConfig,
      agents: Object.values(mergedAgents),
      messages: [],
      currentTurn: 0,
      totalCost: 0,
      status: "idle",
    };

    const agentIds = this.state.agents.map((agent) => agent.id);
    this.whisperManager = new WhisperManager(agentIds);
    this.conflictDetector = new ConflictDetector();
    this.fairnessManager = new FairnessManager();
    this.costTracker = new CostTrackerEngine(agentIds);
    this.oracle = new DuckDuckGoOracle();

    this.state.costTracker = this.costTracker.getState();
    this.state.whisperState = this.whisperManager.getState();
  }

  /**
   * Set the event callback for receiving council events
   */
  onEvent(callback: CouncilEventCallback): void {
    this.eventCallback = callback;
  }

  /**
   * Emit an event to the callback
   */
  private emit(event: CouncilEvent): void {
    this.eventCallback?.(event);
  }

  /**
   * Get the current state of the council
   */
  getState(): CouncilState {
    return { ...this.state };
  }

  /**
   * Start a new discussion with a topic
   */
  async start(topic: string, options?: { deferAutoStart?: boolean }): Promise<void> {
    if (this.isRunning) {
      throw new Error("Council is already running");
    }

    this.state.config.topic = topic;
    this.state.status = "running";
    this.state.startedAt = Date.now();
    this.state.currentTurn = 0;
    this.state.messages = [];
    this.state.totalCost = 0;
    this.state.conflict = undefined;
    this.state.duoLogue = undefined;
    this.isRunning = true;
    this.abortController = new AbortController();

    const agentIds = this.state.agents.map((agent) => agent.id);
    this.whisperManager = new WhisperManager(agentIds);
    this.fairnessManager = new FairnessManager();
    this.costTracker = new CostTrackerEngine(agentIds);
    this.state.whisperState = this.whisperManager.getState();
    this.state.costTracker = this.costTracker.getState();

    // Add the topic as a system message
    const topicMessage: Message = {
      id: generateId("msg"),
      agentId: "system",
      content: `Discussion Topic: ${topic}`,
      timestamp: Date.now(),
    };
    this.topicMessageId = topicMessage.id;
    this.state.messages.push(topicMessage);
    this.emit({ type: "message_complete", message: topicMessage });

    this.emit({ type: "council_started", state: this.getState() });

    // In auto mode, start the discussion loop
    if (this.state.config.autoMode && !options?.deferAutoStart) {
      await this.runAutoMode();
    }
  }

  /**
   * Begin the auto-mode loop after a deferred start.
   */
  async startAutoMode(): Promise<void> {
    if (!this.isRunning) {
      throw new Error("Council is not running");
    }
    if (!this.state.config.autoMode) {
      throw new Error("Council is not configured for auto mode");
    }
    if (this.autoLoopRunning) return;
    await this.runAutoMode();
  }

  /**
   * Run the council in auto mode
   */
  private async runAutoMode(): Promise<void> {
    if (this.autoLoopRunning) return;
    this.autoLoopRunning = true;
    let lastSpeaker: AgentId | undefined;
    const agentById = new Map(this.state.agents.map((agent) => [agent.id, agent]));
    let aborted = false;

    try {
      while (
        this.isRunning &&
        this.state.currentTurn < this.state.config.maxTurns &&
        this.state.status === "running"
      ) {
        // Run bidding to select next speaker
        const agentIds = this.state.agents.map((a) => a.id);
        const whisperBonuses = this.whisperManager.consumeBonuses();
        this.state.whisperState = this.whisperManager.getState();
        const eligibleAgents =
          this.state.duoLogue && this.state.duoLogue.remainingTurns > 0
            ? this.state.duoLogue.participants
            : agentIds;

        const configuredEligibleAgents = eligibleAgents.filter((agentId) => {
          const agent = agentById.get(agentId);
          if (!agent) return false;
          return Boolean(this.providerManager.getProvider(agent.provider));
        });

        if (configuredEligibleAgents.length === 0) {
          this.emit({
            type: "error",
            error: new Error("No providers configured for any eligible agents."),
          });
          break;
        }

        const biddingResult = runBiddingRound(
          configuredEligibleAgents,
          this.state.messages,
          this.state.config.topic,
          lastSpeaker,
          whisperBonuses
        );

        const fairness = this.fairnessManager.calculateAdjustments(configuredEligibleAgents);
        const fairnessById = new Map(fairness.map((a) => [a.agentId, a.adjustment]));

        const adjustedScores = { ...biddingResult.scores };
        for (const agentId of Object.keys(adjustedScores) as AgentId[]) {
          adjustedScores[agentId] = (adjustedScores[agentId] ?? 0) + (fairnessById.get(agentId) ?? 0);
        }

        let winner = biddingResult.winner;
        let highestScore = -Infinity;
        for (const [agentId, score] of Object.entries(adjustedScores) as [AgentId, number][]) {
          if (score > highestScore) {
            highestScore = score;
            winner = agentId;
          }
        }

        const round: BiddingRound = {
          ...biddingResult,
          winner,
          scores: adjustedScores,
        };

        this.emit({ type: "bidding_complete", round });

        // Get the winning agent to speak
        const agent = agentById.get(round.winner);
        if (!agent) continue;

        const message = await this.generateAgentResponse(agent, round.scores[agent.id]);
        if (message) {
          lastSpeaker = agent.id;
          this.fairnessManager.recordSpeaker(agent.id);
        }
        this.state.currentTurn++;

        if (this.state.duoLogue && this.state.duoLogue.remainingTurns > 0) {
          this.state.duoLogue.remainingTurns -= 1;
          if (this.state.duoLogue.remainingTurns <= 0) {
            const completed = this.state.duoLogue;
            this.state.duoLogue = undefined;
            this.state.conflict = undefined;
            this.emit({ type: "duologue_ended", duoLogue: completed });
          }
        }

        // Small delay between turns for readability
        await this.delay(500);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        aborted = true;
      } else {
        this.emit({ type: "error", error: error as Error });
      }
    } finally {
      this.autoLoopRunning = false;
    }

    if (aborted) return;

    // If we exited auto mode while still "running", we reached a terminal condition
    // (max turns, no eligible providers, or an error). Pauses should not complete.
    if (this.state.status === "running") {
      this.completeCouncil();
    }
  }

  /**
   * Generate a response from a specific agent
   */
  async generateAgentResponse(agent: AgentConfig, bidScore?: number): Promise<Message | null> {
    const provider = this.providerManager.getProvider(agent.provider);
    if (!provider) {
      this.emit({
        type: "error",
        error: new Error(`Provider ${agent.provider} not configured`),
        agentId: agent.id,
      });
      return null;
    }

    const messageId = generateId("msg");

    this.emit({
      type: "turn_started",
      agentId: agent.id,
      turnNumber: this.state.currentTurn + 1,
      messageId,
    });

    let fullContent = "";

    const streamCallback: StreamCallback = (chunk) => {
      if (!chunk.done) {
        fullContent += chunk.content;
        this.emit({
          type: "message_chunk",
          agentId: agent.id,
          messageId,
          content: chunk.content,
        });
      }
    };

    try {
      let toolIteration = 0;
      let modelUsed = agent.model;
      const opusFallbackModel = "claude-opus-4-6";

      const buildPrompt = (extraContext: ChatMessage[] = []) => {
        const context = this.state.messages
          .filter((m) => (this.topicMessageId ? m.id !== this.topicMessageId : true))
          .slice(-MAX_CONTEXT_MESSAGES);
        return [
          ...formatConversationHistory(agent, context, this.state.config.topic),
          ...extraContext,
        ];
      };

      const runCompletion = async (extraContext: ChatMessage[] = []) => {
        fullContent = "";
        this.emit({ type: "message_replace", agentId: agent.id, messageId, content: "" });

        const history = buildPrompt(extraContext);
        const result: CompletionResult = await provider.completeStream(
          agent,
          history,
          streamCallback,
          {
            temperature: agent.temperature,
            maxTokens: agent.maxTokens,
            signal: this.abortController?.signal,
          }
        );

        if (result.tokens) {
          this.updateCost(agent.id, result.tokens, modelUsed);
        }

        return result;
      };

      const runCompletionWithFallback = async (extraContext: ChatMessage[] = []) => {
        try {
          return await runCompletion(extraContext);
        } catch (error) {
          // Model fallback (keep desktop behavior for Anthropic Opus models)
          if (
            agent.provider === "anthropic" &&
            String(agent.model).toLowerCase().includes("opus") &&
            modelUsed !== opusFallbackModel &&
            error instanceof Error &&
            /\b404\b|model|not found/i.test(error.message)
          ) {
            modelUsed = opusFallbackModel as typeof modelUsed;
            agent = { ...agent, model: modelUsed };
            return await runCompletion(extraContext);
          }
          throw error;
        }
      };

      let result = await runCompletionWithFallback();

      while (toolIteration < MAX_TOOL_ITERATIONS) {
        const raw = result.content || fullContent;
        const { cleaned, toolCalls } = extractToolCalls(raw);
        if (toolCalls.length === 0) break;

        const interim = cleaned || "Checking sources…";
        this.emit({ type: "message_replace", agentId: agent.id, messageId, content: interim });

        const calls = toolCalls.slice(0, MAX_TOOL_CALLS_PER_ITERATION);
        const toolResults = await Promise.all(calls.map((call) => runOracleTool(this.oracle, call)));

        for (const toolResult of toolResults) {
          const toolMessage: Message = {
            id: generateId("tool"),
            agentId: "tool",
            content: `Tool result (${toolResult.name}): ${
              toolResult.error ? `Error: ${toolResult.error}` : toolResult.output
            }`,
            timestamp: Date.now(),
          };
          this.state.messages.push(toolMessage);
          this.emit({ type: "message_complete", message: toolMessage });
        }

        const extraContext = buildToolContextMessages(toolResults);
        result = await runCompletionWithFallback(extraContext);
        toolIteration += 1;
      }

      const rawFinal = result.content || fullContent;
      const { cleaned: finalCleaned } = extractToolCalls(rawFinal);
      const displayContent = finalCleaned || normalizeMessageText(rawFinal || "") || "[No response received]";

      const message: Message = {
        id: messageId,
        agentId: agent.id,
        content: displayContent,
        timestamp: Date.now(),
        tokens: result.tokens,
        metadata: {
          model: modelUsed,
          latencyMs: result.latencyMs,
          bidScore,
        },
      };

      this.state.messages.push(message);
      this.evaluateConflict();
      this.emit({ type: "message_complete", message });

      return message;
    } catch (error) {
      this.emit({ type: "error", error: error as Error, agentId: agent.id });
      return null;
    }
  }

  /**
   * Manually trigger a specific agent to speak (for non-auto mode)
   */
  async triggerAgent(agentId: AgentId): Promise<Message | null> {
    const agent = this.state.agents.find((a) => a.id === agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not found`);
    }

    return this.generateAgentResponse(agent);
  }

  /**
   * Add a user message to the conversation
   */
  addUserMessage(content: string): Message {
    const message: Message = {
      id: generateId("msg"),
      agentId: "user",
      content,
      timestamp: Date.now(),
    };

    this.state.messages.push(message);
    this.emit({ type: "message_complete", message });
    return message;
  }

  /**
   * Add an external message (e.g., moderator/system message) to the conversation.
   */
  addExternalMessage(message: Omit<Message, "id"> & { id?: string }): Message {
    const full: Message = {
      id: message.id ?? generateId("msg"),
      agentId: message.agentId,
      content: message.content,
      timestamp: message.timestamp,
      tokens: message.tokens,
      metadata: message.metadata,
    };
    this.state.messages.push(full);
    this.emit({ type: "message_complete", message: full });
    return full;
  }

  private updateCost(agentId: AgentId, tokens: CompletionResult["tokens"], modelId: string): void {
    if (!tokens) return;
    this.costTracker.recordUsage(agentId, tokens, modelId);
    this.state.costTracker = this.costTracker.getState();
    this.state.totalCost = this.state.costTracker.totalEstimatedUSD;
    this.emit({ type: "cost_updated", costTracker: this.state.costTracker });
  }

  private evaluateConflict(): void {
    const agentIds = this.state.agents.map((agent) => agent.id);
    const { pairs, strongestPair } = this.conflictDetector.evaluateAll(this.state.messages, agentIds);
    this.emit({ type: "conflict_updated", pairs, strongestPair });

    if (this.state.duoLogue && this.state.duoLogue.remainingTurns > 0) return;

    const conflict = strongestPair;
    this.state.conflict = conflict ?? undefined;

    if (conflict) {
      const duoLogue: DuoLogue = {
        participants: conflict.agentPair,
        remainingTurns: 3,
        otherAgentsBidding: false,
      };
      this.state.duoLogue = duoLogue;
      this.emit({ type: "conflict_detected", conflict });
      this.emit({ type: "duologue_started", duoLogue });
    }
  }

  /**
   * Send a whisper between agents (adds optional bid bonus)
   */
  sendWhisper(
    from: AgentId,
    to: AgentId,
    message: Omit<WhisperMessage, "id" | "from" | "to" | "timestamp">
  ): WhisperMessage {
    const whisper = this.whisperManager.sendWhisper(from, to, message);
    this.state.whisperState = this.whisperManager.getState();
    this.emit({ type: "whisper_sent", message: whisper });
    return whisper;
  }

  /**
   * Query the oracle tool for external verification
   */
  async queryOracle(query: string): Promise<OracleResult> {
    const result = await this.oracle.query(query);
    this.emit({ type: "oracle_result", result });
    return result;
  }

  /**
   * Pause the council
   */
  pause(): void {
    if (this.state.status === "running") {
      this.state.status = "paused";
      this.emit({ type: "council_paused", state: this.getState() });
    }
  }

  /**
   * Resume the council
   */
  async resume(): Promise<void> {
    if (this.state.status === "paused") {
      this.state.status = "running";
      if (this.state.config.autoMode) {
        await this.runAutoMode();
      }
    }
  }

  /**
   * Stop the council
   */
  stop(): void {
    this.isRunning = false;
    this.abortController?.abort();
    this.completeCouncil();
  }

  /**
   * Complete the council session
   */
  private completeCouncil(): void {
    this.state.status = "completed";
    this.state.completedAt = Date.now();
    this.isRunning = false;
    this.emit({ type: "council_completed", state: this.getState() });
  }

  /**
   * Update an agent's configuration
   */
  updateAgent(agentId: AgentId, updates: Partial<AgentConfig>): void {
    const agentIndex = this.state.agents.findIndex((a) => a.id === agentId);
    if (agentIndex === -1) {
      throw new Error(`Agent ${agentId} not found`);
    }

    this.state.agents[agentIndex] = {
      ...this.state.agents[agentIndex]!,
      ...updates,
    };
  }

  /**
   * Update provider credentials
   */
  updateCredentials(credentials: Partial<ProviderCredentials>): void {
    for (const [provider, cred] of Object.entries(credentials)) {
      if (cred?.apiKey) {
        this.providerManager.setProvider(
          provider as AgentConfig["provider"],
          cred.apiKey,
          cred.baseUrl
        );
      }
    }
  }

  /**
   * Helper to create a delay
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get conversation transcript
   */
  getTranscript(): string {
    return this.state.messages
      .map((m) => {
        const speaker = m.agentId === "system" ? "SYSTEM" : m.agentId.toUpperCase();
        return `[${speaker}]: ${m.content}`;
      })
      .join("\n\n");
  }

  /**
   * Export state for persistence
   */
  exportState(): string {
    return JSON.stringify(this.state, null, 2);
  }

  /**
   * Import state from persistence
   */
  importState(stateJson: string): void {
    const imported = JSON.parse(stateJson) as CouncilState;
    this.state = imported;

    const agentIds = this.state.agents.map((agent) => agent.id);
    this.whisperManager = new WhisperManager(agentIds);
    if (this.state.whisperState) {
      this.whisperManager.loadState(this.state.whisperState);
    }

    this.costTracker = new CostTrackerEngine(agentIds);
    if (this.state.costTracker) {
      this.costTracker.loadState(this.state.costTracker);
    }
  }
}
