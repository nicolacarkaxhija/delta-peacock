export interface ModelRequest {
  system: string;
  user: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ModelReply {
  text: string;
  usage?: ModelUsage;
}

/** The primary test seam: everything on our side of it runs real in tests. */
export interface ModelPort {
  complete(request: ModelRequest): Promise<ModelReply>;
}
