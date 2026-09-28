import type { JudgeTrace } from "../../domain/finding.js";
import type { Guideline } from "../../domain/guideline.js";
import type { JevPort, JevReply, JevRequest } from "../../model/jev.js";
import { quotesGuideline } from "../parse.js";
import type { Candidate } from "./detect.js";
import { findingOf, where, type JudgedCandidate } from "./judge.js";
import { sentenceOf } from "./rules.js";

/** The typed decision Jev returns for one candidate. */
export interface JevDecision {
  keep: boolean;
  confidence: number;
  quotedSentence: string;
  /** The listed comment a drop rests on; absent when none settles it. */
  comment?: string;
}

/** A Choice holds at most 255 options. */
const MAX_OPTIONS = 255;
const NONE = "none";
// Shorter fragments, such as a lone heading word, name no rule the judge could pick.
const MIN_SENTENCE_CHARS = 12;
// One retry rides out a dropped connection, as the model judge allows.
const JEV_ATTEMPTS = 2;

/** The guideline's own sentences, code examples left out, the check's rule first. */
export function guidelineSentences(guideline: Guideline, rule: string): string[] {
  const prose = guideline.body.replace(/```[\s\S]*?```/g, " ");
  const found = [guideline.title, ...prose.split(/(?<=[.!?])\s+|\n+/)]
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= MIN_SENTENCE_CHARS && !/^good:|^bad:/i.test(sentence));
  return [...new Set([rule, ...found])].slice(0, MAX_OPTIONS);
}

/** One request: the verdict, the sentence it rests on, and the comment that settles a drop. */
export function jevJudgeRequest(
  candidate: Candidate,
  guideline: Guideline,
  excerpt: string,
  sentences: readonly string[],
): JevRequest {
  const comments = candidate.judge?.comments ?? [];
  const request: JevRequest = {
    state: {
      guideline: { id: guideline.id, title: guideline.title, text: guideline.body },
      flagged: {
        file: candidate.file,
        line: candidate.line,
        measured: candidate.title,
      },
      code: excerpt,
      comments: comments.map((comment) => ({ line: comment.line, text: comment.text })),
    },
    questions: {
      verdict: {
        type: "choice",
        instructions: {
          task: "A static check flagged the line marked >> in `code` under `guideline`. What `flagged.measured` says is a measured fact. Does the flagged line break the guideline?",
          question: candidate.judge?.question ?? "",
        },
        criteria: {
          keep: "The guideline's words forbid the flagged code and no entry in `comments` settles the question.",
          drop: "An entry in `comments` settles the question, so the flagged code does not break the guideline.",
        },
      },
      quote: {
        type: "choice",
        instructions:
          "Which sentence of `guideline` does the decision on the flagged line rest on?",
        criteria: Object.fromEntries(
          sentences.map((sentence, index) => [`s${String(index)}`, sentence]),
        ),
      },
    },
  };
  if (comments.length > 0) {
    request.questions["comment"] = {
      type: "choice",
      instructions: {
        task: "Which entry in `comments` settles the question for the flagged line, if any?",
        question: candidate.judge?.question ?? "",
      },
      criteria: {
        [NONE]: "No listed comment settles it.",
        ...Object.fromEntries(
          comments
            .slice(0, MAX_OPTIONS - 1)
            .map((comment, index) => [`c${String(index)}`, comment.text]),
        ),
      },
    };
  }
  return request;
}

/** Reads the typed answers back into a decision; a missing answer throws. */
export function decisionOf(
  reply: JevReply,
  sentences: readonly string[],
  comments: readonly { text: string }[],
): JevDecision {
  const verdict = reply.answers["verdict"];
  const quote = reply.answers["quote"];
  if (verdict === undefined || quote === undefined)
    throw new Error("jev left a question unanswered");
  const sentence = sentences[Number(quote.choice.slice(1))] ?? "";
  const picked = reply.answers["comment"]?.choice;
  const comment =
    picked !== undefined && picked !== NONE ? comments[Number(picked.slice(1))]?.text : undefined;
  return {
    keep: verdict.choice !== "drop",
    confidence: verdict.confidence,
    quotedSentence: sentence,
    ...(comment !== undefined ? { comment } : {}),
  };
}

/** Settles a candidate on Jev: under the confidence floor it drops, a drop needs a guideline sentence and a listed comment. */
export async function settleWithJev(
  jev: JevPort,
  candidate: Candidate,
  guideline: Guideline,
  excerpt: string,
  minConfidence: number,
): Promise<JudgedCandidate> {
  const rule = sentenceOf(candidate.check, candidate.shape);
  const comments = candidate.judge?.comments ?? [];
  const sentences = guidelineSentences(guideline, rule);
  const request = jevJudgeRequest(candidate, guideline, excerpt, sentences);
  let failure = "";
  let latencyMs = 0;
  for (let attempt = 0; attempt < JEV_ATTEMPTS; attempt += 1) {
    let reply: JevReply;
    let decision: JevDecision;
    try {
      reply = await jev.decide(request);
      decision = decisionOf(reply, sentences, comments);
    } catch (error) {
      failure = (error as Error).message.replace(/\n[\s\S]*/, "");
      continue;
    }
    latencyMs += reply.latencyMs;
    const judged: JudgeTrace = { provider: "jev", latencyMs, confidence: decision.confidence };
    const spent = { jevUsage: reply.usage, judged };
    const sure = decision.confidence.toFixed(2);
    if (decision.confidence < minConfidence) {
      return {
        outcome: "dropped",
        rejected: {
          reason: "judge-low-confidence",
          raw: JSON.stringify({
            file: candidate.file,
            line: candidate.line,
            keep: decision.keep,
            confidence: decision.confidence,
          }),
          guidelineId: guideline.id,
          title: candidate.title,
        },
        notice: `check: ${where(candidate)}: dropped, the judge (jev) is ${sure} sure, under judge.minConfidence ${String(minConfidence)}`,
        ...spent,
      };
    }
    if (!decision.keep) {
      if (quotesGuideline(decision.quotedSentence, guideline) && decision.comment !== undefined) {
        return {
          outcome: "dropped",
          rejected: {
            reason: "judge-drop",
            raw: JSON.stringify({
              file: candidate.file,
              line: candidate.line,
              comment: decision.comment,
            }),
            guidelineId: guideline.id,
            title: candidate.title,
          },
          notice: `check: ${where(candidate)}: dropped at ${sure}, the judge (jev) cites "${decision.comment}"`,
          ...spent,
        };
      }
      // the confidence is the drop's, not the finding's
      return {
        outcome: "finding",
        finding: { ...findingOf(candidate, guideline, rule, undefined, judged), confidence: 1 },
        notice: `check: ${where(candidate)}: finding, the judge's (jev) drop cites no listed comment or guideline sentence`,
        ...spent,
      };
    }
    return {
      outcome: "finding",
      finding: findingOf(candidate, guideline, rule, undefined, judged),
      notice: `check: ${where(candidate)}: finding, confirmed by the judge (jev) at ${sure}`,
      ...spent,
    };
  }
  return {
    outcome: "failed",
    rejected: {
      reason: "judge-failed",
      raw: where(candidate),
      guidelineId: guideline.id,
      title: candidate.title,
    },
    notice: `check: ${where(candidate)}: judge (jev) failed twice (${failure}); no finding`,
  };
}
