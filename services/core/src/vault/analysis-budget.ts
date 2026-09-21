import type { AnalysisTranscriptSegment } from "./transcript-analysis";

/**
 * This is deliberately a conservative planning budget, not a provider context
 * window claim. It leaves room for the existing 3,000-token pipeline response.
 */
export const DEFAULT_ANALYSIS_INPUT_BUDGET_TOKENS = 12_000;
export const DEFAULT_ANALYSIS_OUTPUT_RESERVATION_TOKENS = 3_000;

/**
 * Estimate tokens without selecting a provider-specific tokenizer. ASCII text
 * is budgeted at four characters per token; non-ASCII code points are budgeted
 * at one token each. This intentionally overestimates ordinary prose and keeps
 * captions in scripts such as CJK and text containing emoji from being treated
 * as cheap ASCII.
 */
export function estimateAnalysisTokens(text: string): number {
  let units = 0;
  for (const character of text) {
    units += (character.codePointAt(0) ?? 0) <= 0x7f ? 0.25 : 1;
  }
  return Math.ceil(units);
}

export class AnalysisBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AnalysisBudgetError";
  }
}

export type AnalysisBudgetOptions = {
  budgetTokens: number;
  outputReservationTokens?: number;
  promptOverheadTokens?: number;
};

export type ValidatedAnalysisBudget = {
  budgetTokens: number;
  outputReservationTokens: number;
  promptOverheadTokens: number;
  sourceTokens: number;
};

function positiveInteger(value: number, name: string, allowZero = false): number {
  if (!Number.isInteger(value) || !Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new AnalysisBudgetError(`${name} must be ${allowZero ? "a non-negative" : "a positive"} integer; received ${String(value)}`);
  }
  return value;
}

export function validateAnalysisBudget(options: AnalysisBudgetOptions): ValidatedAnalysisBudget {
  const budgetTokens = positiveInteger(options.budgetTokens, "analysis budget");
  const outputReservationTokens = positiveInteger(options.outputReservationTokens ?? DEFAULT_ANALYSIS_OUTPUT_RESERVATION_TOKENS, "output reservation");
  const promptOverheadTokens = positiveInteger(options.promptOverheadTokens ?? 0, "prompt overhead", true);
  const sourceTokens = budgetTokens - outputReservationTokens - promptOverheadTokens;
  if (sourceTokens < 1) {
    throw new AnalysisBudgetError(
      `analysis budget is insufficient: ${budgetTokens} tokens minus ${promptOverheadTokens} prompt-overhead tokens and ${outputReservationTokens} output-reservation tokens leaves ${sourceTokens} source tokens; increase the configured budget or reduce the prompt/output reservation`,
    );
  }
  return { budgetTokens, outputReservationTokens, promptOverheadTokens, sourceTokens };
}

export type AnalysisSourceSegment = Pick<AnalysisTranscriptSegment, "source_segment_id" | "text" | "start_seconds" | "duration_seconds">;

export type PlannedAnalysisChunk = {
  index: number;
  text: string;
  segments: AnalysisSourceSegment[];
  estimatedSourceTokens: number;
  estimatedInputTokens: number;
  estimatedTotalTokens: number;
};

export type AnalysisChunkPlan = {
  chunks: PlannedAnalysisChunk[];
  source_segment_count: number;
  source_piece_count: number;
  covered_source_segment_ids: string[];
  complete: true;
  budget: ValidatedAnalysisBudget;
};

function sourceEstimate(segments: readonly AnalysisSourceSegment[]): number {
  return estimateAnalysisTokens(segments.map((segment) => segment.text).join("\n\n"));
}

function chunkFromSegments(index: number, segments: AnalysisSourceSegment[], budget: ValidatedAnalysisBudget): PlannedAnalysisChunk {
  const text = segments.map((segment) => segment.text).join("\n\n");
  const estimatedSourceTokens = estimateAnalysisTokens(text);
  const estimatedInputTokens = budget.promptOverheadTokens + estimatedSourceTokens;
  return {
    index,
    text,
    segments,
    estimatedSourceTokens,
    estimatedInputTokens,
    estimatedTotalTokens: estimatedInputTokens + budget.outputReservationTokens,
  };
}

