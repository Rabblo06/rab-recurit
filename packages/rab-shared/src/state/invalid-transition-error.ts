export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: string,
    public readonly to: string,
  ) {
    super(`Invalid transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}
