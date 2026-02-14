/**
 * @fileoverview Bidding engine for agent turn selection
 * Implements a weighted bidding system where agents compete to speak
 */

import type { AgentId, Bid, BiddingRound, Message } from "@socratic-council/shared";
import { BIDDING_WEIGHTS } from "@socratic-council/shared";

/**
 * Generate a unique ID for bidding rounds
 */
function generateBiddingRoundId(): string {
  return `bid_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Calculate the final score for a bid
 */
export function calculateBidScore(bid: Bid): number {
  const { urgency, relevance, confidence, whisperBonus } = BIDDING_WEIGHTS;
  const randomBonus = Math.random() * BIDDING_WEIGHTS.randomMax;

  return (
    bid.urgency * urgency +
    bid.relevance * relevance +
    bid.confidence * confidence +
    bid.whisperBonus * whisperBonus +
    randomBonus
  );
}

/**
 * Analyze conversation context to generate bid parameters for an agent
 */
export function analyzeBidContext(
  agentId: AgentId,
  messages: Message[],
  topic: string
): Omit<Bid, "timestamp"> {
  // Calculate urgency based on how long since this agent spoke
  const lastSpokeIndex = messages.findLastIndex((m) => m.agentId === agentId);
  const messagesSinceSpoke = lastSpokeIndex === -1 ? messages.length : messages.length - lastSpokeIndex - 1;
  const urgency = Math.min(100, 20 + messagesSinceSpoke * 15);

  // Calculate relevance based on recent mentions or direct questions
  const recentMessages = messages.slice(-5);
  const mentionCount = recentMessages.filter(
    (m) => m.content.toLowerCase().includes(agentId.toLowerCase())
  ).length;
  const relevance = Math.min(100, 30 + mentionCount * 20 + Math.random() * 30);

  // Confidence is intentionally not role-based. Instead, we use lightweight,
  // topic-agnostic signals + a bit of randomness to keep turn-taking dynamic.
  const seed = `${agentId}:${topic}`.toLowerCase();
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const stableJitter = (hash % 1000) / 1000; // 0..~1, stable per (agent, topic)
  const recentHasQuestion = recentMessages.some((m) => m.content.includes("?"));
  const confidence = Math.min(
    100,
    45 +
      (recentHasQuestion ? 8 : 0) +
      mentionCount * 12 +
      stableJitter * 15 +
      Math.random() * 15
  );

  // Whisper bonus - can be used for user hints (not implemented yet)
  const whisperBonus = 0;

  return {
    agentId,
    urgency,
    relevance,
    confidence,
    whisperBonus,
  };
}

/**
 * Run a bidding round and determine the winner
 */
export function runBiddingRound(
  agentIds: AgentId[],
  messages: Message[],
  topic: string,
  excludeAgent?: AgentId,
  whisperBonuses: Partial<Record<AgentId, number>> = {}
): BiddingRound {
  const roundId = generateBiddingRoundId();
  const bids: Bid[] = [];
  const scores: Record<string, number> = {};

  // Collect bids from all eligible agents
  for (const agentId of agentIds) {
    // Skip excluded agent (e.g., the one who just spoke)
    if (agentId === excludeAgent) {
      scores[agentId] = 0;
      continue;
    }

    const bidParams = analyzeBidContext(agentId, messages, topic);
    const bid: Bid = {
      ...bidParams,
      whisperBonus: Math.min(20, Math.max(0, whisperBonuses[agentId] ?? 0)),
      timestamp: Date.now(),
    };
    bids.push(bid);

    const score = calculateBidScore(bid);
    scores[agentId] = score;
  }

  // Find the winner (highest score)
  let winner: AgentId = agentIds[0]!;
  let highestScore = -1;

  for (const [agentId, score] of Object.entries(scores)) {
    if (score > highestScore) {
      highestScore = score;
      winner = agentId as AgentId;
    }
  }

  return {
    roundId,
    bids,
    winner,
    scores: scores as Record<AgentId, number>,
  };
}

/**
 * Apply a whisper bonus to a specific agent's next bid
 */
export function createWhisperBid(
  agentId: AgentId,
  bonus: number,
  messages: Message[],
  topic: string
): Bid {
  const bidParams = analyzeBidContext(agentId, messages, topic);
  return {
    ...bidParams,
    whisperBonus: Math.min(20, Math.max(0, bonus)),
    timestamp: Date.now(),
  };
}