function splitSegment(segment: AnalysisSourceSegment, budget: ValidatedAnalysisBudget): AnalysisSourceSegment[] {
  if (estimateAnalysisTokens(segment.text) <= budget.sourceTokens) return [segment];
  const characters = [...segment.text];
  const pieces: AnalysisSourceSegment[] = [];
  let offset = 0;
  while (offset < characters.length) {
    let low = 1;
    let high = characters.length - offset;
    let best = 0;
    while (low <= high) {
      const length = Math.floor((low + high) / 2);
      const candidate = characters.slice(offset, offset + length).join("");
      if (estimateAnalysisTokens(candidate) <= budget.sourceTokens) {
        best = length;
        low = length + 1;
      } else {
        high = length - 1;
      }
    }
    if (best === 0) {
      throw new AnalysisBudgetError(
        `analysis budget cannot fit source segment ${segment.source_segment_id}: it leaves ${budget.sourceTokens} source tokens per request`,
      );
    }
    pieces.push({
      source_segment_id: segment.source_segment_id,
      text: characters.slice(offset, offset + best).join(""),
      ...(segment.start_seconds === undefined ? {} : { start_seconds: segment.start_seconds }),
      ...(segment.duration_seconds === undefined ? {} : { duration_seconds: segment.duration_seconds }),
    });
    offset += best;
  }
  return pieces;
}

