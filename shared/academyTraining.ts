import { z } from 'zod'
import { localModelIdSchema } from './localAI'
export const trainingSettingsSchema = z.object({ iterations: z.number().int().min(10).max(500).default(100), learningRate: z.number().min(0.000001).max(0.001).default(0.00001), batchSize: z.number().int().min(1).max(2).default(1), rank: z.number().int().min(4).max(32).default(8), checkpointEvery: z.number().int().min(5).max(100).default(25) }).strict()
export type TrainingSettings = z.infer<typeof trainingSettingsSchema>
export const defaultTrainingSettings = trainingSettingsSchema.parse({})

export const trainingCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('activate-adapter'), model: localModelIdSchema, jobId: z.string().uuid(), adapter: z.string().regex(/^[\w.-]+\.safetensors$/) }).strict(),
  z.object({ action: z.literal('rollback-model'), model: localModelIdSchema }).strict(),
  z.object({ action: z.literal('configure'), model: localModelIdSchema, settings: trainingSettingsSchema }).strict(),
  z.object({ action: z.literal('export-adapter'), model: localModelIdSchema, jobId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('install-runtime') }).strict(),
  z.object({ action: z.literal('checkpoint-local'), model: localModelIdSchema }).strict(),
  z.object({ action: z.literal('checkpoint-download'), model: localModelIdSchema, repository: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/).max(160) }).strict(),
  z.object({ action: z.literal('dataset-mode'), model: localModelIdSchema, mode: z.enum(['automatic', 'manual']) }).strict(),
  z.object({ action: z.literal('dataset-split-import'), model: localModelIdSchema, split: z.enum(['train', 'valid', 'test']), fileName: z.string().min(1).max(255), content: z.string().max(20 * 1024 * 1024) }).strict(),
  z.object({ action: z.literal('dataset'), model: localModelIdSchema }).strict(),
  z.object({ action: z.literal('dataset-import'), model: localModelIdSchema, fileName: z.string().min(1).max(255), content: z.string().max(20 * 1024 * 1024) }).strict(),
  z.object({ action: z.literal('train'), model: localModelIdSchema, iterations: z.number().int().min(10).max(500).default(100) }).strict(),
  z.object({ action: z.literal('resume'), model: localModelIdSchema, jobId: z.string().uuid(), iterations: z.number().int().min(10).max(500).default(100) }).strict(),
  z.object({ action: z.literal('cancel') }).strict(),
  z.object({ action: z.literal('evaluate'), model: localModelIdSchema, jobId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('evaluation-import'), model: localModelIdSchema, fileName: z.string().min(1).max(255), content: z.string().max(8 * 1024 * 1024) }).strict(),
  z.object({ action: z.literal('compare'), model: localModelIdSchema, jobId: z.string().uuid() }).strict(),
  z.object({ action: z.literal('review-example'), model: localModelIdSchema, comparisonId: z.string().uuid(), exampleId: z.string().min(1).max(40), variantId: z.string().min(1).max(160), decision: z.enum(['pass', 'fail', 'needs-review', 'reset']), note: z.string().max(1000).default('') }).strict(),
  z.object({ action: z.literal('select-adapter'), model: localModelIdSchema, jobId: z.string().uuid(), adapter: z.string().regex(/^[\w.-]+\.safetensors$/) }).strict(),
])
export type TrainingCommand = z.infer<typeof trainingCommandSchema>
export type TrainingStage = 'idle' | 'installing' | 'downloading' | 'training' | 'evaluating' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
export type DatasetMode = 'automatic' | 'manual'
export type DatasetSplit = 'train' | 'valid' | 'test'
export interface DatasetFile { name: string; count: number; hash: string; sourceHash: string; importedAt: string; status: 'valid'; origin: 'imported' | 'automatic-split' }
export interface DatasetSelection { id: string; files: Partial<Record<DatasetSplit, DatasetFile>>; warnings: string[] }
export interface DatasetProvenance { mode: DatasetMode; id: string; files: Record<DatasetSplit, DatasetFile>; warnings: string[] }
export interface TrainingJob {
  id: string; model: string; modelDigest: string; checkpointId: string; datasetId: string;
  datasetProvenance?: DatasetProvenance; datasetIntegrityError?: string;
  stage: TrainingStage; startedAt: string; finishedAt?: string; iteration: number; iterations: number;
  adapterFiles: string[]; selectedAdapter?: string; validationLoss?: number; testLoss?: number; error?: string; settings?: TrainingSettings; trainingLoss?: number; peakMemoryGB?: number
}
export interface TrainingProfile {
  model: string; modelDigest: string; checkpointPath?: string; checkpointId?: string; checkpointLabel?: string;
  checkpointFamily?: string; checkpointQuantized?: boolean; datasetId?: string; datasetName?: string;
  datasetCounts?: { train: number; valid: number; test: number }; selectedJobId?: string; selectedAdapter?: string;
  evaluationDataset?: { id: string; name: string; count: number; counts: Record<EvaluationTrack, number>; digest: string }
  settings?: TrainingSettings
  datasetMode?: DatasetMode; datasetSelections?: Partial<Record<DatasetMode, DatasetSelection>>
}
export type EvaluationTrack = 'coding' | 'git' | 'jira'
export interface EvaluationCodeCase { name: string; args: unknown[]; expected: unknown }
export interface EvaluationJudgement { status: 'pass' | 'fail' | 'needs-review'; reason: string; cases?: Array<{ name: string; passed: boolean; detail: string }> }
export interface EvaluationReview { decision: 'pass' | 'fail' | 'needs-review'; note: string; reviewedAt: string }
export interface EvaluationExample {
  id: string; track: EvaluationTrack; prompt: string; expected: string[]; language?: 'javascript'; tests?: EvaluationCodeCase[]; required?: string[]; forbidden?: string[];
  answers: Record<string, string>; correct: Record<string, boolean>; judgements?: Record<string, EvaluationJudgement>; reviews?: Record<string, EvaluationReview>
}
export interface EvaluationVariant { id: string; label: string; validationLoss: number; testLoss?: number; taskScores: Record<EvaluationTrack, { correct: number; total: number; rate: number; low: number; high: number; needsReview?: number }> }
export interface EvaluationComparison {
  id: string; jobId: string; model: string; modelDigest?: string; createdAt: string; trainingDatasetId: string; evaluationDatasetId?: string; evaluationDatasetDigest?: string;
  selectionBasis?: 'validation';
  settings: { maxSequenceLength: number; maxOutputTokens: number; batchSize: number; scoring: string; tokenizerCheckpointId: string };
  variants: EvaluationVariant[]; examples: EvaluationExample[]; recommendation?: string; warnings: string[]
}
export interface TrainingRuntime { ready: boolean; pythonVersion?: string; mlxVersion?: string; mlxLmVersion?: string; metalAvailable: boolean; architectures?: string[]; message: string }
export interface TrainingSnapshot { mlxModels?: import('./mlxInference').MLXModelRegistration[]; mlxDiagnostics?: import('./mlxInference').MLXDiagnostic[]; runtime: TrainingRuntime; profiles: TrainingProfile[]; jobs: TrainingJob[]; comparisons: EvaluationComparison[]; active?: { model: string; stage: TrainingStage; iteration: number; iterations: number; message: string } }
export interface TrainingResult { ok: boolean; snapshot: TrainingSnapshot; message?: string }
export interface TrainingProgress { model: string; stage: TrainingStage; iteration: number; iterations: number; message: string; trainingLoss?: number; validationLoss?: number; peakMemoryGB?: number }

/** Candidate architectures only; a selected checkpoint must still be validated independently. */
export function mlxFamilyCandidate(family?: string, architectures?: string[]): boolean {
  const key = (family ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!key) return false
  if (architectures?.length) return architectures.some(name => name.toLowerCase().replace(/[^a-z0-9]/g, '') === key)
  return /^(qwen2|qwen3|llama|mistral|mixtral|gemma|phi2|phi3|olmo|minicpm|internlm2)(?:\b|[._-])/i.test(family ?? '')
}
export function suggestedCheckpoint(model: string): string {
  if (model === 'qwen2.5:3b') return 'Qwen/Qwen2.5-3B-Instruct'
  if (model === 'qwen2.5-coder:3b') return 'Qwen/Qwen2.5-Coder-3B-Instruct'
  return ''
}
