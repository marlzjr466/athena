export interface MLXActivationSource { checkpointPath: string; checkpointId: string; baseModel: string; baseDigest: string; adapterPath: string; adapterConfigPath: string; adapterName: string; jobId: string }
export interface MLXModelRegistration extends MLXActivationSource {
  id: string; label: string; provider: 'mlx'; digest: string; files: Record<string, string>; contextLength: number; family: string; size: number;
  previousModel: string | null; verifiedAt: string; baseResponse: string; adapterResponse: string; adapterTensorCount: number; logitDifference: number; toolsVerified: boolean; toolProbeResponse?: string
}
export interface MLXDiagnostic { id: string; label: string; baseCheckpoint: string; adapterCheckpoint: string; provider: 'mlx'; status: 'idle' | 'loading' | 'generating' | 'error'; memoryGB?: number; error?: string; verifiedAt: string; previousModel: string | null }