/** Plan every retained segment in order, splitting a caption only when needed. */
export function planAnalysisChunks(
  segments: readonly AnalysisSourceSegment[],
  options: AnalysisBudgetOptions,
): AnalysisChunkPlan {
  const budget = validateAnalysisBudget(options);
  const pieces = segments.flatMap((segment) => splitSegment(segment, budget));
  const chunks: PlannedAnalysisChunk[] = [];
  let current: AnalysisSourceSegment[] = [];
  for (const piece of pieces) {
    const candidate = [...current, piece];
    if (current.length > 0 && sourceEstimate(candidate) > budget.sourceTokens) {
      chunks.push(chunkFromSegments(chunks.length, current, budget));
      current = [piece];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) chunks.push(chunkFromSegments(chunks.length, current, budget));
  const covered = [...new Set(pieces.map((piece) => piece.source_segment_id))];
  return {
    chunks,
    source_segment_count: segments.length,
    source_piece_count: pieces.length,
    covered_source_segment_ids: covered,
    complete: true,
    budget,
  };
}

export type AnalysisNote = {
  text: string;
  source_segment_ids: readonly string[];
  estimated_source_tokens?: number;
};

export type ReductionBatch = {
  index: number;
  note_indexes: number[];
  source_segment_ids: string[];
  estimatedSourceTokens: number;
  estimatedInputTokens: number;
  estimatedTotalTokens: number;
};

export type ReductionLevel = {
  input_note_count: number;
  output_note_count: number;
  batches: ReductionBatch[];
};

export type AnalysisReductionPlan = {
  levels: ReductionLevel[];
  final_note_count: number;
  final_estimated_input_tokens: number;
  budget: ValidatedAnalysisBudget;
};

export type AnalysisReductionOptions = AnalysisBudgetOptions & {
  maxLevels?: number;
  /** Reserve less output for intermediate notes while retaining the final-call reservation. */
  intermediateOutputReservationTokens?: number;
};

type WorkingNote = AnalysisNote & { estimated_source_tokens: number };

function noteEstimate(note: AnalysisNote): number {
  return note.estimated_source_tokens ?? estimateAnalysisTokens(note.text);
}

function joinedNoteEstimate(notes: readonly WorkingNote[]): number {
  if (notes.some((note) => note.text !== "")) return estimateAnalysisTokens(notes.map((note) => note.text).join("\n\n"));
  return notes.reduce((total, note, index) => total + note.estimated_source_tokens + (index === 0 ? 0 : 1), 0);
}

function reductionBatch(index: number, indexes: number[], notes: readonly WorkingNote[], budget: ValidatedAnalysisBudget): ReductionBatch {
  const selected = indexes.map((noteIndex) => notes[noteIndex]).filter((note): note is WorkingNote => note !== undefined);
  const estimatedSourceTokens = joinedNoteEstimate(selected);
  const sourceSegmentIds = [...new Set(selected.flatMap((note) => note.source_segment_ids))];
  return {
    index,
    note_indexes: indexes,
    source_segment_ids: sourceSegmentIds,
    estimatedSourceTokens,
    estimatedInputTokens: budget.promptOverheadTokens + estimatedSourceTokens,
    estimatedTotalTokens: budget.promptOverheadTokens + estimatedSourceTokens + budget.outputReservationTokens,
  };
}

/**
 * Build adjacent map/reduction levels until the ordered notes fit one final
 * synthesis call. Each reduction output is reserved at the configured output
 * size, so the plan never relies on an optimistic provider response length.
 */
export function planAdjacentReduction(
  notes: readonly AnalysisNote[],
  options: AnalysisReductionOptions,
): AnalysisReductionPlan {
  const budget = validateAnalysisBudget(options);
  const intermediateOutputReservationTokens = options.intermediateOutputReservationTokens ?? budget.outputReservationTokens;
  if (!Number.isInteger(intermediateOutputReservationTokens) || intermediateOutputReservationTokens <= 0) {
    throw new AnalysisBudgetError(`intermediate output reservation must be a positive integer; received ${String(intermediateOutputReservationTokens)}`);
  }
  const working: WorkingNote[] = notes.map((note, index) => {
    const estimated = noteEstimate(note);
    if (estimated > budget.sourceTokens) {
      throw new AnalysisBudgetError(`reduction note ${index} exceeds the available source budget: ${estimated} > ${budget.sourceTokens} tokens`);
    }
    return { ...note, estimated_source_tokens: estimated };
  });
  const levels: ReductionLevel[] = [];
  let current = working;
  const maxLevels = options.maxLevels ?? 32;
  for (let level = 0; ; level += 1) {
    const finalSourceTokens = joinedNoteEstimate(current);
    if (budget.promptOverheadTokens + finalSourceTokens + budget.outputReservationTokens <= budget.budgetTokens) {
      return {
        levels,
        final_note_count: current.length,
        final_estimated_input_tokens: budget.promptOverheadTokens + finalSourceTokens,
        budget,
      };
    }
    if (current.length < 2) {
      throw new AnalysisBudgetError("reduction cannot make progress: one note still exceeds the final synthesis budget");
    }
    if (level >= maxLevels) {
      throw new AnalysisBudgetError(`reduction exceeded the maximum of ${maxLevels} levels without fitting the final synthesis budget`);
    }
    const batches: ReductionBatch[] = [];
    let indexes: number[] = [];
    for (let index = 0; index < current.length; index += 1) {
      const candidate = [...indexes, index];
      const candidateBatch = reductionBatch(batches.length, candidate, current, budget);
      if (indexes.length > 0 && candidateBatch.estimatedSourceTokens > budget.sourceTokens) {
        batches.push(reductionBatch(batches.length, indexes, current, budget));
        indexes = [index];
      } else {
        indexes = candidate;
      }
    }
    if (indexes.length > 0) batches.push(reductionBatch(batches.length, indexes, current, budget));
    if (batches.length >= current.length) {
      throw new AnalysisBudgetError("reduction cannot make progress: no adjacent notes can be combined within the configured budget");
    }
    levels.push({ input_note_count: current.length, output_note_count: batches.length, batches });
    current = batches.map((batch) => ({
      text: "",
      source_segment_ids: batch.source_segment_ids,
      estimated_source_tokens: intermediateOutputReservationTokens,
    }));
  }
}
