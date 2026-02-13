import { ExecutionDecision, ExecutionResult, IExecutor } from './types';

type DryRunSubmit = (decision: ExecutionDecision) => Promise<ExecutionResult>;

export class DryRunExecutor implements IExecutor {
  constructor(private readonly submit: DryRunSubmit) {}

  async execute(decision: ExecutionDecision): Promise<ExecutionResult> {
    return this.submit(decision);
  }
}

