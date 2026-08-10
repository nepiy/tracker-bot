export class UserFacingError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

export class ExternalServiceError extends Error {
  constructor(
    message: string,
    public readonly service: string,
    public readonly retryable = true,
  ) {
    super(message);
    this.name = "ExternalServiceError";
  }
}
